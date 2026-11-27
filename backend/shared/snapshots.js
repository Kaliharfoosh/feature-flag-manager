// S1: versioned, application-encrypted flag history. Unset settings keep AWS off on Vercel.
const { randomBytes, createCipheriv, createDecipheriv } = require('node:crypto');
const { z } = require('zod');
const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectVersionsCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { KMSClient, GenerateDataKeyCommand, DecryptCommand } = require('@aws-sdk/client-kms');
const uuid = z.string().uuid();
const setting = z.object({ enabled: z.boolean(), percentage: z.coerce.number().min(0).max(100), version: z.number().int().positive().max(2147483646), rolloutVersion: z.number().int().positive().max(2147483646).optional() });
const snapshotSchema = z.object({
  format: z.literal(1), teamId: uuid, at: z.string().datetime(), action: z.enum(['flag.created', 'flag.updated', 'flag.toggled', 'flag.archived', 'flag.unarchived', 'flag.deleted', 'flag.restored']),
  actor: z.object({ id: uuid, email: z.string().max(254) }),
  flag: z.object({ id: uuid, key: z.string().regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/), name: z.string().min(1).max(100), description: z.string().max(500), archived: z.boolean(), version: z.number().int().positive(),
    environments: z.object({ dev: setting, staging: setting, prod: setting }) }),
  rules: z.array(z.object({ env: z.enum(['dev', 'staging', 'prod']), userId: z.string().min(1).max(100), kind: z.enum(['allow', 'block']) })).max(5000),
});
const MAX_BYTES = 2 * 1024 * 1024;
const PAGE_SIZE = 20;
let s3Client, kmsClient;
const options = () => ({ maxAttempts: 1, requestHandler: { connectionTimeout: 1000, requestTimeout: 2000 }, ...(process.env.S1_AWS_ENDPOINT && { endpoint: process.env.S1_AWS_ENDPOINT }) });
const sendS3 = (command) => (s3Client ??= new S3Client({ ...options(), forcePathStyle: true })).send(command);
const sendKms = (command) => (kmsClient ??= new KMSClient(options())).send(command);
function enabled(env = process.env) { return Boolean(env.SNAPSHOT_BUCKET || env.SNAPSHOT_KMS_KEY); }
function unavailable() { return Object.assign(new Error('Flag history is temporarily unavailable. Please try again.'), { status: 503, code: 'HISTORY_UNAVAILABLE' }); }
function notFound() { return Object.assign(new Error('Flag history version not found.'), { status: 404, code: 'NOT_FOUND' }); }
function config(env) { if (!env.SNAPSHOT_BUCKET || !env.SNAPSHOT_KMS_KEY) throw unavailable(); return env; }
function objectKey(teamId, flagId) { uuid.parse(teamId); uuid.parse(flagId); return `teams/${teamId}/flags/${flagId}.json`; }
const context = (teamId, flagId) => ({ teamId, flagId });
const aad = (teamId, flagId) => Buffer.from(JSON.stringify({ format: 1, teamId, flagId }));
const base64 = (value) => Buffer.from(value).toString('base64');
function decode(value, bytes) {
  if (typeof value !== 'string' || value.length > MAX_BYTES * 2 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw unavailable();
  const buffer = Buffer.from(value, 'base64');
  if (bytes && buffer.length !== bytes) throw unavailable();
  return buffer;
}
async function save(input, { env = process.env, s3 = sendS3, kms = sendKms } = {}) {
  config(env);
  const data = snapshotSchema.parse(input);
  const plain = Buffer.from(JSON.stringify(data));
  if (plain.length > MAX_BYTES / 2) throw unavailable();
  const generated = await kms(new GenerateDataKeyCommand({ KeyId: env.SNAPSHOT_KMS_KEY, KeySpec: 'AES_256', EncryptionContext: context(data.teamId, data.flag.id) }));
  const key = generated.Plaintext;
  if (!key || key.length !== 32 || !generated.CiphertextBlob) { key?.fill(0); throw unavailable(); }
  let envelope;
  try {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(data.teamId, data.flag.id));
    const encrypted = Buffer.concat([cipher.update(plain), cipher.final()]);
    envelope = { format: 1, key: base64(generated.CiphertextBlob), iv: base64(iv), tag: base64(cipher.getAuthTag()), ciphertext: base64(encrypted) };
  } finally { key.fill(0); plain.fill(0); }
  const result = await s3(new PutObjectCommand({ Bucket: env.SNAPSHOT_BUCKET, Key: objectKey(data.teamId, data.flag.id),
    Body: JSON.stringify(envelope), ContentType: 'application/json', CacheControl: 'no-store' }));
  if (!result.VersionId || result.VersionId === 'null') throw unavailable();
  return result.VersionId;
}
async function read(teamId, flagId, versionId, { env = process.env, s3 = sendS3, kms = sendKms } = {}) {
  config(env);
  try {
    const response = await s3(new GetObjectCommand({ Bucket: env.SNAPSHOT_BUCKET, Key: objectKey(teamId, flagId), ...(versionId && { VersionId: versionId }) }));
    if (!response.Body || response.ContentLength > MAX_BYTES) { response.Body?.destroy?.(); throw unavailable(); }
    const text = await response.Body.transformToString();
    if (Buffer.byteLength(text) > MAX_BYTES) throw unavailable();
    const envelope = JSON.parse(text);
    if (envelope.format !== 1) throw unavailable();
    const decrypted = await kms(new DecryptCommand({ KeyId: env.SNAPSHOT_KMS_KEY, CiphertextBlob: decode(envelope.key), EncryptionContext: context(teamId, flagId) }));
    const key = decrypted.Plaintext;
    if (!key || key.length !== 32) { key?.fill(0); throw unavailable(); }
    let plain;
    try {
      const decipher = createDecipheriv('aes-256-gcm', key, decode(envelope.iv, 12));
      decipher.setAAD(aad(teamId, flagId));
      decipher.setAuthTag(decode(envelope.tag, 16));
      plain = Buffer.concat([decipher.update(decode(envelope.ciphertext)), decipher.final()]);
      const data = snapshotSchema.parse(JSON.parse(plain.toString('utf8')));
      if (data.teamId !== teamId || data.flag.id !== flagId) throw unavailable();
      return { versionId: response.VersionId || versionId, data };
    } finally { key.fill(0); plain?.fill(0); }
  } catch (error) {
    if (['NoSuchKey', 'NoSuchVersion', 'NotFound'].includes(error.name) || error.$metadata?.httpStatusCode === 404) throw notFound();
    if (error.code === 'NOT_FOUND') throw error;
    throw unavailable();
  }
}
function encodeCursor(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decodeCursor(value) {
  try { const cursor = JSON.parse(Buffer.from(value, 'base64url')); if (typeof cursor.version !== 'string' || cursor.version.length > 1024) throw new Error(); return cursor; }
  catch { throw Object.assign(new Error('Invalid history cursor.'), { status: 400, code: 'VALIDATION_ERROR' }); }
}
async function history(teamId, flagId, cursor, opts = {}) {
  const env = config(opts.env ?? process.env), s3 = opts.s3 ?? sendS3;
  const key = objectKey(teamId, flagId), marker = cursor ? decodeCursor(cursor) : null;
  let result;
  try { result = await s3(new ListObjectVersionsCommand({ Bucket: env.SNAPSHOT_BUCKET, Prefix: key, MaxKeys: PAGE_SIZE,
    ...(marker && { KeyMarker: key, VersionIdMarker: marker.version }) })); }
  catch { throw unavailable(); }
  const versions = (result.Versions ?? []).filter((item) => item.Key === key && item.VersionId !== 'null');
  const records = await Promise.all(versions.map((version) => read(teamId, flagId, version.VersionId, opts)));
  records.sort((a, b) => b.data.flag.version - a.data.flag.version);
  const items = records.map(({ versionId, data }) => ({ versionId, at: data.at, action: data.action, actor: data.actor.email,
    name: data.flag.name, version: data.flag.version, archived: data.flag.archived, environments: data.flag.environments }));
  return { enabled: true, items, nextCursor: result.IsTruncated && result.NextKeyMarker === key && result.NextVersionIdMarker
    ? encodeCursor({ version: result.NextVersionIdMarker }) : null };
}
async function catalog(teamId, cursor, opts = {}) {
  uuid.parse(teamId);
  const env = config(opts.env ?? process.env), s3 = opts.s3 ?? sendS3;
  let result;
  try { result = await s3(new ListObjectsV2Command({ Bucket: env.SNAPSHOT_BUCKET, Prefix: `teams/${teamId}/flags/`, MaxKeys: PAGE_SIZE, ...(cursor && { ContinuationToken: cursor }) })); }
  catch { throw unavailable(); }
  const ids = (result.Contents ?? []).map((item) => item.Key.split('/').at(-1).replace(/\.json$/, '')).filter((id) => uuid.safeParse(id).success);
  const records = await Promise.all(ids.map((id) => read(teamId, id, null, opts)));
  return { records, nextCursor: result.IsTruncated ? result.NextContinuationToken ?? null : null };
}
module.exports = { enabled, save, read, history, catalog, snapshotSchema, objectKey, unavailable };
