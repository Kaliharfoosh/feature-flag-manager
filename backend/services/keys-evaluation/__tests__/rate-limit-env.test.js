// EVAL_RATE_LIMIT raises the per-key limit for local load tests (Lab 8) and must never work
// in production.
const { rateLimitFromEnv, RATE_LIMIT } = require('../evaluations');

test('the normal limit is 120 per minute', () => {
  expect(RATE_LIMIT).toBe(120);
  expect(rateLimitFromEnv({})).toBe(120);
});

test('a local load test can raise it', () => {
  expect(rateLimitFromEnv({ NODE_ENV: 'development', EVAL_RATE_LIMIT: '100000' })).toBe(100000);
});

test('it is ignored in production, so the real limit can never be switched off there', () => {
  expect(rateLimitFromEnv({ NODE_ENV: 'production', EVAL_RATE_LIMIT: '100000' })).toBe(120);
});

test.each(['abc', '0', '-5', '2.5', '99999999'])('a bad value %s falls back to 120', (value) => {
  expect(rateLimitFromEnv({ NODE_ENV: 'development', EVAL_RATE_LIMIT: value })).toBe(120);
});
