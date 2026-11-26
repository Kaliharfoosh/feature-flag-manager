// buildApp({ services }): each AWS Lambda gets only its own routes. A path that belongs to another
// service must answer 404 ROUTE_NOT_FOUND (API Gateway should never send it there), while the
// shared parts (health, 404, error shape) work in every copy. No database: the pool is mocked.
const request = require('supertest');

jest.mock('connect-pg-simple', () => (session) => session.MemoryStore);
jest.mock('../db/pool', () => ({ pool: { connect: jest.fn(), query: jest.fn() } }));

process.env.SESSION_SECRET = 'session-secret-for-build-app-tests';
process.env.LOG_LEVEL = 'silent';

const { buildApp, ALL_SERVICES } = require('../build-app');
const { pool } = require('../db/pool');

// One route from each service. Unauthenticated, so an existing route answers 401 (or 400/415
// for the API-key endpoint) and a missing one answers 404 ROUTE_NOT_FOUND.
const probes = {
  flags: [['get', '/api/v1/flags'], ['get', '/api/v1/auth/me']],
  eval: [['get', '/api/v1/rollouts/3d6e0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b'], ['post', '/api/v1/evaluations']],
  audit: [['get', '/api/v1/audit'], ['get', '/api/v1/alerts']],
};

async function call(app, [method, path]) {
  const req = request(app)[method](path);
  return method === 'post' ? req.send({}) : req;
}

describe.each(ALL_SERVICES)('buildApp({ services: [%s] })', (own) => {
  const app = buildApp({ services: [own] });

  test.each(probes[own])('mounts its own route %s %s', async (method, path) => {
    const res = await call(app, [method, path]);
    expect(res.status).not.toBe(404);
  });

  const others = ALL_SERVICES.filter((s) => s !== own).flatMap((s) => probes[s]);
  test.each(others)('does not mount %s %s (404 ROUTE_NOT_FOUND)', async (method, path) => {
    const res = await call(app, [method, path]);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('ROUTE_NOT_FOUND');
  });

  test('health works and names this copy', async () => {
    pool.query.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'ok', db: 'ok', services: [own] });
    expect(res.headers['x-served-by']).toBe(own);
  });
});

test('no services list means all three (what Vercel and backend/app.js use)', async () => {
  const app = buildApp();
  for (const probe of Object.values(probes).flat()) {
    const res = await call(app, probe);
    expect(res.status).not.toBe(404);
  }
});

test('the evaluation endpoint still sits before the session: no cookie is ever set', async () => {
  const res = await request(buildApp({ services: ['eval'] })).post('/api/v1/evaluations').send({});
  expect(res.headers['set-cookie']).toBeUndefined();
});

test('an unknown or empty service list is refused at start-up, not at the first request', () => {
  expect(() => buildApp({ services: ['flag'] })).toThrow(/unknown or empty services/);
  expect(() => buildApp({ services: [] })).toThrow(/unknown or empty services/);
});

test('each Lambda file exports a handler', () => {
  for (const name of ['flags', 'eval', 'audit']) {
    expect(typeof require(`../lambdas/${name}`).handler).toBe('function');
  }
  expect(typeof require('../lambda').handler).toBe('function');
});
