const metrics = require('../metrics');

const env = { METRICS_NAMESPACE: 'FFM' };

test.each([
  ['login.failed', 'FailedLogins'],
  ['access.denied', 'Forbidden'],
  ['bot_check.failed', 'BotCheckFailures'],
  ['server.error', 'ServerErrors'],
])('%s adds 1 to FFM/%s', async (action, name) => {
  const send = jest.fn().mockResolvedValue({});
  await expect(metrics.count(action, { env, send })).resolves.toBe(name);
  expect(send.mock.calls[0][0].input).toEqual({
    Namespace: 'FFM',
    MetricData: [{ MetricName: name, Value: 1, Unit: 'Count' }],
  });
});

test('off unless METRICS_NAMESPACE is set (Vercel)', async () => {
  const send = jest.fn();
  await expect(metrics.count('login.failed', { env: {}, send })).resolves.toBeNull();
  expect(send).not.toHaveBeenCalled();
});

test('actions without a metric are ignored (rate_limit.hit belongs to S2)', async () => {
  const send = jest.fn();
  await expect(metrics.count('rate_limit.hit', { env, send })).resolves.toBeNull();
  await expect(metrics.count('flag.created', { env, send })).resolves.toBeNull();
  expect(send).not.toHaveBeenCalled();
});

test('a CloudWatch error is logged, never thrown', async () => {
  const send = jest.fn().mockRejectedValue(new Error('timeout'));
  const log = { warn: jest.fn() };
  await expect(metrics.count('access.denied', { env, send, log })).resolves.toBe('Forbidden');
  expect(log.warn).toHaveBeenCalledWith({ metric: 'Forbidden', reason: 'timeout' }, 'metrics: not sent');
});
