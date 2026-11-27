// Explicitly local-only. Writes synthetic snapshots and one test event on Floci, never Neon.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const snapshots = require('../../backend/shared/snapshots');
const events = require('../../backend/shared/events');
const endpoint = process.env.S1_AWS_ENDPOINT || 'http://127.0.0.1:4566';
const parsed = new URL(endpoint);
if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(parsed.hostname)) throw new Error('This check is local Floci only.');
Object.assign(process.env, { S1_AWS_ENDPOINT: endpoint, AWS_REGION: 'us-east-1', AWS_ACCESS_KEY_ID: 'test', AWS_SECRET_ACCESS_KEY: 'test',
  SNAPSHOT_BUCKET: 'ffm-flag-snapshots', SNAPSHOT_KMS_KEY: 'alias/ffm-flags', EVENT_BUS_NAME: 'ffm-events' });

(async () => {
  const teamId = randomUUID(), flagId = randomUUID(), actorId = randomUUID();
  const flag = { id: flagId, key: 's1-local-evidence', name: 'Synthetic recovery check', description: 'No live data', archived: false, version: 1,
    environments: Object.fromEntries(['dev','staging','prod'].map(env => [env, { enabled: false, percentage: 0, version: 1 }])) };
  const record = { format: 1, teamId, at: new Date().toISOString(), action: 'flag.created', actor: { id: actorId, email: 's1-evidence@example.test' }, flag, rules: [] };
  const first = await snapshots.save(record);
  const second = await snapshots.save({ ...record, action: 'flag.updated', flag: { ...flag, name: 'Updated recovery check', version: 2 } });
  assert.notEqual(first, second);
  const restored = await snapshots.read(teamId, flagId, first);
  assert.equal(restored.data.flag.name, flag.name);
  const history = await snapshots.history(teamId, flagId);
  assert.equal(history.items.length, 2);
  await assert.rejects(() => snapshots.read(randomUUID(), flagId, first), error => error.code === 'NOT_FOUND');
  console.log('PASS: S3 stores distinct versions; KMS decrypts a selected version; cross-team path is refused.');
  let failed = false;
  const req = { user: { id: actorId, teamId }, id: randomUUID(), log: { warn: () => { failed = true; } } };
  await events.publish(req, { action: 'flag.toggled', targetId: flagId, env: 'prod' });
  assert.equal(failed, false);
  console.log('PASS: EventBridge accepted the production event. Verify SNS delivery in ffm-ops-inbox separately.');
  console.log('Synthetic evidence namespace:', teamId);
})().catch(error => { console.error('FAIL:', error.message); process.exitCode = 1; });
