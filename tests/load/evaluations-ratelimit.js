// Run C: the per-key rate limit under load (Lab 8 Part 6, test S2, applied to our API keys).
// One key fires 150 requests as fast as it can. Expected: about 120 answer 200, the rest 429
// with a Retry-After header, and ONE rate_limit.hit row in the audit log (the monitoring page
// counts it).
//
// Start the backend WITHOUT EVAL_RATE_LIMIT for this run (the normal 120 per minute), then:
//   k6 run -e FFM_KEY=<staging key> tests/load/evaluations-ratelimit.js
import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = (__ENV.BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const KEY = __ENV.FFM_KEY;
const TOTAL = Number(__ENV.TOTAL || 150);

// 429 is the answer we are testing for, so it does not count as a failed request here.
http.setResponseCallback(http.expectedStatuses(200, 429));

export const options = {
  scenarios: {
    burst: { executor: 'shared-iterations', vus: 10, iterations: TOTAL, maxDuration: '50s' },
  },
  thresholds: {
    status_200: ['count<=120'],  // never more than the limit gets through
    status_429: ['count>=1'],    // the limiter really fires
    http_req_failed: ['rate==0'], // nothing other than 200 or 429
  },
};

const ok200 = new Counter('status_200');
// Lab 8: with 3 copies behind the load balancer, which copy answered (header X-Instance-Id).
const servedBy = {};
for (const id of ['ffm-task-vertical', 'ffm-task-1', 'ffm-task-2', 'ffm-task-3', 'ffm-task-4']) {
  servedBy[id] = new Counter(`served_by_${id.replace(/-/g, '_')}`);
}
const limited429 = new Counter('status_429');

export function setup() {
  if (!KEY) throw new Error('Pass the staging key: k6 run -e FFM_KEY=ffm_stg_... tests/load/evaluations-ratelimit.js');
}

export default function () {
  const res = http.post(
    `${BASE}/api/v1/evaluations`,
    JSON.stringify({ flagKey: 'new-checkout', userId: `u-${__ITER}` }),
    { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` } },
  );
  const id = res.headers['X-Instance-Id'];
  if (id && servedBy[id]) servedBy[id].add(1);
  if (res.status === 200) ok200.add(1);
  if (res.status === 429) {
    limited429.add(1);
    check(res, {
      '429 has Retry-After (1-60 s)': (r) => Number(r.headers['Retry-After']) >= 1 && Number(r.headers['Retry-After']) <= 60,
      '429 code is RATE_LIMITED': (r) => r.json('error.code') === 'RATE_LIMITED',
    });
  }
}
