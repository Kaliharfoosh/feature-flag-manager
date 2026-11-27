const service = require('./service');
const events = require('../../shared/events');
const securityEmail = require('../../shared/security-email');
const { parseCreate, parseId, parseQuery } = require('./schema');
const { deliverPending } = require('../audit-alerts/github');

async function list(req, res) {
  parseQuery(req.query);
  res.json(await service.listKeys(req.user.teamId));
}

async function create(req, res) {
  const key = await service.createKey(req, parseCreate(req.body));
  await events.publish(req, { action: 'key.created', targetId: key.id, env: key.env, prefix: key.prefix });
  await securityEmail.notify(req, { action: 'key.created', env: key.env, prefix: key.prefix });
  await deliverPending(req);
  res.status(201).json(key);
}

async function revoke(req, res) {
  const key = await service.revokeKey(req, parseId(req.params.id));
  if (key) await events.publish(req, { action: 'key.revoked', targetId: key.id, env: key.env, prefix: key.prefix });
  if (key) await securityEmail.notify(req, { action: 'key.revoked', env: key.env, prefix: key.prefix });
  await deliverPending(req);
  res.status(204).end();
}

module.exports = { list, create, revoke };
