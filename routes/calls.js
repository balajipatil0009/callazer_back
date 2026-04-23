const { Router } = require('express');
const pool = require('../db/pool');
const { normalizePhone } = require('../utils/normalize');

const router = Router();

// POST /api/calls/sync
//
// Bulk path: one client upsert, one call insert, one duplicate-check SELECT —
// regardless of how many calls are in the batch. Previously this route did
// ~2–3 DB round trips PER call inside a single transaction, which made a
// 237-call catch-up sync take ~2 minutes and caused the Android client to
// time out before it could mark any row synced (leading to the "acked_duplicate
// keeps growing" infinite retry loop).
router.post('/sync', async (req, res) => {
  const startedAt = Date.now();
  console.log('calls sync request received');

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

    // 1. Validate + normalize up-front. Drop malformed rows so the bulk
    //    statements don't have to deal with them.
    const valid = [];
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

      const normClientPhone = normalizePhone(client_phone);
      if (!normClientPhone) {
        console.log('Skipping call — empty client_phone after normalize', device_call_id);
        continue;
      }

      valid.push({
        device_call_id: Number(device_call_id),
        client_phone: normClientPhone,
        contact_name: contact_name || null,
        start_at: Number(start_at),
        duration: Number(duration || 0),
        type,
      });
    }

    if (valid.length === 0) {
      return res.json({ synced_device_ids: [] });
    }

    await client.query('BEGIN');

    // 2. Bulk upsert clients. Deduplicate client_phone within the batch so we
    //    can correctly compute `is_unique` (first-writer-wins semantics
    //    matching the old per-row logic).
    const clientPhoneToName = new Map();
    for (const c of valid) {
      if (!clientPhoneToName.has(c.client_phone)) {
        clientPhoneToName.set(c.client_phone, c.contact_name);
      }
    }
    const uniquePhones = Array.from(clientPhoneToName.keys());
    const uniqueNames = uniquePhones.map((p) => clientPhoneToName.get(p));

    const clientIns = await client.query(
      `INSERT INTO clients (client_name, client_phone)
       SELECT n, p FROM UNNEST($1::text[], $2::text[]) AS t(n, p)
       ON CONFLICT (client_phone) DO NOTHING
       RETURNING client_phone`,
      [uniqueNames, uniquePhones]
    );
    const newClientPhones = new Set(clientIns.rows.map((r) => r.client_phone));

    // 3. Compute per-call is_unique: the FIRST call in this batch for a NEW
    //    client phone is unique; everything else is not.
    const seenInBatch = new Set();
    for (const c of valid) {
      if (newClientPhones.has(c.client_phone) && !seenInBatch.has(c.client_phone)) {
        c.is_unique = true;
      } else {
        c.is_unique = false;
      }
      seenInBatch.add(c.client_phone);
    }

    // 4. Bulk insert calls. Postgres's multi-array UNNEST parallel-unzips our
    //    column arrays into rows, then ON CONFLICT dedupes and RETURNING tells
    //    us exactly which device_call_ids were newly inserted.
    const deviceCallIds = valid.map((c) => c.device_call_id);
    const clientPhones = valid.map((c) => c.client_phone);
    const startAts = valid.map((c) => c.start_at);
    const durations = valid.map((c) => c.duration);
    const types = valid.map((c) => c.type);
    const isUniques = valid.map((c) => c.is_unique);

    const callIns = await client.query(
      `INSERT INTO calls
         (employee_code, employee_phone, client_phone, start_at, duration, type, is_unique, device_call_id)
       SELECT $1, $2, cp, to_timestamp(sa / 1000.0), d, ct::call_type, u, dci
       FROM UNNEST(
              $3::text[],
              $4::bigint[],
              $5::int[],
              $6::text[],
              $7::bool[],
              $8::bigint[]
            ) AS t(cp, sa, d, ct, u, dci)
       ON CONFLICT (employee_code, device_call_id) DO NOTHING
       RETURNING device_call_id`,
      [
        employee_code,
        normalizedEmpPhone,
        clientPhones,
        startAts,
        durations,
        types,
        isUniques,
        deviceCallIds,
      ]
    );
    const insertedIds = new Set(callIns.rows.map((r) => Number(r.device_call_id)));
    const insertedCount = insertedIds.size;

    // 5. Any id not inserted is either a duplicate of a row that was already
    //    on the server, OR it was rejected for some reason. Confirm with a
    //    single bulk SELECT and ack the ones that actually exist — this is
    //    the critical part that prevents the client from retrying forever.
    const remainingIds = deviceCallIds.filter((id) => !insertedIds.has(id));
    let duplicateIds = [];
    if (remainingIds.length > 0) {
      const dupRes = await client.query(
        `SELECT device_call_id FROM calls
         WHERE employee_code = $1 AND device_call_id = ANY($2::bigint[])`,
        [employee_code, remainingIds]
      );
      duplicateIds = dupRes.rows.map((r) => Number(r.device_call_id));
    }
    const ackedDuplicateCount = duplicateIds.length;

    const syncedDeviceIds = [...insertedIds, ...duplicateIds];

    // 6. Update employee timestamps. last_call_at only advances when we
    //    actually wrote a new row.
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

    for (const c of valid) {
      if (insertedIds.has(c.device_call_id)) {
        console.log('inserted call', c.client_phone, c.duration, c.device_call_id);
      }
    }
    console.log(
      `sync ${employee_code}: received=${calls.length} inserted=${insertedCount} ` +
        `acked_duplicate=${ackedDuplicateCount} took=${Date.now() - startedAt}ms`
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
