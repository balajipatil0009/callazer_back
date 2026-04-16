const { Router } = require('express');
const pool = require('../db/pool');
const {
  formatDurationHms,
  formatAvgDuration,
  mapCallRow,
} = require('../utils/formatters');
const {
  todayRange,
  yesterdayRange,
  lastWeekRange,
  lastMonthRange,
  formatIstDateLabel,
  formatRangeLabel,
  ymdInIST,
  addDaysYmd,
} = require('../utils/ist');

const router = Router();

/**
 * Parse employee_code / employee_codes query params.
 * - employee_code (single) takes priority if set.
 * - employee_codes (comma-separated) is used otherwise.
 * Returns { empClause, empParams } to splice into SQL.
 * empClause is a SQL fragment, empParams is the array of values for the next param index.
 */
function resolveEmployeeFilter(query, paramIdx) {
  const single = query.employee_code || null;
  const multi = query.employee_codes ? query.employee_codes.split(',').map(s => s.trim()).filter(Boolean) : null;

  if (single) {
    return {
      empClause: `($${paramIdx}::text IS NULL OR c.employee_code = $${paramIdx})`,
      empParams: [single],
    };
  }
  if (multi && multi.length > 0) {
    return {
      empClause: `c.employee_code = ANY($${paramIdx}::text[])`,
      empParams: [multi],
    };
  }
  return {
    empClause: 'TRUE',
    empParams: [],
  };
}

/** datetime-local values without TZ → interpret as Asia/Kolkata */
function parseFilterStart(s) {
  if (!s) return null;
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(s)) return new Date(s);
  const base = s.length === 16 ? `${s}:00` : s;
  return new Date(`${base}+05:30`);
}

function parseFilterEnd(s) {
  if (!s) return null;
  if (/[zZ]$|[+-]\d{2}:\d{2}$/.test(s)) return new Date(s);
  const base = s.length === 16 ? `${s}:59.999` : s;
  return new Date(`${base}+05:30`);
}

async function queryPeriodStats(start, end, empFilter) {
  const { empClause, empParams } = empFilter || { empClause: 'TRUE', empParams: [] };
  const sql = `
    SELECT
      COUNT(*)::int AS total_calls,
      COALESCE(SUM(c.duration), 0)::bigint AS total_duration_sec,
      COUNT(*) FILTER (WHERE c.type = 'incoming')::int AS incoming,
      COALESCE(SUM(c.duration) FILTER (WHERE c.type = 'incoming'), 0)::bigint AS incoming_dur,
      COUNT(*) FILTER (WHERE c.type = 'outgoing')::int AS outgoing,
      COALESCE(SUM(c.duration) FILTER (WHERE c.type = 'outgoing'), 0)::bigint AS outgoing_dur,
      COUNT(*) FILTER (WHERE c.type = 'missed')::int AS missed,
      COUNT(*) FILTER (WHERE c.type = 'rejected')::int AS rejected,
      COUNT(*) FILTER (WHERE c.type = 'missed')::int AS never_attended,
      COUNT(*) FILTER (WHERE c.type = 'not_pickup')::int AS not_pickup,
      COUNT(DISTINCT c.client_phone)::int AS unique_clients,
      COALESCE(SUM(c.duration) FILTER (WHERE c.duration > 0 AND c.type IN ('incoming', 'outgoing')), 0)::bigint AS working_sec,
      COUNT(*) FILTER (WHERE c.duration > 0 AND c.type IN ('incoming', 'outgoing'))::int AS connected_calls
    FROM calls c
    WHERE c.start_at >= $1 AND c.start_at < $2
      AND (${empClause})
  `;
  const { rows } = await pool.query(sql, [start, end, ...empParams]);
  return rows[0];
}

function shapeDashboardPeriod(row, label, dateLabel) {
  return {
    label,
    dateLabel,
    totalCalls: row.total_calls,
    callDuration: formatDurationHms(Number(row.total_duration_sec)),
    incoming: row.incoming,
    incomingDuration: formatDurationHms(Number(row.incoming_dur)),
    outgoing: row.outgoing,
    outgoingDuration: formatDurationHms(Number(row.outgoing_dur)),
    missed: row.missed,
    rejected: row.rejected,
    neverAttended: row.never_attended,
    notPickupByClient: row.not_pickup,
    uniqueClients: row.unique_clients,
    workingHours: formatDurationHms(Number(row.working_sec)),
    connectedCalls: row.connected_calls,
  };
}

// GET /api/web/dashboard/stats?employee_codes=EMP1,EMP2
router.get('/dashboard/stats', async (req, res) => {
  try {
    const empFilter = resolveEmployeeFilter(req.query, 3);
    const t = todayRange();
    const y = yesterdayRange();
    const w = lastWeekRange();
    const m = lastMonthRange();

    const [todayRow, yRow, wRow, mRow] = await Promise.all([
      queryPeriodStats(t.start, t.end, empFilter),
      queryPeriodStats(y.start, y.end, empFilter),
      queryPeriodStats(w.start, w.end, empFilter),
      queryPeriodStats(m.start, m.end, empFilter),
    ]);

    res.json({
      today: shapeDashboardPeriod(todayRow, 'Today', formatIstDateLabel(t.start)),
      yesterday: shapeDashboardPeriod(yRow, 'Yesterday', formatIstDateLabel(y.start)),
      lastWeek: shapeDashboardPeriod(
        wRow,
        'Last Week',
        formatRangeLabel(w.labelYmd.from, w.labelYmd.to)
      ),
      lastMonth: shapeDashboardPeriod(
        mRow,
        'Last 30 days',
        formatRangeLabel(addDaysYmd(ymdInIST(), -30), addDaysYmd(ymdInIST(), -1))
      ),
    });
  } catch (err) {
    console.error('GET /api/web/dashboard/stats', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function defaultReportRange() {
  const today = ymdInIST();
  const from = addDaysYmd(today, -6);
  return {
    start: parseFilterStart(`${from}T00:00`),
    end: parseFilterEnd(`${today}T23:59`),
  };
}

function resolveReportRange(query) {
  let start = query.from ? parseFilterStart(query.from) : null;
  let end = query.to ? parseFilterEnd(query.to) : null;
  if (!start || !end || start >= end) {
    const d = defaultReportRange();
    start = d.start;
    end = d.end;
  }
  return { start, end };
}

// GET /api/web/reports/periodic-summary?from=&to=&employee_code=&employee_codes=&call_type=
router.get('/reports/periodic-summary', async (req, res) => {
  try {
    const { start, end } = resolveReportRange(req.query);
    const callType = req.query.call_type || 'All';
    const { empClause, empParams } = resolveEmployeeFilter(req.query, 3);

    const ct = callTypeParam(callType);
    const typeClause = callTypeSqlClause(ct || 'All');
    const sql = `
      SELECT c.type, c.duration, c.client_phone, e.employee_name
      FROM calls c
      JOIN employees e ON e.employee_code = c.employee_code
      WHERE c.start_at >= $1 AND c.start_at <= $2
        AND (${empClause})
        AND (${typeClause})
    `;
    const { rows } = await pool.query(sql, [start, end, ...empParams]);

    const filtered = rows;

    const incoming = filtered.filter((r) => r.type === 'incoming');
    const outgoing = filtered.filter((r) => r.type === 'outgoing' || r.type === 'not_pickup');
    const missed = filtered.filter((r) => r.type === 'missed');
    const rejected = filtered.filter((r) => r.type === 'rejected');

    const sumDur = (arr) => arr.reduce((s, r) => s + (Number(r.duration) || 0), 0);

    const callTypes = [
      { type: 'Incoming', calls: incoming.length, duration: formatDurationHms(sumDur(incoming)) },
      { type: 'Outgoing', calls: outgoing.length, duration: formatDurationHms(sumDur(outgoing)) },
      { type: 'Missed', calls: missed.length, duration: formatDurationHms(sumDur(missed)) },
      { type: 'Rejected', calls: rejected.length, duration: formatDurationHms(sumDur(rejected)) },
    ];

    const pieData = [
      { name: 'Incoming', value: incoming.length, color: '#22c55e' },
      { name: 'Outgoing', value: outgoing.length, color: '#f59e0b' },
      { name: 'Missed', value: missed.length, color: '#ef4444' },
      { name: 'Rejected', value: rejected.length, color: '#64748b' },
    ];

    const dur = (r) => Number(r.duration) || 0;
    const connectedRows = filtered.filter(
      (r) => dur(r) > 0 && (r.type === 'incoming' || r.type === 'outgoing')
    );
    const workingSeconds = connectedRows.reduce((s, r) => s + dur(r), 0);
    const uniqueClientPhones = new Set(filtered.map((r) => r.client_phone).filter(Boolean));
    const uniqueConnectedPhones = new Set(
      connectedRows.map((r) => r.client_phone).filter(Boolean)
    );

    res.json({
      callTypes,
      kpis: {
        neverAttended: filtered.filter((r) => r.type === 'missed').length,
        notPickupByClient: filtered.filter((r) => r.type === 'not_pickup').length,
        connectedCalls: connectedRows.length,
        uniqueConnectedCalls: uniqueConnectedPhones.size,
        uniqueClients: uniqueClientPhones.size,
        workingHours: formatDurationHms(workingSeconds),
      },
      pieData,
    });
  } catch (err) {
    console.error('GET /api/web/reports/periodic-summary', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/web/reports/day-wise
router.get('/reports/day-wise', async (req, res) => {
  try {
    const { start, end } = resolveReportRange(req.query);
    const callType = req.query.call_type || 'All';
    const { empClause, empParams } = resolveEmployeeFilter(req.query, 3);

    const ct = callTypeParam(callType);
    const typeClause = callTypeSqlClause(ct || 'All');
    const sql = `
      SELECT c.start_at, c.type
      FROM calls c
      WHERE c.start_at >= $1 AND c.start_at <= $2
        AND (${empClause})
        AND (${typeClause})
      ORDER BY c.start_at
    `;
    const { rows } = await pool.query(sql, [start, end, ...empParams]);

    const map = new Map();
    for (const r of rows) {
      const key = new Date(r.start_at).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: 'short',
        timeZone: 'Asia/Kolkata',
      });
      map.set(key, (map.get(key) || 0) + 1);
    }

    res.json([...map.entries()].map(([day, calls]) => ({ day, calls })));
  } catch (err) {
    console.error('GET /api/web/reports/day-wise', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/web/reports/hourly
router.get('/reports/hourly', async (req, res) => {
  try {
    const { start, end } = resolveReportRange(req.query);
    const callType = req.query.call_type || 'All';
    const { empClause, empParams } = resolveEmployeeFilter(req.query, 3);

    const ct = callTypeParam(callType);
    const typeClause = callTypeSqlClause(ct || 'All');
    const sql = `
      SELECT c.start_at, c.type
      FROM calls c
      WHERE c.start_at >= $1 AND c.start_at <= $2
        AND (${empClause})
        AND (${typeClause})
    `;
    const { rows } = await pool.query(sql, [start, end, ...empParams]);

    const map = new Map();
    for (const r of rows) {
      const hour = new Date(r.start_at).toLocaleTimeString('en-IN', {
        hour: 'numeric',
        hour12: true,
        timeZone: 'Asia/Kolkata',
      });
      map.set(hour, (map.get(hour) || 0) + 1);
    }

    res.json([...map.entries()].map(([hour, calls]) => ({ hour, calls })));
  } catch (err) {
    console.error('GET /api/web/reports/hourly', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/web/reports/employees
router.get('/reports/employees', async (req, res) => {
  try {
    const { start, end } = resolveReportRange(req.query);
    const callType = req.query.call_type || 'All';
    const typeClause = callTypeSqlClause(callTypeParam(callType) || 'All');
    const { empClause, empParams } = resolveEmployeeFilter(req.query, 3);

    const sql = `
      SELECT
        e.employee_name,
        COUNT(*)::int AS total_calls,
        COUNT(*) FILTER (WHERE c.type = 'incoming')::int AS incoming,
        COUNT(*) FILTER (WHERE c.type IN ('outgoing', 'not_pickup'))::int AS outgoing,
        COUNT(*) FILTER (WHERE c.type = 'missed')::int AS missed,
        COUNT(*) FILTER (WHERE c.type = 'missed')::int AS never_attended,
        COUNT(*) FILTER (WHERE c.type = 'not_pickup')::int AS not_pickup,
        COALESCE(SUM(c.duration), 0)::bigint AS total_duration
      FROM calls c
      JOIN employees e ON e.employee_code = c.employee_code
      WHERE c.start_at >= $1 AND c.start_at <= $2
        AND (${empClause})
        AND (${typeClause})
      GROUP BY e.employee_code, e.employee_name
      ORDER BY e.employee_name
    `;
    const { rows } = await pool.query(sql, [start, end, ...empParams]);

    res.json(
      rows.map((r) => ({
        employeeName: r.employee_name,
        totalCalls: r.total_calls,
        incoming: r.incoming,
        outgoing: r.outgoing,
        missed: r.missed,
        neverAttended: r.never_attended,
        notPickupByClient: r.not_pickup,
        avgDuration: formatAvgDuration(Number(r.total_duration), r.total_calls),
      }))
    );
  } catch (err) {
    console.error('GET /api/web/reports/employees', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/web/reports/clients
router.get('/reports/clients', async (req, res) => {
  try {
    const { start, end } = resolveReportRange(req.query);
    const callType = req.query.call_type || 'All';
    const typeClause = callTypeSqlClause(callTypeParam(callType) || 'All');
    const { empClause, empParams } = resolveEmployeeFilter(req.query, 3);

    const sql = `
      SELECT
        cl.client_name,
        c.client_phone,
        COUNT(*)::int AS total_calls,
        MAX(c.start_at) AS last_start,
        COUNT(*) FILTER (WHERE c.duration > 0 AND c.type IN ('incoming', 'outgoing'))::int AS connected,
        COUNT(*) FILTER (WHERE c.type = 'missed')::int AS missed,
        COUNT(*) FILTER (WHERE c.type = 'not_pickup')::int AS not_pickup
      FROM calls c
      JOIN clients cl ON cl.client_phone = c.client_phone
      WHERE c.start_at >= $1 AND c.start_at <= $2
        AND (${empClause})
        AND (${typeClause})
      GROUP BY c.client_phone, cl.client_name
      ORDER BY total_calls DESC
    `;
    const { rows } = await pool.query(sql, [start, end, ...empParams]);

    res.json(
      rows.map((r) => ({
        clientName: r.client_name || '—',
        clientPhone: r.client_phone,
        totalCalls: r.total_calls,
        lastContact: new Date(r.last_start).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
        connected: r.connected,
        missed: r.missed,
        notPickup: r.not_pickup,
      }))
    );
  } catch (err) {
    console.error('GET /api/web/reports/clients', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

function callTypeSqlClause(callType) {
  if (callType === 'All' || !callType) return 'TRUE';
  if (callType === 'Incoming') return `c.type = 'incoming'`;
  if (callType === 'Outgoing') return `c.type IN ('outgoing', 'not_pickup')`;
  if (callType === 'Missed') return `c.type = 'missed'`;
  if (callType === 'Rejected') return `c.type = 'rejected'`;
  return 'TRUE';
}

function callTypeParam(callType) {
  const ct = callType || 'All';
  return ct === 'All' ? null : ct;
}

function statusSqlClause(status) {
  if (!status || status === 'all') return 'TRUE';
  if (status === 'never_attended') return `c.type = 'missed'`;
  if (status === 'not_pickup') return `c.type = 'not_pickup'`;
  return 'TRUE';
}

// GET /api/web/calls?from=&to=&employee_code=&employee_codes=&call_type=&limit=&offset=
router.get('/calls', async (req, res) => {
  try {
    const { start, end } = resolveReportRange(req.query);
    const callType = req.query.call_type || 'All';
    const status = (req.query.status || 'all').toLowerCase();
    const limit = Math.min(Number(req.query.limit) || 500, 2000);
    const offset = Number(req.query.offset) || 0;
    const { empClause, empParams } = resolveEmployeeFilter(req.query, 3);

    const typeClause = callTypeSqlClause(callType);
    const statusClause = statusSqlClause(status);
    const limitIdx = 3 + empParams.length;
    const offsetIdx = limitIdx + 1;
    const sql = `
      SELECT c.id, c.employee_code, c.start_at, c.duration, c.type,
             c.client_phone, e.employee_name, cl.client_name
      FROM calls c
      JOIN employees e ON e.employee_code = c.employee_code
      JOIN clients cl ON cl.client_phone = c.client_phone
      WHERE c.start_at >= $1 AND c.start_at <= $2
        AND (${empClause})
        AND (${typeClause})
        AND (${statusClause})
      ORDER BY c.start_at DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}
    `;
    const { rows } = await pool.query(sql, [start, end, ...empParams, limit, offset]);

    const mapped = rows.map((r) =>
      mapCallRow({
        id: r.id,
        employee_code: r.employee_code,
        start_at: r.start_at,
        duration: r.duration,
        type: r.type,
        client_phone: r.client_phone,
        employee_name: r.employee_name,
        client_name: r.client_name,
      })
    );

    res.json({ calls: mapped, limit, offset });
  } catch (err) {
    console.error('GET /api/web/calls', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/web/employees
router.get('/employees', async (_req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT employee_code, employee_name, employee_phone, model_name, app_version,
             registered_at, last_call_at, last_sync_at
      FROM employees
      ORDER BY employee_name
    `);

    res.json(
      rows.map((r) => ({
        id: r.employee_code,
        name: r.employee_name,
        phone: r.employee_phone || '—',
        code: r.employee_code,
        tags: [],
        modelName: r.model_name || '—',
        appVersion: r.app_version || '—',
        registeredDate: r.registered_at
          ? new Date(r.registered_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
          : '—',
        lastCallTime: r.last_call_at
          ? new Date(r.last_call_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
          : '—',
        lastSyncTime: r.last_sync_at
          ? new Date(r.last_sync_at).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })
          : '—',
      }))
    );
  } catch (err) {
    console.error('GET /api/web/employees', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
