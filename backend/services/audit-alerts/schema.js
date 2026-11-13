// Query-string validation for the audit and monitoring endpoints (zod, strict: an unknown
// parameter is a 400, not silently ignored). Each parse* function returns clean values or
// throws an Error with status 400 / VALIDATION_ERROR, which middleware/errors.js formats.
const { z } = require('zod');

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ACTION = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;

function validationError(message) {
  const err = new Error(message);
  err.status = 400;
  err.code = 'VALIDATION_ERROR';
  return err;
}

// "2026-11-01" or a full ISO 8601 timestamp. `to` given as a date means the whole of that day.
const isoDate = (endOfDay) => z.string().max(40).transform((value, ctx) => {
  const isDateOnly = DATE_ONLY.test(value);
  if (!isDateOnly && !z.iso.datetime({ offset: true }).safeParse(value).success) {
    ctx.addIssue({ code: 'custom', message: 'must be a date like 2026-11-01 or an ISO 8601 time' });
    return z.NEVER;
  }
  const date = new Date(isDateOnly ? `${value}T00:00:00.000Z` : value);
  if (Number.isNaN(date.getTime())) {
    ctx.addIssue({ code: 'custom', message: 'is not a real date' });
    return z.NEVER;
  }
  if (endOfDay && isDateOnly) date.setUTCDate(date.getUTCDate() + 1);
  return date;
});

// The cursor is the id of the last event on the previous page, base64url encoded so clients
// treat it as opaque.
const cursor = z.string().max(40).transform((value, ctx) => {
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  if (!/^[1-9]\d{0,17}$/.test(decoded)) {
    ctx.addIssue({ code: 'custom', message: 'is not a valid cursor' });
    return z.NEVER;
  }
  return decoded; // kept as text: bigserial ids can outgrow Number
});

const filterShape = {
  actor: z.string().min(1).max(254).optional(),
  action: z.string().regex(ACTION, 'must look like flag.toggled').optional(),
  category: z.enum(['change', 'security']).optional(),
  from: isoDate(false).optional(),
  to: isoDate(true).optional(), // exclusive upper bound after this transform
};

const auditListSchema = z.object({
  ...filterShape,
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: cursor.optional(),
}).strict();

const auditExportSchema = z.object(filterShape).strict();

const summarySchema = z.object({ days: z.coerce.number().int().min(1).max(90).default(7) }).strict();
const monitoringSchema = z.object({ hours: z.coerce.number().int().min(1).max(168).default(24) }).strict();

function parse(schema, query) {
  const result = schema.safeParse(query ?? {});
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue.path.length ? issue.path.join('.') : 'query';
    throw validationError(issue.code === 'unrecognized_keys'
      ? `Unknown parameter: ${issue.keys.join(', ')}.`
      : `${field} ${issue.message}.`);
  }
  const value = result.data;
  if (value.from && value.to && value.from >= value.to) throw validationError('from must be before to.');
  return value;
}

// PUT /alert-rules body: { rules: [{ rule, enabled }] }, each rule at most once.
const alertRulesSchema = z.object({
  rules: z.array(z.object({
    rule: z.enum(['prod_change', 'key_change', 'login_failures']),
    enabled: z.boolean(),
  }).strict()).min(1).max(3)
    .refine((rules) => new Set(rules.map((r) => r.rule)).size === rules.length, 'must not repeat a rule'),
}).strict();

const encodeCursor =(id) => Buffer.from(String(id), 'utf8').toString('base64url');

module.exports = {
  parseAuditList: (q) => parse(auditListSchema, q),
  parseAuditExport: (q) => parse(auditExportSchema, q),
  parseSummary: (q) => parse(summarySchema, q),
  parseMonitoring: (q) => parse(monitoringSchema, q),
  parseAlertRules: (body) => parse(alertRulesSchema, body),
  encodeCursor,
  validationError,
};
