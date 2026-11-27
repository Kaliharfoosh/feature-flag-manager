// Local-only setup and verification; no live database or real email delivery.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const e = require('@aws-sdk/client-eventbridge');
const n = require('@aws-sdk/client-sns');
const q = require('@aws-sdk/client-sqs');
const m = require('@aws-sdk/client-ses');
const options = { endpoint: 'http://127.0.0.1:4566', region: 'us-east-1', credentials: { accessKeyId: 'test', secretAccessKey: 'test' } };
Object.assign(process.env, { S1_AWS_ENDPOINT: options.endpoint, AWS_REGION: options.region,
  AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test', EVENT_BUS_NAME: 'ffm-events', SES_FROM_ADDRESS: 'security@ffm.local' });
async function main() {
  const events = new e.EventBridgeClient(options), sns = new n.SNSClient(options), sqs = new q.SQSClient(options), ses = new m.SESClient(options);
  const buses = await events.send(new e.ListEventBusesCommand({}));
  if (!buses.EventBuses.some(bus => bus.Name === 'ffm-events')) await events.send(new e.CreateEventBusCommand({ Name: 'ffm-events' }));
  const { TopicArn } = await sns.send(new n.CreateTopicCommand({ Name: 'ffm-ops-alerts' }));
  const { QueueUrl } = await sqs.send(new q.CreateQueueCommand({ QueueName: 'ffm-s1-demo-inbox' }));
  const { Attributes } = await sqs.send(new q.GetQueueAttributesCommand({ QueueUrl, AttributeNames: ['QueueArn'] }));
  await sqs.send(new q.SetQueueAttributesCommand({ QueueUrl, Attributes: { Policy: JSON.stringify({ Version: '2012-10-17', Statement: [{ Effect: 'Allow', Principal: { Service: 'sns.amazonaws.com' }, Action: 'sqs:SendMessage', Resource: Attributes.QueueArn, Condition: { ArnEquals: { 'aws:SourceArn': TopicArn } } }] }) } }));
  await sns.send(new n.SubscribeCommand({ TopicArn, Protocol: 'sqs', Endpoint: Attributes.QueueArn }));
  const existing = await sns.send(new n.GetTopicAttributesCommand({ TopicArn }));
  const policy = JSON.parse(existing.Attributes.Policy || '{"Version":"2012-10-17","Statement":[]}');
  policy.Statement = [].concat(policy.Statement || []).filter(s => s.Sid !== 'FfmS1EventBridge');
  policy.Statement.push({ Sid: 'FfmS1EventBridge', Effect: 'Allow', Principal: { Service: 'events.amazonaws.com' }, Action: 'sns:Publish', Resource: TopicArn });
  await sns.send(new n.SetTopicAttributesCommand({ TopicArn, AttributeName: 'Policy', AttributeValue: JSON.stringify(policy) }));
  await events.send(new e.PutRuleCommand({ Name: 'prod-flag-change', EventBusName: 'ffm-events', State: 'ENABLED', EventPattern: JSON.stringify({ source: ['ffm.flags'], detail: { env: ['prod'] } }) }));
  const targets = await events.send(new e.PutTargetsCommand({ Rule: 'prod-flag-change', EventBusName: 'ffm-events', Targets: [{ Id: 's1-ops', Arn: TopicArn }] }));
  assert.equal(targets.FailedEntryCount, 0);
  await ses.send(new m.VerifyEmailIdentityCommand({ EmailAddress: 'security@ffm.local' }));
  await ses.send(new m.VerifyEmailIdentityCommand({ EmailAddress: 'admin@example.test' }));
  let failed = false;
  const req = { user: { id: randomUUID(), teamId: randomUUID(), email: 'demo@example.test' }, id: randomUUID(), log: { warn: () => { failed = true; } } };
  await require('../../backend/shared/events').publish(req, { action: 'flag.toggled', targetId: randomUUID(), env: 'prod' });
  let delivered = false;
  for (let i = 0; i < 5 && !delivered; i++) {
    const result = await sqs.send(new q.ReceiveMessageCommand({ QueueUrl, MaxNumberOfMessages: 10, WaitTimeSeconds: 1 }));
    delivered = (result.Messages || []).some(item => item.Body.includes(req.id));
  }
  assert.ok(delivered, 'Event must reach the demo inbox through SNS');
  const { notify } = require('../../backend/shared/security-email');
  for (const action of ['key.created', 'key.revoked']) await notify(req, { action, env: 'prod', prefix: 'ffm_demo_prefix' }, { query: async () => ({ rows: [{ email: 'admin@example.test' }] }) });
  assert.equal(failed, false);
  console.log('PASS: EventBridge → SNS → ffm-s1-demo-inbox delivered the production event.');
  console.log('PASS: SES accepted production key creation and revocation emails to a synthetic Admin.');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
