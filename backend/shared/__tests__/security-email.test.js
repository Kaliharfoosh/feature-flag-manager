const { notify } = require('../security-email');
const req = () => ({ user: { teamId: 'team', email: 'actor@example.test' }, id: 'request', log: { warn: jest.fn() } });
test.each(['key.created', 'key.revoked'])('%s emails only team Admins and excludes raw secrets', async action => {
  const query = jest.fn().mockResolvedValue({ rows: [{ email: 'admin@example.test' }] });
  const send = jest.fn().mockResolvedValue({ MessageId: 'id' });
  await notify(req(), { action, env: 'prod', prefix: 'safe-prefix', key: 'raw-secret' }, { settings: { SES_FROM_ADDRESS: 'security@ffm.local' }, query, send });
  expect(query).toHaveBeenCalledWith(expect.any(String), ['team', 'admin']);
  const input = send.mock.calls[0][0].input;
  expect(input.Destination.ToAddresses).toEqual(['admin@example.test']);
  expect(JSON.stringify(input)).toContain('safe-prefix');
  expect(JSON.stringify(input)).not.toContain('raw-secret');
});
test.each([{}, { SES_FROM_ADDRESS: 'security@ffm.local' }])('disabled or non-production notifications do no work', async settings => {
  const query = jest.fn(), send = jest.fn();
  await notify(req(), { action: 'key.created', env: settings.SES_FROM_ADDRESS ? 'dev' : 'prod' }, { settings, query, send });
  expect(query).not.toHaveBeenCalled();
  expect(send).not.toHaveBeenCalled();
});
test('email failure cannot fail a committed key change', async () => {
  const request = req();
  await expect(notify(request, { action: 'key.revoked', env: 'prod' }, {
    settings: { SES_FROM_ADDRESS: 'security@ffm.local' }, query: async () => { throw Error('offline'); },
  })).resolves.toBeUndefined();
  expect(request.log.warn).toHaveBeenCalled();
});
