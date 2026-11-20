const audit = require('../../shared/audit');
const github = require('../audit-alerts/github');
const { parseListQuery, parseCreateBody, parseUpdateBody, parseToggle, parseFlagId } = require('./schema');
const { listFlags, createFlag, getFlag, toggleEnvironment, updateFlag, deleteFlag } = require('./service');

async function list(req, res) {
  const filters = parseListQuery(req.query);
  const page = await listFlags(req.user.teamId, filters);
  res.set('Cache-Control', 'no-store').json(page);
}

async function create(req, res) {
  const input = parseCreateBody(req.body);
  const flag = await createFlag(req, input);
  res.set('Cache-Control', 'no-store').status(201).json(flag);
}

async function detail(req, res) {
  res.set('Cache-Control', 'no-store').json(await getFlag(req.user.teamId, parseFlagId(req.params.flagId)));
}

async function toggle(req, res) {
  const input = parseToggle(req.params, req.body);
  let result;
  try {
    result = await toggleEnvironment(req, input);
  } catch (error) {
    if (error.code === 'FORBIDDEN') {
      await audit.recordSecurity(req, 'access.denied', {
        method: req.method, path: req.originalUrl.split('?')[0], requiredRole: 'admin',
      });
    }
    throw error;
  }
  // Deliver alerts only after the toggle and its audit record have committed.
  await github.deliverPending(req);
  res.set('Cache-Control', 'no-store').json(result);
}

async function auditDenial(req, error) {
  if (error.code === 'FORBIDDEN') {
    await audit.recordSecurity(req, 'access.denied', {
      method: req.method, path: req.originalUrl.split('?')[0], requiredRole: 'admin',
    });
  }
}

async function update(req, res) {
  const flagId = parseFlagId(req.params.flagId);
  const input = parseUpdateBody(req.body);
  let flag;
  try {
    flag = await updateFlag(req, flagId, input);
  } catch (error) {
    await auditDenial(req, error);
    throw error;
  }
  await github.deliverPending(req);
  res.set('Cache-Control', 'no-store').json(flag);
}

async function remove(req, res) {
  const flagId = parseFlagId(req.params.flagId);
  try {
    await deleteFlag(req, flagId);
  } catch (error) {
    await auditDenial(req, error);
    throw error;
  }
  await github.deliverPending(req);
  res.status(204).end();
}

module.exports = { list, create, detail, toggle, update, remove };
