/** Duration / number formatting for web API (matches callazer_dash mock style). */

function formatDurationHm(totalSeconds) {
  if (totalSeconds == null || totalSeconds <= 0) return '0h 0m';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function formatDurationHms(totalSeconds) {
  if (totalSeconds == null || totalSeconds <= 0) return '0h 0m 0s';
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  return `${m}m ${s}s`;
}

function formatAvgDuration(totalSeconds, callCount) {
  if (!callCount || callCount <= 0 || totalSeconds == null) return '—';
  const avg = Math.round(totalSeconds / callCount);
  const m = Math.floor(avg / 60);
  const sec = avg % 60;
  return `${m}m ${String(sec).padStart(2, '0')}s`;
}

function titleCaseCallType(dbType) {
  if (!dbType) return 'Unknown';
  const map = {
    incoming: 'Incoming',
    outgoing: 'Outgoing',
    missed: 'Missed',
    rejected: 'Rejected',
    not_pickup: 'Outgoing',
    unknown: 'Unknown',
  };
  return map[dbType] || dbType.charAt(0).toUpperCase() + dbType.slice(1).replace(/_/g, ' ');
}

/**
 * Map DB row to UI call record.
 * never_attended: missed (employee did not answer incoming).
 * notPickupByClient: not_pickup (Android: outgoing with 0s duration).
 */
function mapCallRow(row) {
  const type = row.type;
  const durationSec = Number(row.duration) || 0;
  const notPickupByClient = type === 'not_pickup';
  let status = 'connected';
  // Missed incoming → never_attended (employee did not answer); matches Never attended report filter
  if (type === 'missed') status = 'never_attended';
  else if (type === 'rejected') status = 'rejected';
  else if (type === 'not_pickup') status = 'not_pickup';
  else if (durationSec === 0 && (type === 'incoming' || type === 'outgoing')) status = 'never_attended';
  else if (durationSec > 0 && (type === 'incoming' || type === 'outgoing')) status = 'connected';

  return {
    id: String(row.id),
    employeeName: row.employee_name || '—',
    clientName: row.client_name || '—',
    clientPhone: row.client_phone,
    callType: titleCaseCallType(type),
    durationSec,
    date: row.start_at instanceof Date ? row.start_at.toISOString() : new Date(row.start_at).toISOString(),
    status,
    attended: status === 'connected',
    notPickupByClient,
    /** For filters: never-attended tab uses missed-as-employee-never-answered */
    employeeCode: row.employee_code,
  };
}

module.exports = {
  formatDurationHm,
  formatDurationHms,
  formatAvgDuration,
  titleCaseCallType,
  mapCallRow,
};
