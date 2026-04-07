const { Pool } = require('pg');

const sslConfig = process.env.DATABASE_SSL
  ? { rejectUnauthorized: true, ca: process.env.DATABASE_SSL }
  : { rejectUnauthorized: false };

const pool = new Pool({
  host: process.env.DATABASE_HOST,
  port: parseInt(process.env.DATABASE_PORT, 10),
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
  ssl: sslConfig,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Unexpected PG pool error', err);
});

async function testConnection() {
  try {
    const client = await pool.connect();
    const { rows } = await client.query('SELECT current_database(), current_user');
    console.log(`Connected to Postgres: db=${rows[0].current_database}, user=${rows[0].current_user}`);
    client.release();
  } catch (err) {
    console.error('Failed to connect to Postgres:', err.message);
    console.error('Check DATABASE_HOST, DATABASE_PORT, DATABASE_USER, DATABASE_PASSWORD, DATABASE_NAME in .env');
  }
}

module.exports = pool;
module.exports.testConnection = testConnection;
