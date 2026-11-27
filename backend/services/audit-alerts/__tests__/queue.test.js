const queue = require('../queue');

const URL = 'http://floci:4566/000000000000/ffm-alerts-queue';

test('off unless ALERTS_QUEUE_URL is set (Vercel keeps inline delivery)', () => {
  expect(queue.enabled({})).toBe(false);
  expect(queue.enabled({ ALERTS_QUEUE_URL: '' })).toBe(false);
  expect(queue.enabled({ ALERTS_QUEUE_URL: URL })).toBe(true);
});

test('sends only the alert id to the configured queue', async () => {
  const send = jest.fn().mockResolvedValue({ MessageId: 'm1' });
  await queue.enqueue('3f1c2b9e-0000-4000-8000-000000000001', { env: { ALERTS_QUEUE_URL: URL }, send });
  const [command] = send.mock.calls[0];
  expect(command.input).toEqual({
    QueueUrl: URL,
    MessageBody: JSON.stringify({ alertId: '3f1c2b9e-0000-4000-8000-000000000001' }),
  });
});

test('an SQS error reaches the caller (deliverPending then sends inline)', async () => {
  const send = jest.fn().mockRejectedValue(new Error('QueueDoesNotExist'));
  await expect(queue.enqueue('a1', { env: { ALERTS_QUEUE_URL: URL }, send })).rejects.toThrow('QueueDoesNotExist');
});
