// Runs the demo shop on your PC: http://localhost:4000
// Usage (from demo-client/):  npm start      (reads demo-client/.env, see .env.example)
// On Vercel this file is not used: public/ is served as static files and api/flags.js is a function.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { handle } = require('./lib/flag-client');

const PORT = Number(process.env.PORT) || 4000;
const PUBLIC_DIR = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
// Same security headers as vercel.json, so local and deployed behave alike.
const HEADERS = {
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/flags') {
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); return res.end(); }
    const { status, body } = await handle(Object.fromEntries(url.searchParams), process.env);
    res.writeHead(status, { ...HEADERS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(body));
  }

  // Static files from public/ only; anything that tries to climb out ("..") is a 404.
  const file = path.normalize(path.join(PUBLIC_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not found');
  }
  res.writeHead(200, { ...HEADERS, 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream' });
  return fs.createReadStream(file).pipe(res);
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Demo shop on http://localhost:${PORT} (flag service: ${process.env.FFM_API_URL || 'NOT SET'})`));
}

module.exports = { server };
