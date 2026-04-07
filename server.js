require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

const pool = require('./db/pool');
const { testConnection } = pool;
const employeesRouter = require('./routes/employees');
const callsRouter = require('./routes/calls');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.use('/api/employees', employeesRouter);
app.use('/api/calls', callsRouter);

app.get('/health', (_req, res) => res.json({ ok: true }));

// Run schema.sql to create all tables, enums, and indexes
// app.post('/api/setup', async (_req, res) => {
//   try {
//     const schemaPath = path.join(__dirname, 'db', 'schema.sql');
//     const sql = fs.readFileSync(schemaPath, 'utf8');
//     await pool.query(sql);
//     res.json({ ok: true, message: 'Schema created successfully' });
//   } catch (err) {
//     // 42710 = type already exists, 42P07 = relation already exists
//     if (err.code === '42710' || err.code === '42P07') {
//       res.json({ ok: true, message: 'Schema already exists (some objects skipped)' });
//     } else {
//       console.error('POST /api/setup error:', err);
//       res.status(500).json({ error: err.message });
//     }
//   }
// });

app.listen(PORT, async () => {
  console.log(`Callazer backend listening on port ${PORT}`);
  await testConnection();
});
