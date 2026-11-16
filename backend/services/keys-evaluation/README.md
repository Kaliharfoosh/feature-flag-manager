Rollout Service (S2, Habiba): `routes.js` (method + path), `controller.js` (validate with zod, status codes), `rollouts.js`, `rules.js`, `keys.js`, `evaluate.js` (data and logic, no HTTP), `__tests__/`.
Endpoints: /rollouts, /rules, /keys, /preview, /evaluations.

## For S1: `rollouts.createDefaults(tx, flagId)`

Call it in the create-flag service, on the same transaction client, right after inserting the flag:

```js
const rollouts = require('../keys-evaluation/rollouts');

await client.query('BEGIN');
const { rows: [flag] } = await client.query('INSERT INTO flags (...) VALUES (...) RETURNING id', [...]);
const environments = await rollouts.createDefaults(client, flag.id);
// environments = { dev: { percentage: 0, version: 1 }, staging: {...}, prod: {...} }
await audit.record(client, req, { action: 'flag.created', ... });
await client.query('COMMIT');
```

It inserts the three `flag_environments` rows (off) and the three `rollouts` rows (0%, version 1).
You don't need to insert `flag_environments` yourself; if you do, your rows are kept as they are.
If it throws, roll back the whole transaction so no flag is left without its rollouts.
