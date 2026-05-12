/**
 * Local dev server for manual testing.
 *
 * Serves the static site from the repo root and mounts each module under
 * `api/` at `/api/<name>` using the same module.exports(req, res) contract
 * Vercel's Node runtime uses. Useful when the Vercel CLI is not installed.
 *
 * Usage: node dev-server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}

function serveStatic(req, res) {
  const parsed = url.parse(req.url);
  let pathname = decodeURIComponent(parsed.pathname || '/');
  if (pathname === '/') pathname = '/index.html';
  const filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) {
    send(res, 403, 'Forbidden');
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      send(res, 404, 'Not Found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

async function readBody(req) {
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      if (!data) return resolve(undefined);
      const type = req.headers['content-type'] || '';
      if (type.includes('application/json')) {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      } else {
        resolve(data);
      }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res) {
  const parsed = url.parse(req.url);
  const name = parsed.pathname.replace(/^\/api\//, '').replace(/\/$/, '');
  const modulePath = path.join(ROOT, 'api', `${name}.js`);
  if (!fs.existsSync(modulePath)) {
    send(res, 404, JSON.stringify({ ok: false, error: `No API handler: ${name}` }), { 'Content-Type': 'application/json' });
    return;
  }
  delete require.cache[require.resolve(modulePath)];
  const handler = require(modulePath);
  try {
    req.body = await readBody(req);
  } catch (e) {
    send(res, 400, JSON.stringify({ ok: false, error: 'Invalid JSON body' }), { 'Content-Type': 'application/json' });
    return;
  }
  // Tiny shim for res.status().json(...) used by Vercel-style handlers.
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => {
    if (!res.getHeader('Content-Type')) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify(payload));
    return res;
  };
  try {
    await handler(req, res);
  } catch (err) {
    if (!res.headersSent) {
      send(res, 500, JSON.stringify({ ok: false, error: err.message }), { 'Content-Type': 'application/json' });
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/')) return handleApi(req, res);
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`Dev server running: http://localhost:${PORT}`);
});
