// One small pg Pool per function instance. Use Neon's POOLED connection string
// (the host contains "-pooler") so many cold-started instances do not exhaust Neon.
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
module.exports = { pool };
