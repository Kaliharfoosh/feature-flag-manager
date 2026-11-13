const { parseListQuery } = require('./schema');
const { listFlags } = require('./service');

async function list(req, res) {
  const filters = parseListQuery(req.query);
  const page = await listFlags(req.user.teamId, filters);
  res.set('Cache-Control', 'no-store').json(page);
}

module.exports = { list };
