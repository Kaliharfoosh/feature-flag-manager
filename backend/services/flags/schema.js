const { z } = require('zod');

const flagKey = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;
const cursor = z.string().min(1).max(67).transform((value, ctx) => {
  const key = Buffer.from(value, 'base64url').toString('utf8');
  if (!flagKey.test(key) || encodeCursor(key) !== value) {
    ctx.addIssue({ code: 'custom', message: 'is not a valid cursor' });
    return z.NEVER;
  }
  return key;
});

const listQuery = z.object({
  q: z.string().max(100).default(''),
  archived: z.enum(['true', 'false']).default('false').transform((value) => value === 'true'),
  limit: z.string().regex(/^\d+$/).transform(Number).pipe(z.number().int().min(1).max(100)).default(25),
  cursor: cursor.optional(),
}).strict();

function encodeCursor(key) {
  return Buffer.from(key, 'utf8').toString('base64url');
}

function parseListQuery(query) {
  const result = listQuery.safeParse(query);
  if (!result.success) {
    const issue = result.error.issues[0];
    const message = issue.code === 'unrecognized_keys'
      ? `Unknown query parameter: ${issue.keys.join(', ')}.`
      : `${issue.path.join('.') || 'query'} ${issue.message}`;
    throw Object.assign(new Error(message), { status: 400, code: 'VALIDATION_ERROR' });
  }
  return result.data;
}


const createBody = z.object({
  key: z.string().regex(flagKey, 'must be 3–50 lowercase letters, digits or hyphens, starting and ending with a letter or digit'),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(''),
});

function parseCreateBody(body) {
  const result = createBody.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw Object.assign(new Error(`${issue.path.join('.') || 'body'} ${issue.message}`), {
      status: 400, code: 'VALIDATION_ERROR',
    });
  }
  return result.data;
}

const flagIdSchema = z.string().uuid();
const environmentSchema = z.enum(['dev', 'staging', 'prod']);
const toggleBody = z.object({ enabled: z.boolean(), version: z.number().int().min(1).max(2147483646) });

function parseToggle(params, body) {
  const parsed = z.object({
    flagId: flagIdSchema, env: environmentSchema, body: toggleBody,
  }).safeParse({ ...params, body });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw Object.assign(new Error(`${issue.path.join('.')} ${issue.message}`), {
      status: 400, code: 'VALIDATION_ERROR',
    });
  }
  return { flagId: parsed.data.flagId, env: parsed.data.env, ...parsed.data.body };
}

function parseFlagId(id) {
  const parsed = flagIdSchema.safeParse(id);
  if (!parsed.success) {
    throw Object.assign(new Error('flagId must be a valid UUID.'), { status: 400, code: 'VALIDATION_ERROR' });
  }
  return parsed.data;
}

module.exports = { parseListQuery, parseCreateBody, parseToggle, parseFlagId, encodeCursor };
