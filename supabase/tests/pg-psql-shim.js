'use strict';

/**
 * 測試專用的 `pg` 替身，用 psql 子行程當傳輸層。
 *
 * 為什麼要這個：這個環境裝不了 npm 的 pg 套件（registry 被安全政策擋住），
 * 但我不想因此就不驗證。這個替身讓 netlify/functions 底下的程式碼原封不動
 * 跑在「真的 Postgres、真的 care_ride_app 角色、真的 RLS」上面——只有驅動
 * 程式本身沒被驗證到，SQL、授權與交易語意都是真的。
 *
 * 每個 client 持有一個常駐的 psql 行程，所以 BEGIN / set_config(...,true) /
 * COMMIT 的交易語意是真實的。
 *
 * 正式環境不會用到這個檔案。
 */

const { spawn } = require('child_process');

const SENTINEL = '__Q_DONE__';

function quoteLiteral(v) {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  // 與 node-pg 相同：JS 陣列轉成 Postgres 陣列字面值 {"a","b"}
  if (Array.isArray(v)) {
    const items = v.map((x) => (x === null || x === undefined ? 'NULL'
      : `"${String(x).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`));
    return quoteLiteral(`{${items.join(',')}}`);
  }
  return `'${String(v).replace(/'/g, "''")}'`;
}

function inlineParams(sql, params) {
  if (!params || !params.length) return sql;
  // 由大到小取代，避免 $1 誤中 $10
  let out = sql;
  for (let i = params.length; i >= 1; i--) {
    out = out.split(`$${i}`).join(quoteLiteral(params[i - 1]));
  }
  return out;
}

class PsqlClient {
  constructor(opts) {
    this.proc = spawn('psql', [
      '-h', opts.host, '-p', String(opts.port), '-U', opts.user, '-d', opts.database,
      '-q', '-A', '-t', '--no-psqlrc', '-v', 'ON_ERROR_STOP=0',
      // VERBOSITY=verbose 讓 psql 把 SQLSTATE 印出來。沒有它的話，
      // raise ... using errcode = '23505' 這種自訂錯誤在替身這邊會退化成
      // 「用訊息猜代碼」，測出來的錯誤碼跟正式環境的 pg 驅動不一致——
      // 之前就因此誤判過一次「重複註冊沒有回 ACCOUNT_EXISTS」。
      '-v', 'VERBOSITY=verbose'
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.buffer = '';
    this.errBuffer = '';
    this.pending = null;
    this.proc.stdout.on('data', (d) => { this.buffer += d.toString(); this._drain(); });
    this.proc.stderr.on('data', (d) => { this.errBuffer += d.toString(); });
    this.ready = this._send(`set role ${opts.role};`);
  }

  _drain() {
    if (!this.pending) return;
    const idx = this.buffer.indexOf(SENTINEL);
    if (idx < 0) return;
    const raw = this.buffer.slice(0, idx);
    this.buffer = this.buffer.slice(idx + SENTINEL.length).replace(/^\n/, '');
    const err = this.errBuffer; this.errBuffer = '';
    const { resolve, reject } = this.pending; this.pending = null;
    if (/^ERROR:/m.test(err)) {
      const message = (err.match(/^ERROR:\s*(?:[0-9A-Z]{5}:\s*)?(.*)$/m) || [, err])[1].trim();
      // verbose 模式的格式是 "ERROR:  23505: 訊息"，另外也留著舊的 SQLSTATE: 形式
      const code = (err.match(/^ERROR:\s*([0-9A-Z]{5}):/m) || [])[1]
        || (err.match(/SQLSTATE:\s*(\w+)/m) || [])[1];
      return reject(Object.assign(new Error(message), { code: code || this._codeFromMessage(err) }));
    }
    resolve(raw.trim());
  }

  _codeFromMessage(err) {
    if (/permission denied|violates row-level security/i.test(err)) return '42501';
    if (/已被其他服務單位接走|不是可承接的狀態/.test(err)) return '55006';
    if (/duplicate key/i.test(err)) return '23505';
    if (/找不到這筆預約/.test(err)) return 'P0002';
    return undefined;
  }

  _send(sql) {
    return new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      this.proc.stdin.write(`${sql}\n\\echo ${SENTINEL}\n`);
    });
  }

  async query(sql, params) {
    await this.ready;
    const text = inlineParams(String(sql).trim().replace(/;\s*$/, ''), params);
    const isRead = /^\s*(select|with)\b/i.test(text);
    // INSERT / UPDATE / DELETE ... RETURNING 不能塞進 FROM 的子查詢裡（Postgres 不允許
    // 資料異動語句出現在那個位置），必須用 CTE 包起來。之前一律用子查詢，所以
    // 任何帶 RETURNING 的寫入在測試裡都會變成 syntax error，看起來像是 SQL 寫錯。
    const isWriteReturning = /^\s*(insert|update|delete)\b/i.test(text) && /\breturning\b/i.test(text);
    if (!isRead && !isWriteReturning) {
      await this._send(`${text};`);
      return { rows: [], rowCount: 0 };
    }
    const out = await this._send(isWriteReturning
      ? `with __w as (${text}) select coalesce(json_agg(__t), '[]'::json)::text from __w __t;`
      : `select coalesce(json_agg(__t), '[]'::json)::text from (${text}) __t;`);
    let rows = [];
    try { rows = JSON.parse(out || '[]'); } catch (_) { rows = []; }
    return { rows, rowCount: rows.length };
  }

  release() { /* 常駐行程，由 Pool.end() 收掉 */ }

  close() { try { this.proc.stdin.end(); this.proc.kill(); } catch (_) {} }
}

class Pool {
  constructor(config = {}) {
    const url = new URL(config.connectionString || process.env.DATABASE_URL);
    this.opts = {
      host: decodeURIComponent(url.hostname || '/tmp/pgrun'),
      port: Number(url.port || 5433),
      user: 'postgres',                       // psql 用 trust 連線
      role: decodeURIComponent(url.username), // 再 SET ROLE 成應用角色
      database: (url.pathname || '/careride').slice(1)
    };
    this.clients = [];
  }
  async connect() {
    const c = new PsqlClient(this.opts);
    this.clients.push(c);
    return c;
  }
  on() { /* 測試不需要事件 */ }
  async end() { this.clients.forEach((c) => c.close()); this.clients = []; }
}

module.exports = { Pool };
