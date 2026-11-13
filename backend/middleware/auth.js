const { findById } = require('../services/auth/service');

async function requireAuth(req, res, next) {
  const user = req.session?.userId && await findById(req.session.userId);
  if (!user) {
    throw Object.assign(new Error('Sign in to continue.'), {
      status: 401,
      code: 'UNAUTHENTICATED',
    });
  }

  req.user = user;
  next();
}

module.exports = { requireAuth };
