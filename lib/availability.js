// Availability engine. Given a date (YYYY-MM-DD), config, and a list of
// busy intervals, return slot start times (ISO strings in the shop's TZ)
// such that [start, start + duration + buffer] does not overlap any busy
// interval and respects lead time, working hours, and max-advance horizon.
//
// Times are computed in the configured timezone. We use the Intl API to
// translate without bringing in moment/luxon.

const DAY_MS = 24 * 60 * 60 * 1000;

// Build a Date for a YYYY-MM-DD + HH:MM string in a given IANA tz.
// Returns a Date whose UTC timestamp is the wall-clock moment in that tz.
function tzDate(ymd, hm, tz) {
  // Trick: format candidate UTC offsets at noon, find the offset that yields
  // the desired wall-clock time. Two tries handle DST in either direction.
  const [y, m, d] = ymd.split('-').map(Number);
  const [hh, mm] = hm.split(':').map(Number);
  // Construct as if UTC, then correct by tz offset.
  const utc = Date.UTC(y, m - 1, d, hh, mm, 0);
  const offsetMin = tzOffsetMinutes(new Date(utc), tz);
  return new Date(utc - offsetMin * 60 * 1000);
}

// Get the timezone offset (in minutes; positive east of UTC) for `date` in `tz`.
function tzOffsetMinutes(date, tz) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => (acc[p.type] = p.value, acc), {});
  const asUTC = Date.UTC(
    Number(parts.year), Number(parts.month) - 1, Number(parts.day),
    Number(parts.hour === '24' ? '0' : parts.hour), Number(parts.minute), Number(parts.second)
  );
  return (asUTC - date.getTime()) / 60000;
}

// Day-of-week (0=Sun..6=Sat) for a YYYY-MM-DD in a given tz.
export function dayOfWeekInTz(ymd, tz) {
  const d = tzDate(ymd, '12:00', tz);
  const dtf = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' });
  const wk = dtf.format(d);
  return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'].indexOf(wk);
}

export function todayYmdInTz(tz) {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return dtf.format(new Date()); // en-CA gives YYYY-MM-DD
}

export function addDaysYmd(ymd, days, tz) {
  const base = tzDate(ymd, '12:00', tz); // noon to dodge DST edges
  const next = new Date(base.getTime() + days * DAY_MS);
  const dtf = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return dtf.format(next);
}

// Format a Date as HH:MM in a tz.
export function fmtTime(date, tz) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(date);
}

// Generate bookable slots for a single day.
//   ymd: 'YYYY-MM-DD'
//   durationMin: total on-site time
//   busy: [{ start: Date, end: Date }, ...]   // calendar busy intervals
//   nowTs: number (Date.now()), used for lead-time enforcement
export function dailySlots({ ymd, config, durationMin, busy, nowTs = Date.now() }) {
  const tz = config.schedule.timezone;
  const dow = dayOfWeekInTz(ymd, tz);
  if (!config.schedule.working_days.includes(dow)) return [];

  const granularity = config.schedule.slot_granularity_minutes || 30;
  const buffer = config.schedule.buffer_minutes_between_shoots || 0;
  const leadMs = (config.schedule.lead_time_hours || 0) * 60 * 60 * 1000;

  const dayStart = tzDate(ymd, config.schedule.working_hours.start, tz);
  const dayEnd = tzDate(ymd, config.schedule.working_hours.end, tz);

  const slots = [];
  for (let t = dayStart.getTime(); t + durationMin * 60000 <= dayEnd.getTime(); t += granularity * 60000) {
    if (t < nowTs + leadMs) continue;
    const start = new Date(t);
    const end = new Date(t + durationMin * 60000);
    // Block if any busy interval overlaps [start - buffer, end + buffer].
    const guardStart = new Date(start.getTime() - buffer * 60000);
    const guardEnd = new Date(end.getTime() + buffer * 60000);
    const conflict = busy.some(b => b.start < guardEnd && b.end > guardStart);
    if (conflict) continue;
    slots.push({
      start: start.toISOString(),
      end: end.toISOString(),
      label: fmtTime(start, tz),
    });
  }
  return slots;
}
