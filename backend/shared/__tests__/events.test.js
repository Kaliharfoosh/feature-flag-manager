const events = require('../events');
const req = () => ({ user: { id: 'admin-id', teamId: 'team-id' }, id: 'request-id', log: { warn: jest.fn() } });

test('AWS stays off when the event bus is unset', async () => {
  const send = jest.fn();
  await events.publish(req(), { action: 'key.created', targetId: 'id' }, { settings: {}, send });
  expect(send).not.toHaveBeenCalled();
});

test('publishes production changes and only safe key metadata', async () => {
  const send = jest.fn().mockResolvedValue({ Entries: [{ EventId: 'accepted-id' }], FailedEntryCount: 0 });
  const request = req();
  await events.publish(request, { action: 'key.created', targetId: 'key-id', env: 'prod', prefix: 'ffm_prd_Ab1234', key: 'full-secret-never-publish' }, { settings: { EVENT_BUS_NAME: 'ffm-events' }, send });
  const entry = send.mock.calls[0][0].input.Entries[0];
  expect(entry).toMatchObject({ Source: 'ffm.flags', DetailType: 'key.created', EventBusName: 'ffm-events' });
  expect(JSON.parse(entry.Detail)).toMatchObject({ env: 'prod', teamId: 'team-id', prefix: 'ffm_prd_Ab1234' });
  expect(entry.Detail).not.toContain('full-secret');
  expect(request.log.warn).not.toHaveBeenCalled();
});

test.each(['network','entry'])('%s failures are logged and cannot fail an already committed request', async failure => {
  const request = req();
  const send = failure === 'network' ? jest.fn().mockRejectedValue(new Error('down')) : jest.fn().mockResolvedValue({ FailedEntryCount: 1, Entries: [{ ErrorCode: 'Denied' }] });
  await expect(events.publish(request, { action: 'flag.toggled', env: 'prod', targetId: 'flag-id' }, { settings: { EVENT_BUS_NAME: 'ffm-events' }, send })).resolves.toBeUndefined();
  expect(request.log.warn).toHaveBeenCalledWith(expect.objectContaining({ action: 'event.failed' }), expect.any(String));
});
