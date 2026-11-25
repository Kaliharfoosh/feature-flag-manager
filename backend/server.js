// Only used on your machine (npm run dev:api, and the Lab 8 scale test). Vercel never runs this file.
const app = require('./app');
// PORT lets Lab 8's scale test run several copies side by side (infra/floci/lab8/scale-test.js).
const port = Number(process.env.PORT) || 3000;
app.listen(port, () => console.log(`API on http://localhost:${port}${process.env.INSTANCE_ID ? ` (${process.env.INSTANCE_ID})` : ''}`));
