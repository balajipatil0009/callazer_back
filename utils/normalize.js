function normalizePhone(raw) {
  if (!raw) return raw;
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.startsWith('91') && digits.length === 12) return `+${digits}`;
  if (digits.length === 10) return `+91${digits}`;
  return `+${digits}`;
}

module.exports = { normalizePhone };
