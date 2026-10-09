'use strict';
/**
 * v2-identity-write 的每一句 SQL：傳進去的參數都要在 SQL 裡用到。
 * 真正的 Postgres（extended protocol）遇到沒用到的參數會報
 * 「could not determine data type of parameter $n」；整合測試用 psql 替身把參數代換成文字，抓不到這件事。
 */
const assert = require('node:assert/strict');
const path = require('node:path');
const Module = require('node:module');

const FN = path.join(__dirname, '..', 'netlify', 'functions');
const queries = [];
const fakeClient = {
  async query(sql, params = []) {
    queries.push({ sql, params });
    if (/^\s*update\b/i.test(sql)) return { rows: [] }; // 讓每個寫入都走到 insert
    return { rows: [{ id: 'x' }] };
  }
};
const stubs = {
  './_db': { withUser: (_u, fn) => fn(fakeClient), translateDbError: (e) => e },
  './_session': { requireSession: async () => ({ userId: 'USR-1' }), assertSessionActive: async () => {} }
};
const origLoad = Module._load;
Module._load = function (request, parent, ...rest) {
  if (parent && parent.filename && parent.filename.startsWith(FN) && stubs[request]) return stubs[request];
  return origLoad.call(this, request, parent, ...rest);
};
const { handler } = require(path.join(FN, 'v2-identity-write.js'));

let pass = 0;
const ok = async (name, fn) => { await fn(); pass++; console.log('  PASS', name); };

(async () => {
  const body = { changes: [
    { collection: 'organizations', id: 'ORG-1', record: { name: '合成機構', type: 'transport_provider' } },
    { collection: 'memberships', id: 'M-1', record: { userId: 'USR-2', organizationId: 'ORG-1', role: 'dispatcher', status: 'active' } },
    { collection: 'drivers', id: 'DRV-1', record: { userId: 'USR-3', organizationId: 'ORG-1', status: 'on_duty' } }
  ] };
  const res = await handler({ httpMethod: 'POST', headers: {}, body: JSON.stringify(body) });
  await ok('寫入流程跑完（三種資料都先 update 再 insert）', () => {
    assert.equal(res.statusCode, 200, res.body);
    assert.ok(queries.filter((q) => /^\s*update\b/i.test(q.sql)).length >= 3);
  });
  await ok('每一句 SQL 的參數都有用到（不會在正式資料庫報 could not determine data type）', () => {
    for (const { sql, params } of queries) {
      for (let i = 1; i <= params.length; i++) {
        assert.ok(new RegExp(`\\$${i}(?!\\d)`).test(sql), `參數 $${i} 沒有用到：${sql.replace(/\s+/g, ' ').trim()}`);
      }
    }
  });
  console.log(`identity-write-params: ${pass} passed`);
})().catch((e) => { console.error(e); process.exitCode = 1; });
