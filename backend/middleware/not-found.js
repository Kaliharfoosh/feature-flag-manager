// Registered after every route, so it only runs when nothing matched.
// ROUTE_NOT_FOUND (bad method/path) is different from NOT_FOUND (valid path, unknown id).
module.exports = (req, res) => {
  res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: 'Route not found.', requestId: req.id } });
};
