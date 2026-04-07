const { Router } = require('express');
const pool = require('../db/pool');

const router = Router();

// POST /api/employees/register
router.post('/register', async (req, res) => {
  try {
    const { employee_code, employee_name, model_name, app_version } = req.body;

    if (!employee_code || !employee_name) {
      return res.status(400).json({ error: 'employee_code and employee_name are required' });
    }

    const { rows } = await pool.query(
      `INSERT INTO employees (employee_code, employee_name, model_name, app_version, registered_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (employee_code) DO UPDATE SET
         employee_name = EXCLUDED.employee_name,
         model_name = EXCLUDED.model_name,
         app_version = EXCLUDED.app_version
       RETURNING *`,
      [employee_code, employee_name, model_name || null, app_version || null]
    );

    res.json({ employee: rows[0] });
  } catch (err) {
    console.error('POST /register error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/employees/heartbeat
router.post('/heartbeat', async (req, res) => {
  try {
    const { employee_code } = req.body;

    if (!employee_code) {
      return res.status(400).json({ error: 'employee_code is required' });
    }

    await pool.query(
      `UPDATE employees SET last_sync_at = NOW() WHERE employee_code = $1`,
      [employee_code]
    );

    res.json({ ok: true });
  } catch (err) {
    console.error('POST /heartbeat error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
