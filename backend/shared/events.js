// S1 events run after COMMIT. Only identifiers and safe metadata are published; never secrets.
const { EventBridgeClient, PutEventsCommand } = require('@aws-sdk/client-eventbridge');
let client;
const enabled = (env = process.env) => Boolean(env.EVENT_BUS_NAME);
const sendEvent = (command) => (client ??= new EventBridgeClient({ maxAttempts: 1, requestHandler: { connectionTimeout: 1000, requestTimeout: 2000 }, ...(process.env.S1_AWS_ENDPOINT && { endpoint: process.env.S1_AWS_ENDPOINT }) })).send(command);
async function publish(req, { action, targetId, env = 'all', prefix }, { settings = process.env, send = sendEvent } = {}) {
  if (!enabled(settings)) return;
  try {
    const detail = { action, targetId, env, teamId: req.user.teamId, actorId: req.user.id, requestId: req.id, ...(prefix && { prefix }) };
    const result = await send(new PutEventsCommand({ Entries: [{ EventBusName: settings.EVENT_BUS_NAME, Source: 'ffm.flags', DetailType: action, Detail: JSON.stringify(detail) }] }));
    if (result.FailedEntryCount || !result.Entries?.[0]?.EventId) throw new Error('EventBridge entry rejected');
  } catch {
    (req.log || console).warn({ action: 'event.failed', event: action, requestId: req.id, targetId }, 'S1 cloud event failed after commit');
  }
}
module.exports = { enabled, publish };
