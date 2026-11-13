const github = require('../github');

const TOKEN = 'github_pat_test_SECRET_VALUE_123';
const env = { GITHUB_TOKEN: TOKEN, GITHUB_REPO: 'Kaliharfoosh/feature-flag-manager' };

const answer = (status, body) => jest.fn(async () => ({ status, json: async () => body }));
const created = () => answer(201, { number: 17, html_url: 'https://github.com/Kaliharfoosh/feature-flag-manager/issues/17' });

const alertRow = { id: 'al1', rule: 'prod_change', title: 'Prod change: flag.toggled on flag f1 by admin@acme.test', audit_event_id: '1042' };
const eventRow = {
  id: '1042', at: new Date('2026-11-13T14:05:00Z'), actor_label: 'admin@acme.test', action: 'flag.toggled',
  target_type: 'flag', target_id: 'f1', details: { env: 'prod', before: { enabled: false }, after: { enabled: true } }, request_id: 'r1',
};

describe('createIssue', () => {
  test('POSTs to the repo issues API with the token in the header only', async () => {
    const fetchImpl = created();
    await expect(github.createIssue({ title: 't', body: 'b' }, { fetchImpl, env }))
      .resolves.toEqual({ number: 17, url: 'https://github.com/Kaliharfoosh/feature-flag-manager/issues/17' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.github.com/repos/Kaliharfoosh/feature-flag-manager/issues');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe(`Bearer ${TOKEN}`);
    expect(init.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
    expect(JSON.parse(init.body)).toEqual({ title: 't', body: 'b' });
    expect(init.body).not.toContain(TOKEN);
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  test.each([
    ['no token', { GITHUB_REPO: env.GITHUB_REPO }, /not configured/],
    ['no repo', { GITHUB_TOKEN: TOKEN }, /not configured/],
    ['a bad repo name', { ...env, GITHUB_REPO: 'evil.com/../x' }, /owner\/repo/],
  ])('502 and no request with %s', async (_, badEnv, message) => {
    const fetchImpl = created();
    await expect(github.createIssue({ title: 't', body: 'b' }, { fetchImpl, env: badEnv }))
      .rejects.toMatchObject({ status: 502, code: 'UPSTREAM_FAILED', message: expect.stringMatching(message) });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('a wrong token gives 502 with GitHub\'s reason, never the token (AUD-22)', async () => {
    const err = await github.createIssue({ title: 't', body: 'b' }, { fetchImpl: answer(401, { message: 'Bad credentials' }), env })
      .catch((e) => e);
    expect(err).toMatchObject({ status: 502, code: 'UPSTREAM_FAILED', message: 'GitHub answered 401: Bad credentials' });
    expect(err.message).not.toContain(TOKEN);
  });

  test('a timeout gives 502', async () => {
    const fetchImpl = jest.fn(async () => { throw Object.assign(new Error('timed out'), { name: 'TimeoutError' }); });
    await expect(github.createIssue({ title: 't', body: 'b' }, { fetchImpl, env }))
      .rejects.toMatchObject({ code: 'UPSTREAM_FAILED', message: 'GitHub did not answer within 3 s.' });
  });

  test('GitHub unreachable gives 502', async () => {
    const fetchImpl = jest.fn(async () => { throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }); });
    await expect(github.createIssue({ title: 't', body: 'b' }, { fetchImpl, env }))
      .rejects.toMatchObject({ code: 'UPSTREAM_FAILED', message: 'GitHub could not be reached (ENOTFOUND).' });
  });

  test('a non-JSON answer gives 502', async () => {
    const fetchImpl = jest.fn(async () => ({ status: 503, json: async () => { throw new SyntaxError('x'); } }));
    await expect(github.createIssue({ title: 't', body: 'b' }, { fetchImpl, env }))
      .rejects.toMatchObject({ message: 'GitHub answered 503' });
  });
});

describe('issue text', () => {
  test('the body lists the event and the redacted details', () => {
    const body = github.issueBody(alertRow, eventRow);
    expect(body).toContain('**Rule:** `prod_change`');
    expect(body).toContain('**Action:** `flag.toggled`');
    expect(body).toContain('**When:** `2026-11-13T14:05:00.000Z`');
    expect(body).toContain('"env": "prod"');
  });

  test('user-controlled text cannot @mention people or break out of the formatting', () => {
    const body = github.issueBody(alertRow, {
      ...eventRow, target_id: 'x` @everyone\n# heading',
      details: { after: { name: '```\n@octocat look' } },
    });
    expect(body).not.toMatch(/(^|[^A-Za-z0-9_])@(everyone|octocat)/);
    expect(body).not.toContain('x` ');
    expect(body.match(/```/g)).toHaveLength(2); // only the fence we opened and closed
    expect(github.issueTitle({ title: 'Hi @team\nnext line' })).toBe('Hi @​team next line');
  });

  test('an email address is left alone', () => {
    expect(github.issueTitle({ title: 'by admin@acme.test' })).toBe('by admin@acme.test');
  });
});

// Fake client for deliver(): records SQL, answers the claim and the event lookup.
function fakeDb({ claim = alertRow } = {}) {
  const db = { calls: [] };
  db.query = jest.fn(async (sql, params) => {
    db.calls.push({ sql, params });
    if (sql.includes("SET status = 'sending'")) return { rows: claim ? [claim] : [] };
    if (sql.includes('FROM audit_events')) return { rows: [eventRow] };
    if (sql.includes("SET status = 'sent'")) return { rows: [{ ...alertRow, status: 'sent', github_issue_number: params[1] }] };
    return { rows: [] };
  });
  return db;
}

describe('deliver', () => {
  test('claims the alert, opens the issue and stores its number (AUD-21)', async () => {
    const db = fakeDb();
    const sent = await github.deliver('al1', { db, fetchImpl: created(), env });
    expect(sent).toMatchObject({ status: 'sent', github_issue_number: 17 });
    expect(db.calls.map((c) => c.sql.match(/SET status = '(\w+)'/)?.[1]).filter(Boolean)).toEqual(['sending', 'sent']);
  });

  test('nothing to claim (already sent, in flight, or rolled back) sends nothing', async () => {
    const fetchImpl = created();
    await expect(github.deliver('al1', { db: fakeDb({ claim: null }), fetchImpl, env })).resolves.toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test('GitHub down marks the alert failed with lastError and throws 502 (AUD-22)', async () => {
    const db = fakeDb();
    await expect(github.deliver('al1', { db, fetchImpl: answer(500, { message: 'Server Error' }), env }))
      .rejects.toMatchObject({ status: 502 });
    const failed = db.calls.find((c) => c.sql.includes("SET status = 'failed'"));
    expect(failed.params).toEqual(['al1', 'GitHub answered 500: Server Error']);
  });

  test('a database error after the issue exists does not mark it failed', async () => {
    const db = fakeDb();
    const query = db.query.getMockImplementation();
    db.query.mockImplementation(async (sql, params) => {
      if (sql.includes("SET status = 'sent'")) throw new Error('db down');
      return query(sql, params);
    });
    await expect(github.deliver('al1', { db, fetchImpl: created(), env })).rejects.toThrow('db down');
    expect(db.calls.some((c) => c.sql.includes("SET status = 'failed'"))).toBe(false);
  });
});

describe('deliverPending', () => {
  test('sends every pending alert, empties the list and never throws', async () => {
    const db = fakeDb();
    const log = { warn: jest.fn() };
    const req = { pendingAlerts: ['a1', 'a2'], log };
    await expect(github.deliverPending(req, { db, fetchImpl: answer(401, { message: 'Bad credentials' }), env })).resolves.toBeUndefined();
    expect(req.pendingAlerts).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(2);
  });

  test('no pending alerts does nothing', async () => {
    const db = fakeDb();
    await github.deliverPending({}, { db });
    await github.deliverPending(undefined, { db });
    expect(db.query).not.toHaveBeenCalled();
  });
});
