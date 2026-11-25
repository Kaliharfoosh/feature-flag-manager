// k6 load test for the Rollout Service (S2): how POST /evaluations and /evaluations/batch cope
// when many client apps ask at once (Lab 8, Parts 4 and 5, applied to our serverless design).
//
// Run it on YOUR PC against the local backend and a throwaway database (tests/load/README.md),
// never against production: a load test there would use up the free Vercel/Neon limits.
//
//   k6 run -e FFM_KEY=<staging key> -e PROFILE=normal tests/load/evaluations-load.js   (Run A)
//   k6 run -e FFM_KEY=<staging key> -e PROFILE=spike  tests/load/evaluations-load.js   (Run B)
//   k6 run -e FFM_KEY=<staging key> -e PROFILE=stress tests/load/evaluations-load.js   (find the ceiling)
//
// The backend must be started with EVAL_RATE_LIMIT raised (README): all k6 users share one key,
// so with the normal 120/min limit k6 would only measure the rate limiter.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

const BASE = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const KEY = __ENV.FFM_KEY;
const PROFILE = __ENV.PROFILE || 'normal';

// The demo store's flags, read from its own list so the two never drift apart.
const FLAG_KEYS = [...open('../../demo-client/lib/store-flags.js').matchAll(/key: '([a-z0-9-]+)'/g)].map((m) => m[1]);

const PROFILES = {
  // Run A: a normal busy period, 20 client apps asking all the time.
  normal: [
    { duration: '20s', target: 20 },
    { duration: '60s', target: 20 },
    { duration: '10s', target: 0 },
  ],
  // Run B: a sudden spike to 100 (a marketing email goes out and every shop opens at once).
  spike: [
    { duration: '20s', target: 20 },
    { duration: '10s', target: 100 },
    { duration: '40s', target: 100 },
    { duration: '10s', target: 20 },
    { duration: '10s', target: 0 },
  ],
  // Optional (Lab 8 "find the ceiling"): no pause between requests, up to 200 users, to see
  // where this one local server and its database pool start to slow down.
  stress: [
    { duration: '15s', target: 50 },
    { duration: '15s', target: 100 },
    { duration: '15s', target: 200 },
    { duration: '15s', target: 200 },
    { duration: '10s', target: 0 },
  ],
};

export const options = {
  stages: PROFILES[PROFILE] ?? PROFILES.normal,
  thresholds: {
    http_req_duration: ['p(95)<500'], // 95% of answers in under half a second
    'http_req_duration{endpoint:single}': ['p(95)<500'], // shown separately in the summary
    'http_req_duration{endpoint:batch}': ['p(95)<500'],
    http_req_failed: ['rate<0.05'],   // under 5% errors
    checks: ['rate>0.99'],
  },
  summaryTrendStats: ['avg', 'med', 'p(90)', 'p(95)', 'max'],
};

const rateLimited = new Counter('rate_limited_429');
const enabledShare = new Rate('single_flag_enabled');
const failedRequests = new Counter('failed_requests'); // anything other than 200 (e.g. 502 during failover)

// Lab 8: which copy of the API answered (header X-Instance-Id, set by the scale test's copies).
// k6 needs its metrics created up front, so one counter per possible copy.
const servedBy = {};
for (const id of ['ffm-task-vertical', 'ffm-task-1', 'ffm-task-2', 'ffm-task-3', 'ffm-task-4']) {
  servedBy[id] = new Counter(`served_by_${id.replace(/-/g, '_')}`);
}
function count(res) {
  const id = res.headers['X-Instance-Id'];
  if (id && servedBy[id]) servedBy[id].add(1);
  if (res.status === 429) rateLimited.add(1);
  if (res.status !== 200) failedRequests.add(1);
}

export function setup() {
  if (!KEY) throw new Error('Pass the staging key: k6 run -e FFM_KEY=ffm_stg_... tests/load/evaluations-load.js');
  if (FLAG_KEYS.length === 0) throw new Error('Could not read the store flag list.');
  const health = http.get(`${BASE}/api/v1/health`);
  if (health.status !== 200) throw new Error(`The backend at ${BASE} is not healthy (${health.status}).`);
}

const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` };

export default function () {
  const userId = `u-${Math.floor(Math.random() * 100000)}`;

  if (Math.random() < 0.7) {
    // 70%: one flag (a client app checking one feature)
    const flagKey = FLAG_KEYS[Math.floor(Math.random() * FLAG_KEYS.length)];
    const res = http.post(`${BASE}/api/v1/evaluations`, JSON.stringify({ flagKey, userId }), { headers, tags: { endpoint: 'single' } });
    count(res);
    const ok = check(res, {
      'single: 200': (r) => r.status === 200,
      'single: has enabled': (r) => typeof r.json('enabled') === 'boolean',
    });
    if (ok) enabledShare.add(res.json('enabled'));
  } else {
    // 30%: a whole page (the store asking for all its flags in one request)
    const res = http.post(`${BASE}/api/v1/evaluations/batch`, JSON.stringify({ userId, flagKeys: FLAG_KEYS }), { headers, tags: { endpoint: 'batch' } });
    count(res);
    check(res, {
      'batch: 200': (r) => r.status === 200,
      'batch: every flag answered': (r) => Object.keys(r.json('flags') || {}).length + (r.json('notFound') || []).length === FLAG_KEYS.length,
    });
  }

  if (PROFILE !== 'stress') sleep(0.5 + Math.random()); // a client app does not ask non-stop
}
