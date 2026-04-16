/** Reporting boundaries in Asia/Kolkata (no DST). */

const TZ = 'Asia/Kolkata';

function ymdInIST(date = new Date()) {
  return date.toLocaleDateString('en-CA', { timeZone: TZ });
}

function parseYmdToDate(ymd, endOfDay = false) {
  const tail = endOfDay ? 'T23:59:59.999+05:30' : 'T00:00:00+05:30';
  return new Date(`${ymd}${tail}`);
}

function addDaysYmd(ymd, deltaDays) {
  const d = new Date(`${ymd}T12:00:00+05:30`);
  d.setTime(d.getTime() + deltaDays * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: TZ });
}

/** [start, end) as Date for PostgreSQL timestamptz */
function todayRange() {
  const ymd = ymdInIST();
  const start = parseYmdToDate(ymd, false);
  const end = parseYmdToDate(addDaysYmd(ymd, 1), false);
  return { start, end, ymd };
}

function yesterdayRange() {
  const todayYmd = ymdInIST();
  const yYmd = addDaysYmd(todayYmd, -1);
  const start = parseYmdToDate(yYmd, false);
  const end = parseYmdToDate(todayYmd, false);
  return { start, end, ymd: yYmd };
}

/** Rolling 7 days ending at start of today IST (excludes today), aligned with common "last week" rollups */
function lastWeekRange() {
  const todayYmd = ymdInIST();
  const startYmd = addDaysYmd(todayYmd, -7);
  const start = parseYmdToDate(startYmd, false);
  const end = parseYmdToDate(todayYmd, false);
  return { start, end, labelYmd: { from: startYmd, to: addDaysYmd(todayYmd, -1) } };
}

function lastMonthRange() {
  const todayYmd = ymdInIST();
  const start = parseYmdToDate(addDaysYmd(todayYmd, -30), false);
  const end = parseYmdToDate(todayYmd, false);
  return { start, end };
}

function formatIstDateLabel(date) {
  return date.toLocaleDateString('en-IN', {
    timeZone: TZ,
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
}

function formatRangeLabel(fromYmd, toYmd) {
  const a = formatIstDateLabel(parseYmdToDate(fromYmd, false));
  const b = formatIstDateLabel(parseYmdToDate(toYmd, false));
  return `${a.split(' ').slice(0, 2).join(' ')} to ${b.split(' ').slice(0, 2).join(' ')}`;
}

module.exports = {
  TZ,
  ymdInIST,
  parseYmdToDate,
  addDaysYmd,
  todayRange,
  yesterdayRange,
  lastWeekRange,
  lastMonthRange,
  formatIstDateLabel,
  formatRangeLabel,
};
