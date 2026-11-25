// Input validation for the Rollout Service (zod, strict: unknown fields are a 400, not ignored).
// Each parse* function returns clean values or throws status 400 / VALIDATION_ERROR,
// which middleware/errors.js turns into { error: { code, message, requestId } }.
const { z } = require('zod');
const { ENVS } = require('./rollouts');

const FLAG_KEY = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/; // same rule as the flags table
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validationError(message) {
  return Object.assign(new Error(message), { status: 400, code: 'VALIDATION_ERROR' });
}
function notFound(message = 'Flag not found.') {
  return Object.assign(new Error(message), { status: 404, code: 'NOT_FOUND' });
}

function messageFor(error) {
  const issue = error.issues[0];
  if (issue.code === 'unrecognized_keys') return `Unknown field: ${issue.keys.join(', ')}.`;
  return issue.message;
}

// numeric(5,2) in the database: 0-100 with at most 2 decimals
const percentage = z.number({ error: 'percentage must be a number between 0 and 100' })
  .min(0, 'percentage must be a number between 0 and 100')
  .max(100, 'percentage must be a number between 0 and 100')
  .refine((p) => Math.abs(p * 100 - Math.round(p * 100)) < 1e-9, 'percentage can have at most 2 decimals');

const rolloutBody = z.object({
  percentage,
  version: z.number({ error: 'version must be the whole number you last read' })
    .int('version must be the whole number you last read')
    .min(1, 'version must be the whole number you last read'),
}).strict();

// PUT /rollouts/:flagId/:env
function parseRolloutParams(params) {
  if (!ENVS.includes(params.env)) throw validationError('env must be dev, staging or prod');
  // A malformed id cannot belong to the team, so it is a 404 like any other unknown flag.
  if (!UUID.test(params.flagId ?? '')) throw notFound();
  return { flagId: params.flagId.toLowerCase(), env: params.env };
}

function parseRolloutBody(body) {
  const result = rolloutBody.safeParse(body ?? {});
  if (!result.success) throw validationError(messageFor(result.error));
  return result.data;
}

// POST /evaluations. flagKey and userId only: the environment ALWAYS comes from the API key,
// so a body such as { "env": "prod" } is refused (security test ST-06).
const evaluationBody = z.object({
  flagKey: z.string({ error: 'flagKey is required' }).regex(FLAG_KEY, 'flagKey is not a valid flag key'),
  userId: z.string({ error: 'userId is required' })
    .min(1, 'userId must be 1 to 100 characters')
    .max(100, 'userId must be 1 to 100 characters'),
}).strict();

function parseEvaluationBody(body) {
  const result = evaluationBody.safeParse(body ?? {});
  if (!result.success) throw validationError(messageFor(result.error));
  return result.data;
}

// POST /evaluations/batch. Like /evaluations: no env in the body (the key decides it).
// 1 to 50 different flag keys, so one request can never ask for an unbounded amount of work.
const MAX_BATCH = 50;
const batchBody = z.object({
  userId: z.string({ error: 'userId is required' })
    .min(1, 'userId must be 1 to 100 characters')
    .max(100, 'userId must be 1 to 100 characters'),
  flagKeys: z.array(
    z.string({ error: 'each flagKey must be a valid flag key' }).regex(FLAG_KEY, 'each flagKey must be a valid flag key'),
    { error: 'flagKeys must be a list of flag keys' },
  )
    .min(1, `flagKeys must have 1 to ${MAX_BATCH} flag keys`)
    .max(MAX_BATCH, `flagKeys must have 1 to ${MAX_BATCH} flag keys`)
    .refine((keys) => new Set(keys).size === keys.length, 'flagKeys must not repeat a flag key'),
}).strict();

function parseBatchBody(body) {
  const result = batchBody.safeParse(body ?? {});
  if (!result.success) throw validationError(messageFor(result.error));
  return result.data;
}

// GET /rollouts/:flagId
function parseFlagId(flagId) {
  if (!UUID.test(flagId ?? '')) throw notFound();
  return flagId.toLowerCase();
}

// DELETE /rules/:ruleId
function parseRuleId(ruleId) {
  if (!UUID.test(ruleId ?? '')) throw notFound('Rule not found.');
  return ruleId.toLowerCase();
}

// Not trimmed: rules must match the exact userId client apps send to /evaluations.
const userId = z.string({ error: 'userId is required' })
  .min(1, 'userId must be 1 to 100 characters')
  .max(100, 'userId must be 1 to 100 characters');

// POST /rollouts/:flagId/:env/rules
const ruleBody = z.object({
  userId,
  kind: z.enum(['allow', 'block'], { error: 'kind must be allow or block' }),
}).strict();

function parseRuleBody(body) {
  const result = ruleBody.safeParse(body ?? {});
  if (!result.success) throw validationError(messageFor(result.error));
  return result.data;
}

// POST /preview. Unlike /evaluations, a signed-in user chooses the env here.
const previewBody = z.object({
  flagKey: z.string({ error: 'flagKey is required' }).regex(FLAG_KEY, 'flagKey is not a valid flag key'),
  env: z.enum(ENVS, { error: 'env must be dev, staging or prod' }),
  userId,
}).strict();

function parsePreviewBody(body) {
  const result = previewBody.safeParse(body ?? {});
  if (!result.success) throw validationError(messageFor(result.error));
  return result.data;
}

module.exports = {
  parseRolloutParams, parseRolloutBody, parseEvaluationBody, parseBatchBody, MAX_BATCH,
  parseFlagId, parseRuleId, parseRuleBody, parsePreviewBody, notFound,
};
