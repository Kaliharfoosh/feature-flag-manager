const { z } = require('zod');

function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const message = issue.code === 'unrecognized_keys'
      ? `Unknown field: ${issue.keys.join(', ')}.`
      : `${issue.path.join('.') || 'input'}: ${issue.message}`;
    throw Object.assign(new Error(message), { status: 400, code: 'VALIDATION_ERROR' });
  }
  return result.data;
}

const createBody = z.object({
  name: z.string().trim().min(1).max(60),
  env: z.enum(['dev', 'staging', 'prod']),
}).strict();

module.exports = {
  parseCreate: (body) => parse(createBody, body),
  parseId: (id) => parse(z.string().uuid(), id),
  parseQuery: (query) => parse(z.object({}).strict(), query),
};
