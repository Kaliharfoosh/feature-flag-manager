// Central error handler (Lab 4) with our requestId added. Four parameters make it an
// Express error handler; it is registered last in app.js.
// Controllers never build error JSON themselves: they throw an Error with .status and .code
// (for example 401 UNAUTHENTICATED, 404 NOT_FOUND, 409 STALE_VERSION) and this file formats it.
// eslint-disable-next-line no-unused-vars
module.exports = (err, req, res, next) => {
  const requestId = req.id;

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'Request body is not valid JSON.', requestId } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Body must be under 10 kB.', requestId } });
  }
  if (err.status && err.code) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, requestId } });
  }

  // Anything else is a bug or an outage: full details go to the log only, never to the client.
  (req.log || console).error({ err }, 'unhandled error');
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'An unexpected server error occurred.', requestId } });
};
