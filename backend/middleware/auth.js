const { findById } = require('../services/auth/service');
const audit = require('../shared/audit');

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

// Use after requireAuth. A refused request is written as an access.denied security event,
// which feeds the "forbidden" count on the monitoring card (ST-02).
function requireRole(role) {
  return async (req, res, next) => {
    if (req.user?.role !== role) {
      await audit.recordSecurity(req, 'access.denied', {
        method: req.method,
        path: req.originalUrl.split('?')[0],
        requiredRole: role,
      });
      throw Object.assign(new Error('You do not have permission to do this.'), {
        status: 403,
        code: 'FORBIDDEN',
      });
    }
    next();
  };
}

module.exports = { requireAuth, requireRole };
