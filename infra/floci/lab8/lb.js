// The local stand-in for the ALB ffm-alb (same job as Lab 8's --lb-proxy): one address (:8080)
// in front of several copies of the API. It sends each request to the next HEALTHY copy in turn
// (round robin) and asks every copy GET /api/v1/health every 3 seconds. A copy that fails is
// skipped until it answers again.
//
// Started by scale-test.js:  TARGETS=http://localhost:3001,http://localhost:3002 node lb.js
const http = require('node:http');

const PORT = Number(process.env.PORT) || 8080;
const targets = (process.env.TARGETS || 'http://localhost:3001,http://localhost:3002,http://localhost:3003')
  .split(',').map((t) => new URL(t.trim()));
const healthy = new Map(targets.map((t) => [t.href, true]));
let next = 0;

function pick() {
  const pool = targets.filter((t) => healthy.get(t.href));
  if (pool.length === 0) return null;
  const chosen = pool[next % pool.length];
  next += 1;
  return chosen;
}

function mark(target, ok, why) {
  if (healthy.get(target.href) !== ok) {
    console.log(`[lb] ${new Date().toISOString()} ${target.href} is now ${ok ? 'HEALTHY' : 'UNHEALTHY'}${why ? ` (${why})` : ''}`);
  }
  healthy.set(target.href, ok);
}

// Health check: every 3 s, every target, 2 s timeout.
function probe() {
  for (const target of targets) {
    const req = http.get({ hostname: target.hostname, port: target.port, path: '/api/v1/health', timeout: 2000 }, (res) => {
      mark(target, res.statusCode === 200, `health ${res.statusCode}`);
      res.resume();
    });
    req.on('error', (err) => mark(target, false, `health: ${err.code || err.message}`));
    req.on('timeout', () => { mark(target, false, 'health: timeout'); req.destroy(); });
  }
}
probe();
setInterval(probe, 3000).unref();

const server = http.createServer((req, res) => {
  const target = pick();
  if (!target) {
    res.writeHead(503, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'NO_HEALTHY_TARGET', message: 'No healthy copy of the API.' } }));
    return;
  }
  const upstream = http.request({
    hostname: target.hostname,
    port: target.port,
    path: req.url,
    method: req.method,
    headers: { ...req.headers, host: `${target.hostname}:${target.port}`, 'x-forwarded-for': req.socket.remoteAddress },
  }, (upRes) => {
    upRes.headers['x-served-by-lb'] = 'ffm-alb-local';
    res.writeHead(upRes.statusCode, upRes.headers);
    upRes.pipe(res);
  });
  upstream.on('error', (err) => {
    // The copy died while we were talking to it: skip it from now on, and this one request fails.
    mark(target, false, `request: ${err.code || err.message}`);
    console.warn(`[lb] ${new Date().toISOString()} upstream ${target.href} failed: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'UPSTREAM_FAILED', message: 'That copy of the API stopped answering.' } }));
    }
  });
  req.pipe(upstream);
});

server.keepAliveTimeout = 65000;
server.listen(PORT, () => console.log(`[lb] ffm-alb-local on :${PORT}, targets ${targets.map((t) => t.href).join(', ')}`));
