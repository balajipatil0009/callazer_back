function normalizePhone(raw) {
  if (raw == null || raw === '') return '';
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length === 0) return '';
  if (digits.startsWith('91') && digits.length === 12) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}

module.exports = { normalizePhone };
