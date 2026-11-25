// Vercel function: GET /api/flags?user=u-981 -> every store flag, on or off, for that shopper.
// FFM_API_URL and FFM_API_KEY are environment variables of the store's own Vercel project.
// The key is a STAGING key, so the store can never read prod values.
const { handle } = require('../lib/flag-client');

module.exports = async (req, res) => {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Use GET.' });
  }
  const { status, body } = await handle(req.query || {}, process.env);
  res.setHeader('Cache-Control', 'no-store'); // each shopper gets their own answer
  return res.status(status).json(body);
};
