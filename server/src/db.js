// use Neon's POOLED connection string (host contains "-pooler")
const { Pool } = require('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3 });
module.exports = { pool };
