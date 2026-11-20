// Vercel function: GET /api/flag?flag=new-checkout&user=u-981 -> { enabled, ... }
// FFM_API_URL, FFM_API_KEY and FLAG_KEYS are environment variables of the demo's own Vercel
// project. The key is a STAGING key, so this demo can never read prod values.
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
