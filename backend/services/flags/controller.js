const { parseListQuery, parseCreateBody } = require('./schema');
const { listFlags, createFlag } = require('./service');

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

module.exports = { list, create };
