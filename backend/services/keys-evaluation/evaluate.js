// Flag evaluation (S2). Pure logic: no database, no HTTP, so it is easy to unit test.
// Used by POST /evaluations (client apps) and, later, POST /preview (the UI tool).
//
// Order (API contract): archived -> off; env disabled -> off; blocklisted -> off;
// allowlisted -> on; otherwise the user's bucket decides.
const crypto = require('node:crypto');

// 0 ... 9999. Depends ONLY on the flag key and the user id, never on the percentage, so
// raising a rollout from 25% to 50% keeps everyone who was already in.
function bucket(flagKey, userId) {
  const hash = crypto.createHash('sha256').update(`${flagKey}:${userId}`).digest();
  return hash.readUInt32BE(0) % 10000;
}

// setting = { archived, enabled, percentage, allow: [userIds], block: [userIds] }
// Returns { enabled, reason, bucket }. reason is one of: archived, disabled, blocklisted,
// allowlisted, in-percentage, out-of-percentage (the same words POST /preview will show).
function evaluate(setting, flagKey, userId) {
  const { archived = false, enabled = false, allow = [], block = [] } = setting;
  // pg returns numeric(5,2) as a string such as "25.00"; a missing rollout row means 0
  const percentage = Number(setting.percentage ?? 0);
  const userBucket = bucket(flagKey, userId);

  if (archived) return { enabled: false, reason: 'archived', bucket: userBucket };
  if (!enabled) return { enabled: false, reason: 'disabled', bucket: userBucket };
  if (block.includes(userId)) return { enabled: false, reason: 'blocklisted', bucket: userBucket };
  if (allow.includes(userId)) return { enabled: true, reason: 'allowlisted', bucket: userBucket };

  // percentage x 100 turns 25.5% into 2550 out of 10000: 0% -> nobody, 100% -> everybody
  const inside = userBucket < Math.round(percentage * 100);
  return { enabled: inside, reason: inside ? 'in-percentage' : 'out-of-percentage', bucket: userBucket };
}

module.exports = { bucket, evaluate };
