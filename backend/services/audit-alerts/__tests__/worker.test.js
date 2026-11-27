const worker = require('../worker');

const ID = '3f1c2b9e-0000-4000-8000-000000000001';
const record = (body, extra = {}) => ({ messageId: 'm1', body, attributes: { ApproximateReceiveCount: '1' }, ...extra });
const log = () => ({ info: jest.fn(), warn: jest.fn() });

describe('processSqsEvent', () => {
  test('delivers the alert named in the message', async () => {
    const deliver = jest.fn().mockResolvedValue({ id: ID, status: 'sent' });
    const l = log();
    await expect(worker.processSqsEvent({ Records: [record(JSON.stringify({ alertId: ID }))] }, { deliver, log: l }))
      .resolves.toEqual({ processed: 1 });
    expect(deliver).toHaveBeenCalledWith(ID);
    expect(l.info).toHaveBeenCalledWith(expect.objectContaining({ alertId: ID, status: 'sent' }), 'alert-worker: done');
  });

  test('a duplicate message (alert already sent or in flight) is dropped, not retried', async () => {
    const deliver = jest.fn().mockResolvedValue(null);
    const l = log();
    await expect(worker.processSqsEvent({ Records: [record(JSON.stringify({ alertId: ID }))] }, { deliver, log: l }))
      .resolves.toEqual({ processed: 1 });
    expect(l.info).toHaveBeenCalledWith(expect.objectContaining({ status: 'skipped' }), 'alert-worker: done');
  });

  test('GitHub failing throws, so SQS retries the message and then moves it to the DLQ', async () => {
    const deliver = jest.fn().mockRejectedValue(Object.assign(new Error('GitHub answered 401: Bad credentials'), { status: 502 }));
    const l = log();
    await expect(worker.processSqsEvent({ Records: [record(JSON.stringify({ alertId: ID }), { attributes: { ApproximateReceiveCount: '3' } })] }, { deliver, log: l }))
      .rejects.toThrow(/not delivered/);
    expect(l.warn).toHaveBeenCalledWith(
      expect.objectContaining({ receiveCount: 3, reason: 'GitHub answered 401: Bad credentials' }),
      'alert-worker: delivery failed',
    );
  });

  test.each([
    ['not JSON', 'hello'],
    ['no alertId', '{}'],
    ['not a uuid', JSON.stringify({ alertId: "1; DROP TABLE alerts" })],
  ])('a malformed message (%s) is never passed to the database and fails', async (_, body) => {
    const deliver = jest.fn();
    await expect(worker.processSqsEvent({ Records: [record(body)] }, { deliver, log: log() })).rejects.toThrow();
    expect(deliver).not.toHaveBeenCalled();
  });

  test('an event with an empty record list does nothing', async () => {
    const deliver = jest.fn();
    await expect(worker.processSqsEvent({ Records: [] }, { deliver, log: log() })).resolves.toEqual({ processed: 0 });
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('scheduled jobs (EventBridge Scheduler)', () => {
  const counts = {
    hours: 24, failedLogins: 12, botCheckFailures: 1, forbidden: 3, serverErrors: 0, rateLimited: 2,
    changes: 40, prodChanges: 3, alertsRaised: 4, alertsSent: 3, alertsFailedNow: 1,
  };

  test('sweep puts every stuck alert back on the queue', async () => {
    const enqueue = jest.fn().mockResolvedValue();
    const stuck = jest.fn().mockResolvedValue([ID, '3f1c2b9e-0000-4000-8000-000000000002']);
    await expect(worker.sweep({ stuck, enqueue, log: log() })).resolves.toEqual({ task: 'sweep', requeued: 2 });
    expect(enqueue.mock.calls.map((c) => c[0])).toEqual([ID, '3f1c2b9e-0000-4000-8000-000000000002']);
  });

  test('daily summary publishes counts only to the ops topic', async () => {
    const publish = jest.fn().mockResolvedValue({ MessageId: 'm1' });
    const env = { OPS_TOPIC_ARN: 'arn:aws:sns:us-east-1:000000000000:ffm-ops-alerts' };
    const now = new Date('2026-11-27T06:00:00Z');
    await expect(worker.dailySummary({ summary: async () => counts, publish, env, now, log: log() }))
      .resolves.toMatchObject({ task: 'daily-summary', failedLogins: 12 });
    const [input] = publish.mock.calls[0];
    expect(input.TopicArn).toBe(env.OPS_TOPIC_ARN);
    expect(input.Subject).toBe('FFM daily audit summary 2026-11-27');
    expect(input.Subject.length).toBeLessThanOrEqual(100); // SNS limit
    expect(input.Message).toMatch(/Failed logins\s+12/);
    expect(input.Message).toMatch(/Production changes\s+3/);
    expect(input.Message).not.toMatch(/@|\d+\.\d+\.\d+\.\d+/); // no emails or IPs
  });

  test('daily summary without a topic fails loudly instead of doing nothing', async () => {
    await expect(worker.dailySummary({ summary: async () => counts, publish: jest.fn(), env: {}, log: log() }))
      .rejects.toThrow('OPS_TOPIC_ARN');
  });

  test('handle routes SQS records, the two tasks, and refuses anything else', async () => {
    const deliver = jest.fn().mockResolvedValue({ status: 'sent' });
    await expect(worker.handle({ Records: [record(JSON.stringify({ alertId: ID }))] }, { deliver, log: log() }))
      .resolves.toEqual({ processed: 1 });
    await expect(worker.handle({ task: 'sweep' }, { stuck: async () => [], enqueue: jest.fn(), log: log() }))
      .resolves.toEqual({ task: 'sweep', requeued: 0 });
    await expect(worker.handle({ task: 'drop-tables' })).rejects.toThrow('Unknown event');
    await expect(worker.handle(undefined)).rejects.toThrow('Unknown event');
  });
});
