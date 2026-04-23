const { Router } = require('express');
const pool = require('../db/pool');
const { normalizePhone } = require('../utils/normalize');

const router = Router();

// POST /api/calls/sync
router.post('/sync', async (req, res) => {
  console.log("calls sync request received");
  
  const client = await pool.connect();
  try {
    const { employee_code, employee_phone, calls } = req.body;

    if (!employee_code || !employee_phone || !Array.isArray(calls) || calls.length === 0) {
      return res.status(400).json({ error: 'employee_code, employee_phone, and calls[] are required' });
    }

    const normalizedEmpPhone = normalizePhone(employee_phone);
    if (!normalizedEmpPhone) {
      return res.status(400).json({ error: 'employee_phone must contain a valid number' });
    }

    const syncedDeviceIds = [];
    let insertedCount = 0;
    let ackedDuplicateCount = 0;

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
        console.log('Invalid call data:', call);
        continue;
      }

      const normalizedClientPhone = normalizePhone(client_phone);
      if (!normalizedClientPhone) {
        console.log('Skipping call — empty client_phone after normalize', device_call_id);
        continue;
      }


      // Upsert client — first-writer-wins for name
      const clientResult = await client.query(
        `INSERT INTO clients (client_name, client_phone)
         VALUES ($1, $2)
         ON CONFLICT (client_phone) DO NOTHING`,
        [contact_name || null, normalizedClientPhone]
      );
      const isUnique = clientResult.rowCount > 0;

      // Insert call with dedup. We RETURN on insert to distinguish a fresh
      // write from a conflict; on conflict we fall back to a SELECT so we can
      // still acknowledge the device_call_id to the client. Without this ack
      // the client's queue would never mark the row synced and would keep
      // re-uploading the same call forever.
      const callResult = await client.query(
        `INSERT INTO calls
           (employee_code, employee_phone, client_phone, start_at, duration, type, is_unique, device_call_id)
         VALUES ($1, $2, $3, to_timestamp($4 / 1000.0), $5, $6, $7, $8)
         ON CONFLICT (employee_code, device_call_id) DO NOTHING
         RETURNING device_call_id`,
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
        insertedCount++;
        console.log('inserted call', client_phone, duration, device_call_id);
      } else {
        const existing = await client.query(
          `SELECT 1 FROM calls WHERE employee_code = $1 AND device_call_id = $2`,
          [employee_code, device_call_id]
        );
        if (existing.rowCount > 0) {
          syncedDeviceIds.push(device_call_id);
          ackedDuplicateCount++;
        }
      }
    }

    // Update employee timestamps and latest known phone. last_call_at only
    // advances when we actually wrote a new row — ack'd duplicates don't count.
    if (insertedCount > 0) {
      await client.query(
        `UPDATE employees
         SET last_call_at = NOW(), last_sync_at = NOW(), employee_phone = $2
         WHERE employee_code = $1`,
        [employee_code, normalizedEmpPhone]
      );
    } else {
      await client.query(
        `UPDATE employees SET last_sync_at = NOW(), employee_phone = $2 WHERE employee_code = $1`,
        [employee_code, normalizedEmpPhone]
      );
    }

    await client.query('COMMIT');

    console.log(
      `sync ${employee_code}: received=${calls.length} inserted=${insertedCount} acked_duplicate=${ackedDuplicateCount}`
    );

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
