// Extra demo data on top of "npm run seed": more users, ~30 flags in varied states, allow/block
// rules, several API keys (one revoked) and a third team. It only ADDS rows: nothing is deleted
// or changed, and running it again skips everything that already exists.
//
// It does NOT write audit or monitoring rows. Those must come from real actions in the app
// (changes, refused requests, failed logins), so the evidence stays honest.
//
// Usage:  npm run seed:demo        (needs SEED_PASSWORD in .env; run "npm run seed" first)
// The revoked key is printed once, for security test ST-07 (it is revoked, so it is harmless).
const bcrypt = require('bcryptjs');
const { Client } = require('pg');
const { newKey } = require('../shared/api-keys');

// [key, name, description, { dev: [on, %], staging: [on, %], prod: [on, %] }, archived?]
const ACME_FLAGS = [
  ['express-shipping', 'Express shipping option', 'Next-day delivery choice at checkout.', { dev: [true, 100], staging: [true, 100], prod: [true, 30] }],
  ['gift-wrap', 'Gift wrapping', 'Optional gift wrap with a message.', { dev: [true, 100], staging: [true, 100], prod: [true, 100] }],
  ['apple-pay', 'Apple Pay', 'Pay with Apple Pay on supported devices.', { dev: [true, 100], staging: [true, 50], prod: [false, 0] }],
  ['google-pay', 'Google Pay', 'Pay with Google Pay on supported devices.', { dev: [true, 100], staging: [true, 50], prod: [false, 0] }],
  ['product-reviews-v2', 'Product reviews v2', 'Photo reviews and helpful votes.', { dev: [true, 100], staging: [true, 25], prod: [false, 0] }],
  ['wishlist-sharing', 'Wishlist sharing', 'Share a wishlist with a link.', { dev: [true, 100], staging: [false, 0], prod: [false, 0] }],
  ['live-chat', 'Live chat support', 'Chat widget on product and checkout pages.', { dev: [true, 100], staging: [true, 100], prod: [true, 10] }],
  ['recommendations-ml', 'ML recommendations', 'Recommended products from the new model.', { dev: [true, 100], staging: [true, 10], prod: [false, 0] }],
  ['size-guide', 'Interactive size guide', 'Size finder for clothing.', { dev: [true, 100], staging: [true, 100], prod: [true, 100] }],
  ['stock-alerts', 'Back-in-stock alerts', 'Email shoppers when an item is back.', { dev: [true, 100], staging: [true, 75], prod: [true, 20] }],
  ['promo-banner-winter', 'Winter promo banner', 'Seasonal banner on the home page.', { dev: [true, 100], staging: [true, 100], prod: [true, 100] }],
  ['loyalty-tiers', 'Loyalty tiers', 'Silver / gold / platinum rewards.', { dev: [true, 100], staging: [false, 0], prod: [false, 0] }],
  ['one-click-reorder', 'One-click reorder', 'Reorder a past order in one click.', { dev: [true, 50], staging: [false, 0], prod: [false, 0] }],
  ['address-autocomplete', 'Address autocomplete', 'Postcode lookup at checkout.', { dev: [true, 100], staging: [true, 100], prod: [true, 50] }],
  ['currency-switcher', 'Currency switcher', 'Show prices in EUR and USD.', { dev: [true, 100], staging: [true, 30], prod: [false, 0] }],
  ['guest-checkout', 'Guest checkout', 'Buy without creating an account.', { dev: [true, 100], staging: [true, 100], prod: [true, 100] }],
  ['order-tracking-map', 'Order tracking map', 'Live courier location on a map.', { dev: [true, 100], staging: [true, 5], prod: [false, 0] }],
  ['returns-portal', 'Self-service returns', 'Start a return without contacting support.', { dev: [true, 100], staging: [true, 100], prod: [true, 40] }],
  ['bundle-discounts', 'Bundle discounts', 'Buy 3, save 10%.', { dev: [false, 0], staging: [false, 0], prod: [false, 0] }],
  ['dark-mode-emails', 'Dark mode emails', 'Order emails that respect dark mode.', { dev: [true, 100], staging: [false, 0], prod: [false, 0] }],
  ['search-filters-v2', 'Search filters v2', 'Faceted filters on search results.', { dev: [true, 100], staging: [true, 60], prod: [true, 15] }],
  ['newsletter-popup', 'Newsletter popup', 'Sign-up popup after 30 seconds.', { dev: [true, 100], staging: [true, 100], prod: [false, 0] }],
  ['cart-reminders', 'Abandoned cart reminders', 'Email after 24 hours of an unpaid basket.', { dev: [true, 100], staging: [true, 100], prod: [true, 25] }],
  ['store-locator', 'Store locator', 'Find a shop near you.', { dev: [true, 100], staging: [true, 100], prod: [true, 100] }],
  ['black-friday-2025', 'Black Friday 2025', 'Last year\'s sale pages.', { dev: [false, 0], staging: [false, 0], prod: [false, 0] }, true],
  ['old-header', 'Old site header', 'Replaced by the new navigation.', { dev: [false, 0], staging: [false, 0], prod: [false, 0] }, true],
  ['paypal-v1', 'PayPal v1 integration', 'Replaced by PayPal v2.', { dev: [false, 0], staging: [false, 0], prod: [false, 0] }, true],
];

const TEAMS = [
  {
    name: 'Acme Web',
    users: [
      { email: 'omar.admin@acme.test', name: 'Omar Admin', role: 'admin' },
      { email: 'sara.dev@acme.test', name: 'Sara Developer', role: 'developer' },
      { email: 'lina.dev@acme.test', name: 'Lina Developer', role: 'developer' },
    ],
    flags: ACME_FLAGS,
    // [flag key, env, user id, kind]
    rules: [
      ['new-checkout', 'staging', 'u-beta-1', 'allow'],
      ['new-checkout', 'staging', 'u-beta-2', 'allow'],
      ['new-checkout', 'staging', 'u-fraud-77', 'block'],
      ['apple-pay', 'staging', 'qa-iphone-1', 'allow'],
      ['recommendations-ml', 'staging', 'data-team-1', 'allow'],
      ['live-chat', 'prod', 'vip-1001', 'allow'],
      ['express-shipping', 'prod', 'u-banned-3', 'block'],
    ],
    // [name, env, revoked?]
    keys: [
      ['Storefront dev', 'dev', false],
      ['Mobile app staging', 'staging', false],
      ['Storefront prod', 'prod', false],
      ['Old storefront key (leaked, revoked)', 'staging', true],
    ],
  },
  {
    name: 'Globex',
    users: [{ email: 'dev@globex.test', name: 'Gina Globex', role: 'developer' }],
    flags: [
      ['points-multiplier', 'Points multiplier', 'Double points weekends.', { dev: [true, 100], staging: [true, 50], prod: [false, 0] }],
      ['partner-offers', 'Partner offers', 'Offers from partner brands.', { dev: [true, 100], staging: [false, 0], prod: [false, 0] }],
    ],
    rules: [],
    keys: [['Globex staging', 'staging', false]],
  },
  {
    name: 'Initech',
    users: [
      { email: 'admin@initech.test', name: 'Ines Initech', role: 'admin' },
      { email: 'dev@initech.test', name: 'Ivan Initech', role: 'developer' },
    ],
    flags: [
      ['tps-reports-v2', 'TPS reports v2', 'New report cover sheet.', { dev: [true, 100], staging: [true, 100], prod: [true, 50] }],
      ['printer-queue', 'Printer queue', 'Queue print jobs from the browser.', { dev: [true, 100], staging: [false, 0], prod: [false, 0] }],
      ['stapler-tracking', 'Stapler tracking', 'Know where every stapler is.', { dev: [false, 0], staging: [false, 0], prod: [false, 0] }],
    ],
    rules: [['tps-reports-v2', 'prod', 'u-lumbergh', 'block']],
    keys: [['Initech intranet staging', 'staging', false]],
  },
];

const ENVS = ['dev', 'staging', 'prod'];

async function seedDemo(connectionString, password, { quiet = false } = {}) {
  if (!password || password.length < 12) throw new Error('SEED_PASSWORD must be at least 12 characters.');
  if (bcrypt.truncates(password)) throw new Error('SEED_PASSWORD must be at most 72 bytes.');
  const say = (msg) => { if (!quiet) console.log(msg); };
  const counts = { teams: 0, users: 0, flags: 0, rules: 0, keys: 0 };
  let revokedKey = null;
  const hash = await bcrypt.hash(password, 12);

  const client = new Client({ connectionString });
  await client.connect();
  try {
    await client.query('BEGIN');
    for (const team of TEAMS) {
      let { rows: [t] } = await client.query('SELECT id FROM teams WHERE name = $1', [team.name]);
      if (!t) {
        ({ rows: [t] } = await client.query('INSERT INTO teams (name) VALUES ($1) RETURNING id', [team.name]));
        for (const rule of ['prod_change', 'key_change', 'login_failures']) {
          await client.query('INSERT INTO alert_rules (team_id, rule, enabled) VALUES ($1, $2, true) ON CONFLICT DO NOTHING', [t.id, rule]);
        }
        counts.teams += 1;
      }

      for (const u of team.users) {
        const { rowCount } = await client.query(
          `INSERT INTO users (team_id, email, name, password_hash, role)
           SELECT $1, $2, $3, $4, $5 WHERE NOT EXISTS (SELECT 1 FROM users WHERE lower(email) = lower($2))`,
          [t.id, u.email, u.name, hash, u.role],
        );
        counts.users += rowCount;
      }
      const { rows: [admin] } = await client.query(
        "SELECT id FROM users WHERE team_id = $1 AND role = 'admin' ORDER BY created_at LIMIT 1", [t.id],
      );

      for (const [key, name, description, envs, archived] of team.flags) {
        const { rows: [flag] } = await client.query(
          `INSERT INTO flags (team_id, key, name, description, created_by, archived_at)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (team_id, key) DO NOTHING RETURNING id`,
          [t.id, key, name, description, admin?.id ?? null, archived ? new Date() : null],
        );
        if (!flag) continue; // already there: leave it exactly as it is
        for (const env of ENVS) {
          const [enabled, percentage] = envs[env];
          await client.query('INSERT INTO flag_environments (flag_id, env, enabled) VALUES ($1, $2, $3)', [flag.id, env, enabled]);
          await client.query('INSERT INTO rollouts (flag_id, env, percentage) VALUES ($1, $2, $3)', [flag.id, env, percentage]);
        }
        counts.flags += 1;
      }

      for (const [flagKey, env, userId, kind] of team.rules) {
        const { rows: [flag] } = await client.query('SELECT id FROM flags WHERE team_id = $1 AND key = $2', [t.id, flagKey]);
        if (!flag) continue;
        // The seed flags from "npm run seed" may lack an environment row; rules need one.
        await client.query('INSERT INTO flag_environments (flag_id, env) VALUES ($1, $2) ON CONFLICT DO NOTHING', [flag.id, env]);
        const { rowCount } = await client.query(
          'INSERT INTO user_rules (flag_id, env, user_id, kind) VALUES ($1, $2, $3, $4) ON CONFLICT (flag_id, env, user_id) DO NOTHING',
          [flag.id, env, userId, kind],
        );
        counts.rules += rowCount;
      }

      for (const [name, env, revoked] of team.keys) {
        const { rows: [exists] } = await client.query('SELECT 1 FROM api_keys WHERE team_id = $1 AND name = $2', [t.id, name]);
        if (exists) continue;
        // The raw key is thrown away (only its hash is stored), except the revoked one, which
        // is printed so ST-07 can show that a revoked key gets 401.
        const key = newKey(env);
        await client.query(
          `INSERT INTO api_keys (team_id, env, name, prefix, key_hash, created_by, revoked_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [t.id, env, name, key.prefix, key.keyHash, admin?.id ?? null, revoked ? new Date() : null],
        );
        if (revoked) revokedKey = key.raw;
        counts.keys += 1;
      }
      say(`team "${team.name}" done`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    await client.end();
  }
  return { counts, revokedKey };
}

module.exports = { seedDemo };

if (require.main === module) {
  const url = process.env.DATABASE_URL_MIGRATE || process.env.DATABASE_URL;
  if (!url) { console.error('Set DATABASE_URL in .env first.'); process.exit(1); }
  seedDemo(url, process.env.SEED_PASSWORD).then(({ counts, revokedKey }) => {
    console.log(`Added: ${counts.teams} teams, ${counts.users} users, ${counts.flags} flags, ${counts.rules} rules, ${counts.keys} keys.`);
    console.log('New users sign in with SEED_PASSWORD (same as admin@acme.test).');
    if (revokedKey) {
      console.log('\nRevoked staging key for ST-07 (already revoked, so it only ever gets 401):');
      console.log(revokedKey);
    }
  }, (err) => { console.error(err.message); process.exit(1); });
}
