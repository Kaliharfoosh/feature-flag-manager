const bcrypt = require('bcryptjs');
const { promisify } = require('node:util');
const { z } = require('zod');
const { generateToken } = require('../../middleware/csrf');
const { authenticate } = require('./service');
const { deliverPending } = require('../audit-alerts/github');

const loginInput = z.object({
  email: z.string().trim().max(254).email().toLowerCase(),
  password: z.string().min(1).refine((value) => !bcrypt.truncates(value), {
    message: 'Must be at most 72 bytes.',
  }),
});

async function login(req, res) {
  const input = loginInput.safeParse(req.body ?? {});
  if (!input.success) {
    const issue = input.error.issues[0];
    throw Object.assign(new Error(`${issue.path[0] ?? 'body'}: ${issue.message}`), {
      status: 400,
      code: 'VALIDATION_ERROR',
    });
  }

  const { user, rateLimited, pendingAlerts } = await authenticate({
    ...input.data,
    ip: req.ip ?? null,
    requestId: req.id,
  });
  // Repeated failures can raise a login_failures alert; open its GitHub issue now that the
  // attempt is committed. Never throws, so the 401/429 below is unchanged.
  req.pendingAlerts = pendingAlerts;
  await deliverPending(req);
  if (rateLimited) {
    throw Object.assign(new Error('Too many failed sign-in attempts. Try again later.'), {
      status: 429,
      code: 'RATE_LIMITED',
    });
  }
  if (!user) {
    throw Object.assign(new Error('Invalid email or password.'), {
      status: 401,
      code: 'UNAUTHENTICATED',
    });
  }

  await promisify(req.session.regenerate).call(req.session);
  req.session.userId = user.id;
  generateToken(req);
  await promisify(req.session.save).call(req.session);
  res.json({ user });
}

function me(req, res) {
  res.json({ user: req.user, csrfToken: generateToken(req) });
}

async function logout(req, res) {
  const { path, httpOnly, sameSite, secure } = req.session.cookie;
  await promisify(req.session.destroy).call(req.session);
  res.clearCookie('ffm.sid', { path, httpOnly, sameSite, secure });
  res.sendStatus(204);
}

module.exports = { login, me, logout };
