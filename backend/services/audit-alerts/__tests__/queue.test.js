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

describe('scanDeadLetters', () => {
  const env = { ALERTS_QUEUE_URL: URL, ALERTS_DLQ_URL: 'http://floci:4566/000000000000/ffm-alerts-dlq' };
  const MINE = '3f1c2b9e-0000-4000-8000-000000000001';
  const OTHER = '3f1c2b9e-0000-4000-8000-000000000002';
  const msg = (body, handle) => ({ Body: body, ReceiptHandle: handle });

  // A fake SQS: answers ReceiveMessage from a list of batches, records everything else.
  function fakeSqs(batches) {
    const calls = [];
    const send = jest.fn(async (command) => {
      const name = command.constructor.name;
      calls.push({ name, input: command.input });
      if (name === 'ReceiveMessageCommand') return { Messages: batches.shift() || [] };
      return {};
    });
    return { send, calls, of: (name) => calls.filter((c) => c.name === name) };
  }
  const ownedBy = jest.fn(async (ids) => new Set(ids.filter((id) => id === MINE)));

  test("count mode: counts only the team's alerts and releases every message again", async () => {
    const sqsFake = fakeSqs([[msg(JSON.stringify({ alertId: MINE }), 'h1'), msg(JSON.stringify({ alertId: OTHER }), 'h2'), msg('not json', 'h3')]]);
    const result = await queue.scanDeadLetters({ ownedBy, env, send: sqsFake.send });
    expect(result).toEqual({ deadLetters: 1, replayed: 0, scanned: 3, complete: true });
    expect(ownedBy).toHaveBeenCalledWith([MINE, OTHER]);
    expect(sqsFake.of('SendMessageCommand')).toHaveLength(0);
    expect(sqsFake.of('DeleteMessageCommand')).toHaveLength(0);
    const released = sqsFake.of('ChangeMessageVisibilityBatchCommand')[0].input.Entries;
    expect(released.map((e) => [e.ReceiptHandle, e.VisibilityTimeout])).toEqual([['h1', 0], ['h2', 0], ['h3', 0]]);
  });

  test("replay mode: the team's alert goes back to the main queue, then leaves the DLQ; others are untouched", async () => {
    const sqsFake = fakeSqs([[msg(JSON.stringify({ alertId: MINE }), 'h1'), msg(JSON.stringify({ alertId: OTHER }), 'h2')]]);
    const result = await queue.scanDeadLetters({ replay: true, ownedBy, env, send: sqsFake.send });
    expect(result).toEqual({ deadLetters: 1, replayed: 1, scanned: 2, complete: true });
    const names = sqsFake.calls.map((c) => c.name);
    expect(names.indexOf('SendMessageCommand')).toBeLessThan(names.indexOf('DeleteMessageCommand'));
    expect(sqsFake.of('SendMessageCommand')[0].input).toEqual({ QueueUrl: URL, MessageBody: JSON.stringify({ alertId: MINE }) });
    expect(sqsFake.of('DeleteMessageCommand')[0].input.ReceiptHandle).toBe('h1');
    expect(sqsFake.of('ChangeMessageVisibilityBatchCommand')[0].input.Entries.map((e) => e.ReceiptHandle)).toEqual(['h2']);
  });

  test('stops after MAX_SCAN messages and says the count may be incomplete', async () => {
    const full = (n) => Array.from({ length: 10 }, (_, i) => msg(JSON.stringify({ alertId: MINE }), `h${n}-${i}`));
    const sqsFake = fakeSqs(Array.from({ length: 15 }, (_, n) => full(n)));
    const result = await queue.scanDeadLetters({ ownedBy, env, send: sqsFake.send });
    expect(result).toMatchObject({ scanned: queue.MAX_SCAN, deadLetters: queue.MAX_SCAN, complete: false });
  });

  test('an empty DLQ reads once and finds nothing', async () => {
    const sqsFake = fakeSqs([]);
    await expect(queue.scanDeadLetters({ ownedBy, env, send: sqsFake.send }))
      .resolves.toEqual({ deadLetters: 0, replayed: 0, scanned: 0, complete: true });
    expect(sqsFake.of('ReceiveMessageCommand')).toHaveLength(1);
  });

  test('a failed database lookup deletes nothing (the messages reappear after 30 s)', async () => {
    const sqsFake = fakeSqs([[msg(JSON.stringify({ alertId: MINE }), 'h1')]]);
    await expect(queue.scanDeadLetters({ ownedBy: jest.fn().mockRejectedValue(new Error('db down')), env, send: sqsFake.send }))
      .rejects.toThrow('db down');
    expect(sqsFake.of('DeleteMessageCommand')).toHaveLength(0);
    expect(sqsFake.of('SendMessageCommand')).toHaveLength(0);
  });
});

test('an SQS error reaches the caller (deliverPending then sends inline)', async () => {
  const send = jest.fn().mockRejectedValue(new Error('QueueDoesNotExist'));
  await expect(queue.enqueue('a1', { env: { ALERTS_QUEUE_URL: URL }, send })).rejects.toThrow('QueueDoesNotExist');
});
