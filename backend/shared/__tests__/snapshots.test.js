const { randomBytes } = require('node:crypto');
const snapshots = require('../snapshots');
const teamId = '699df5c7-e092-4a81-b7cb-14d6ea382378';
const flagId = '3d6e0a1b-2c3d-4e5f-8a9b-0c1d2e3f4a5b';
const record = () => ({ format: 1, teamId, at: '2026-11-27T10:00:00.000Z', action: 'flag.updated',
  actor: { id: 'c72f08c0-3a44-4f92-8379-0375da225f99', email: 'admin@example.test' },
  flag: { id: flagId, key: 'winter-promo', name: 'Private winter promotion', description: 'Sensitive feature details', archived: false, version: 2,
    environments: Object.fromEntries(['dev','staging','prod'].map(env => [env, { enabled: true, percentage: 25, version: 2 }])) },
  rules: [{ env: 'staging', userId: 'private-beta-shopper', kind: 'allow' }],
});
function fixture() {
  const objects = new Map(), keys = new Map();
  const env = { SNAPSHOT_BUCKET: 'private-snapshots', SNAPSHOT_KMS_KEY: 'alias/s1-test' };
  const kms = jest.fn(async command => {
    const input = command.input;
    if (command.constructor.name === 'GenerateDataKeyCommand') {
      const plain = randomBytes(32), cipher = randomBytes(48);
      keys.set(cipher.toString('base64'), { plain, context: input.EncryptionContext });
      return { Plaintext: Buffer.from(plain), CiphertextBlob: cipher };
    }
    const entry = keys.get(Buffer.from(input.CiphertextBlob).toString('base64'));
    if (!entry || JSON.stringify(entry.context) !== JSON.stringify(input.EncryptionContext)) throw new Error('InvalidCiphertext');
    return { Plaintext: Buffer.from(entry.plain) };
  });
  const s3 = jest.fn(async command => {
    const input = command.input;
    if (command.constructor.name === 'PutObjectCommand') {
      const versionId = 'version-' + (objects.size + 1);
      objects.set(input.Key + ':' + versionId, input.Body);
      return { VersionId: versionId };
    }
    if (command.constructor.name === 'GetObjectCommand') {
      const body = objects.get(input.Key + ':' + input.VersionId);
      if (!body) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      return { VersionId: input.VersionId, ContentLength: Buffer.byteLength(body), Body: { transformToString: async () => body } };
    }
    return { Versions: [...objects.keys()].map(key => ({ Key: key.split(':')[0], VersionId: key.split(':')[1] })), IsTruncated: false };
  });
  return { env, s3, kms, objects };
}

test('encrypts all configuration and decrypts a selected version; data keys are erased', async () => {
  const fixtureState = fixture();
  const input = record();
  const versionId = await snapshots.save(input, fixtureState);
  const body = [...fixtureState.objects.values()][0];
  for (const secret of [input.flag.name, input.flag.description, input.rules[0].userId, input.actor.email]) expect(body).not.toContain(secret);
  const createdKey = await fixtureState.kms.mock.results[0].value;
  expect([...createdKey.Plaintext].every(byte => byte === 0)).toBe(true);
  expect((await snapshots.read(teamId, flagId, versionId, fixtureState)).data).toEqual(input);
  const decryptInput = fixtureState.kms.mock.calls.at(-1)[0].input;
  expect(decryptInput).toMatchObject({ KeyId: fixtureState.env.SNAPSHOT_KMS_KEY, EncryptionContext: { teamId, flagId } });
  expect(fixtureState.s3.mock.calls[0][0].input.Key).toBe(`teams/${teamId}/flags/${flagId}.json`);
});

test.each(['ciphertext','tag','iv'])('rejects tampered %s without returning plaintext', async field => {
  const state = fixture();
  const version = await snapshots.save(record(), state);
  const key = [...state.objects.keys()][0], envelope = JSON.parse(state.objects.get(key));
  const bytes = Buffer.from(envelope[field], 'base64'); bytes[0] ^= 1; envelope[field] = bytes.toString('base64');
  state.objects.set(key, JSON.stringify(envelope));
  await expect(snapshots.read(teamId, flagId, version, state)).rejects.toMatchObject({ status: 503, code: 'HISTORY_UNAVAILABLE' });
});

test('another team cannot use a version id from this team', async () => {
  const state = fixture(), version = await snapshots.save(record(), state);
  await expect(snapshots.read('c72f08c0-3a44-4f92-8379-0375da225f99', flagId, version, state)).rejects.toMatchObject({ status: 404 });
});

test('ciphertext moved to another tenant path still fails the KMS context check', async () => {
  const state = fixture(), version = await snapshots.save(record(), state);
  const otherTeam = 'c72f08c0-3a44-4f92-8379-0375da225f99';
  state.objects.set(snapshots.objectKey(otherTeam, flagId) + ':' + version, [...state.objects.values()][0]);
  await expect(snapshots.read(otherTeam, flagId, version, state)).rejects.toMatchObject({ status: 503 });
});

test('history lists safe summaries and rejects invalid markers', async () => {
  const state = fixture();
  await snapshots.save(record(), state);
  const next = record(); next.flag.version = 3;
  await snapshots.save(next, state);
  const history = await snapshots.history(teamId, flagId, null, state);
  expect(history.items.map(item => item.version)).toEqual([3,2]);
  expect(JSON.stringify(history)).not.toContain('private-beta-shopper');
  expect(history.items[0]).not.toHaveProperty('ciphertext');
  await expect(snapshots.history(teamId, flagId, 'bad-cursor', state)).rejects.toMatchObject({ status: 400 });
});

test('unset AWS is disabled, partial configuration and unversioned storage fail visibly', async () => {
  expect(snapshots.enabled({})).toBe(false);
  const state = fixture();
  await expect(snapshots.save(record(), { ...state, env: { SNAPSHOT_BUCKET: 'partial' } })).rejects.toMatchObject({ status: 503 });
  state.s3.mockResolvedValue({ VersionId: 'null' });
  await expect(snapshots.save(record(), state)).rejects.toMatchObject({ status: 503 });
});
