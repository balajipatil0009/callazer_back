const { Router } = require('express');
const pool = require('../db/pool');
const { normalizePhone } = require('../utils/normalize');

const router = Router();

// POST /api/calls/sync
router.post('/sync', async (req, res) => {
  const client = await pool.connect();
  try {
    const { employee_code, employee_phone, calls } = req.body;

    if (!employee_code || !employee_phone || !Array.isArray(calls) || calls.length === 0) {
      return res.status(400).json({ error: 'employee_code, employee_phone, and calls[] are required' });
    }

    const normalizedEmpPhone = normalizePhone(employee_phone);
    const syncedDeviceIds = [];

    await client.query('BEGIN');

    for (const call of calls) {
      const {
        device_call_id,
        client_phone,
        contact_name,
        start_at,
        duration,
        type,
      } = call;

      if (!device_call_id || !client_phone || !start_at || type === undefined) {
        continue;
      }

      const normalizedClientPhone = normalizePhone(client_phone);

      // Upsert client — first-writer-wins for name
      const clientResult = await client.query(
        `INSERT INTO clients (client_name, client_phone)
         VALUES ($1, $2)
         ON CONFLICT (client_phone) DO NOTHING`,
        [contact_name || null, normalizedClientPhone]
      );
      const isUnique = clientResult.rowCount > 0;

      // Insert call with dedup
      const callResult = await client.query(
        `INSERT INTO calls
           (employee_code, employee_phone, client_phone, start_at, duration, type, is_unique, device_call_id)
         VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5, $6, $7, $8)
         ON CONFLICT (employee_code, device_call_id) DO NOTHING`,
        [
          employee_code,
          normalizedEmpPhone,
          normalizedClientPhone,
          start_at,
          duration || 0,
          type,
          isUnique,
          device_call_id,
        ]
      );

      if (callResult.rowCount > 0) {
        syncedDeviceIds.push(device_call_id);
      }
    }

    // Update employee timestamps
    if (syncedDeviceIds.length > 0) {
      await client.query(
        `UPDATE employees
         SET last_call_at = NOW(), last_sync_at = NOW()
         WHERE employee_code = $1`,
        [employee_code]
      );
    } else {
      await client.query(
        `UPDATE employees SET last_sync_at = NOW() WHERE employee_code = $1`,
        [employee_code]
      );
    }

    await client.query('COMMIT');

    res.json({ synced_device_ids: syncedDeviceIds });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('POST /sync error:', err);
    res.status(500).json({ error: 'Internal server error' });
  } finally {
    client.release();
  }
});

module.exports = router;
