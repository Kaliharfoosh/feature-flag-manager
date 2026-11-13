// Reject non-JSON payloads, but let empty writes such as logout through.
// Some clients send Content-Length: 0 for a request with no payload.
module.exports = (req, res, next) => {
  const isEmpty = req.get('Content-Length') === '0' && !req.get('Transfer-Encoding');
  if (!isEmpty && req.is('application/json') === false) {
    return res.status(415).json({
      error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json.', requestId: req.id },
    });
  }
  next();
};
