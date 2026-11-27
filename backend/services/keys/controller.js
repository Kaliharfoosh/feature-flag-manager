const service = require('./service');
const { parseCreate, parseId, parseQuery } = require('./schema');
const { deliverPending } = require('../audit-alerts/github');

async function list(req, res) {
  parseQuery(req.query);
  res.json(await service.listKeys(req.user.teamId));
}

async function create(req, res) {
  const key = await service.createKey(req, parseCreate(req.body));
  await deliverPending(req);
  res.status(201).json(key);
}

async function revoke(req, res) {
  await service.revokeKey(req, parseId(req.params.id));
  await deliverPending(req);
  res.status(204).end();
}

module.exports = { list, create, revoke };
