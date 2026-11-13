// Lab 4's 415 check, done once instead of in every controller.
// req.is() returns false when there IS a body of the wrong type, and null when there is no body
// at all (logout, DELETE), so bodiless requests pass through untouched.
module.exports = (req, res, next) => {
  if (req.is('application/json') === false) {
    return res.status(415).json({
      error: { code: 'UNSUPPORTED_MEDIA_TYPE', message: 'Content-Type must be application/json.', requestId: req.id },
    });
  }
  next();
};
