'use strict';
/**
 * 隔離測試用的最小 Netlify 替身。
 *
 *   - GET /、/index.html 與根目錄的靜態檔 → 直接回檔案
 *   - netlify.toml 的 [[redirects]]（/api/... → /.netlify/functions/NAME）
 *     → 在同一個 Node 行程裡呼叫 netlify/functions/NAME.js 的 handler
 *
 * 只給瀏覽器端對端測試與人工驗收使用。不是 netlify dev 的替代品：沒有 edge
 * function、沒有 header 規則、沒有建置步驟。
 *
 * 啟動（資料庫必須是本機隔離庫，這支會拒絕其他主機）：
 *
 *   DATABASE_URL=postgresql://care_ride_app@127.0.0.1:5432/careride_e2e_test?sslmode=disable \
 *   AUTH_SESSION_SECRET=... AUTH_PASSWORD_PEPPER=... GOOGLE_CLIENT_ID=local.apps.googleusercontent.com \
 *   PORT=8888 node tools/local-dev-server.js
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};
// 這些目錄是伺服器端程式、測試與版本庫內部資料，正式站也不該被當成靜態檔下載
const PRIVATE_PREFIXES = ['netlify', 'supabase', 'tests', 'tools', 'apps-script', 'node_modules', '.git', '.github'];

function parseRedirects(tomlText) {
  const routes = new Map();
  const re = /\[\[redirects\]\]\s*from\s*=\s*"([^"]+)"\s*to\s*=\s*"\/\.netlify\/functions\/([a-z0-9-]+)"/g;
  let m;
  while ((m = re.exec(tomlText))) routes.set(m[1], m[2]);
  return routes;
}

function assertIsolatedDatabase(env = process.env) {
  const raw = String(env.DATABASE_URL || '');
  let host = '';
  try { host = new URL(raw).hostname; } catch (_) { host = ''; }
  if (!['127.0.0.1', 'localhost'].includes(host)) {
    throw new Error('local-dev-server 只接受本機隔離資料庫（DATABASE_URL 主機必須是 127.0.0.1 或 localhost）');
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? Buffer.concat(chunks).toString('utf8') : undefined;
}

function createServer({ log = () => {} } = {}) {
  const routes = parseRedirects(fs.readFileSync(path.join(ROOT, 'netlify.toml'), 'utf8'));
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const fnName = routes.get(url.pathname)
      || (url.pathname.startsWith('/.netlify/functions/') ? url.pathname.slice('/.netlify/functions/'.length) : null);

    if (fnName !== null) {
      if (!/^[a-z0-9-]+$/.test(fnName) || !fs.existsSync(path.join(ROOT, 'netlify', 'functions', `${fnName}.js`))) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'NOT_FOUND', message: 'function not found' } }));
        return;
      }
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(', ') : v;
      const event = {
        httpMethod: req.method, path: url.pathname, headers,
        queryStringParameters: Object.fromEntries(url.searchParams),
        body: await readBody(req), isBase64Encoded: false
      };
      try {
        const { handler } = require(path.join(ROOT, 'netlify', 'functions', `${fnName}.js`));
        const out = await handler(event, {});
        res.writeHead(out.statusCode || 200, { 'content-type': 'application/json; charset=utf-8', ...(out.headers || {}) });
        res.end(out.body || '');
        log(`${req.method} ${url.pathname} → ${fnName} ${out.statusCode}`);
      } catch (error) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'DEV_SERVER_ERROR', message: String(error && error.message) } }));
        log(`${req.method} ${url.pathname} → ${fnName} 500 ${error && error.message}`);
      }
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname).replace(/^\/+/, '');
    const file = path.resolve(ROOT, rel);
    const first = rel.split('/')[0];
    if (!file.startsWith(ROOT + path.sep) || PRIVATE_PREFIXES.includes(first) || first.startsWith('.')
        || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': 'no-store' });
    if (req.method === 'HEAD') { res.end(); return; }
    fs.createReadStream(file).pipe(res);
  });
}

if (require.main === module) {
  assertIsolatedDatabase();
  const port = Number(process.env.PORT || 8888);
  createServer({ log: (line) => console.log(line) }).listen(port, '127.0.0.1', () => {
    console.log(`local-dev-server 已啟動：http://127.0.0.1:${port}/`);
  });
}

module.exports = { createServer, parseRedirects, assertIsolatedDatabase };
