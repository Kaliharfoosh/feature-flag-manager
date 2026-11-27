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

  test('an event without records does nothing', async () => {
    const deliver = jest.fn();
    await expect(worker.processSqsEvent({}, { deliver, log: log() })).resolves.toEqual({ processed: 0 });
    expect(deliver).not.toHaveBeenCalled();
  });
});
