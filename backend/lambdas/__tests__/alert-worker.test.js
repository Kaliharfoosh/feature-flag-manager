const { loadSecrets } = require('../alert-worker');

const secrets = {
  'ffm/worker-db': { DATABASE_URL: 'postgres://ffm_app:x@db/ffm', SESSION_SECRET: 'not-for-the-worker' },
  'ffm/github-token': { GITHUB_TOKEN: 'github_pat_test', GITHUB_REPO: 'owner/repo' },
};
const fakeClient = () => ({
  send: jest.fn(async (command) => ({ SecretString: JSON.stringify(secrets[command.input.SecretId]) })),
});

test('reads its two secrets and copies only the names it expects', async () => {
  const env = { SECRET_ID: 'ffm/worker-db', GITHUB_SECRET_ID: 'ffm/github-token' };
  const client = fakeClient();
  await loadSecrets(env, client);
  expect(client.send.mock.calls.map(([c]) => c.input.SecretId)).toEqual(['ffm/worker-db', 'ffm/github-token']);
  expect(env).toMatchObject({ DATABASE_URL: secrets['ffm/worker-db'].DATABASE_URL, GITHUB_TOKEN: 'github_pat_test', GITHUB_REPO: 'owner/repo' });
  expect(env.SESSION_SECRET).toBeUndefined();
});

test('a missing field stays unset instead of becoming the text "undefined"', async () => {
  secrets['ffm/github-token'] = { GITHUB_REPO: 'owner/repo' };
  const env = { GITHUB_SECRET_ID: 'ffm/github-token' };
  await loadSecrets(env, fakeClient());
  expect(env.GITHUB_TOKEN).toBeUndefined();
  expect(env.GITHUB_REPO).toBe('owner/repo');
});

test('no secret settings (local run): reads nothing', async () => {
  const client = fakeClient();
  await loadSecrets({}, client);
  expect(client.send).not.toHaveBeenCalled();
});
