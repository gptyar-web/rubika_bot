import { assert } from './validation.js';

const DAY = 86400000;
const MAX_REPORT_DAYS = 366;
const dateFormatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' });

function timestamp(value) {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second = '0', , zone] = match;
  const leap = Number(year) % 4 === 0 && (Number(year) % 100 !== 0 || Number(year) % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > days[Number(month) - 1] || Number(hour) > 23 || Number(minute) > 59 || Number(second) > 59) return null;
  if (zone !== 'Z' && (Number(zone.slice(1, 3)) > 14 || Number(zone.slice(4)) > 59 || Number(zone.slice(1, 3)) === 14 && Number(zone.slice(4)) !== 0)) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

export function reportRange({ from, to, now = new Date() } = {}) {
  const current = timestamp(now);
  assert(current !== null, 'The report clock is invalid.');
  const end = to === undefined ? current : timestamp(to);
  const start = from === undefined ? (end ?? current) - 7 * DAY : timestamp(from);
  assert(start !== null && end !== null, 'Report boundaries must be valid ISO dates with a timezone.');
  assert(start < end, 'The report end must be later than its start.');
  assert(end - start <= MAX_REPORT_DAYS * DAY, `Report ranges cannot exceed ${MAX_REPORT_DAYS} days.`);
  return {
    from: new Date(start).toISOString(), to: new Date(end).toISOString(),
    previous_from: new Date(start - (end - start)).toISOString(), previous_to: new Date(start).toISOString(),
  };
}

function count(value) {
  if (Array.isArray(value)) return value.length;
  if (value === true) return 1;
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function tehranDay(time) {
  const parts = Object.fromEntries(dateFormatter.formatToParts(new Date(time)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function inRange(time, start, end) {
  return time !== null && time >= start && time < end;
}

function eventRows(events, start, end) {
  const unique = new Set();
  const rows = [];
  for (const row of events) {
    if (!row || typeof row !== 'object') continue;
    const metadata = row.metadata && typeof row.metadata === 'object' ? row.metadata : row;
    const time = timestamp(metadata.occurred_at ?? row.received_at ?? row.created_at);
    if (!inRange(time, start, end)) continue;
    const key = row.event_key ?? row.event_hash ?? metadata.event_key ?? metadata.event_hash;
    // Stable storage keys deduplicate retries. Missing keys do not invent an identity.
    if (key !== undefined && key !== null) {
      const identity = `${row.scope ?? ''}:${String(key)}`;
      if (unique.has(identity)) continue;
      unique.add(identity);
    }
    rows.push({ metadata, summary: row.summary && typeof row.summary === 'object' ? row.summary : {}, time });
  }
  return rows;
}

function scheduleRows(audit, schedules, start, end) {
  const unique = new Set();
  const rows = [];
  const append = (data, createdAt, fallbackId) => {
    const time = timestamp(data.occurred_at ?? data.executed_at ?? data.last_run_at ?? createdAt);
    if (!inRange(time, start, end)) return;
    const status = data.status ?? data.last_status ?? data.last_run_status;
    if (!['success', 'confirmed', 'confirmed_unrecorded', 'failed', 'rejected', 'unknown'].includes(status)) return;
    const key = data.operation_id ?? data.execution_id ?? `${data.schedule_id ?? fallbackId ?? ''}:${time}`;
    if (unique.has(String(key))) return;
    unique.add(String(key));
    rows.push({ time, status });
  };
  for (const row of audit) {
    const data = row?.data ?? row;
    if (!data || !['schedule', 'schedule_execute', 'schedule_execution'].includes(data.action)) continue;
    append(data, row.created_at, row.id);
  }
  // Resource state represents only its latest execution. Use it solely as a
  // fallback when no actual execution audit is available for this interval.
  if (!rows.length) for (const row of schedules) {
    const data = row?.data ?? row;
    if (!data || !data.last_run_at && !data.executed_at) continue;
    append({ ...data, status: data.last_run_status ?? data.last_status ?? data.status }, row.updated_at, row.id);
  }
  return rows;
}

function aggregate({ events, audit, schedules }, from, to) {
  const start = Date.parse(from); const end = Date.parse(to);
  const summary = { received: 0, processed: 0, active_users: 0, warnings: 0, violations: 0, api_errors: 0, average_response_ms: 0, schedule_success: 0, schedule_failed: 0, schedule_unknown: 0 };
  const users = new Set(); const days = new Map(); const types = new Map(); const commands = new Map();
  let latency = 0; let latencySamples = 0;
  for (const row of eventRows(events, start, end)) {
    const { metadata, summary: measured, time } = row;
    const date = tehranDay(time);
    if (!days.has(date)) days.set(date, { date, received: 0, processed: 0, warnings: 0, violations: 0, errors: 0 });
    const daily = days.get(date);
    const processed = measured.processed === true || measured.processed === 1 ? 1 : 0;
    const warnings = count(measured.warnings);
    const violations = count(measured.violations);
    const errors = count(measured.errors);
    summary.received += 1; daily.received += 1;
    summary.processed += processed; daily.processed += processed;
    summary.warnings += warnings; daily.warnings += warnings;
    summary.violations += violations; daily.violations += violations;
    summary.api_errors += errors; daily.errors += errors;
    const user = metadata.user_id;
    if ((typeof user === 'string' && user.trim() || typeof user === 'number' && Number.isSafeInteger(user)) && metadata.is_bot !== true && metadata.user_is_bot !== true && metadata.sender_type !== 'bot' && metadata.is_outgoing !== true) users.add(String(user));
    const type = typeof metadata.type === 'string' && metadata.type ? metadata.type : 'unknown';
    types.set(type, (types.get(type) ?? 0) + 1);
    if (typeof measured.command === 'string' && /^\/[a-z][a-z0-9_]{0,31}$/i.test(measured.command)) {
      const command = measured.command.toLowerCase(); commands.set(command, (commands.get(command) ?? 0) + 1);
    }
    if (typeof measured.latency_ms === 'number' && Number.isFinite(measured.latency_ms) && measured.latency_ms >= 0) {
      latency += measured.latency_ms; latencySamples += 1;
    }
  }
  summary.active_users = users.size;
  summary.average_response_ms = latencySamples ? Math.round(latency / latencySamples * 100) / 100 : 0;
  for (const execution of scheduleRows(audit, schedules, start, end)) {
    if (['success', 'confirmed', 'confirmed_unrecorded'].includes(execution.status)) summary.schedule_success += 1;
    else if (execution.status === 'unknown') summary.schedule_unknown += 1;
    else summary.schedule_failed += 1;
  }
  const distribution = (map, key) => [...map].map(([value, total]) => ({ [key]: value, count: total })).sort((left, right) => right.count - left.count || left[key].localeCompare(right[key]));
  return { from, to, timezone: 'Asia/Tehran', summary, daily: [...days.values()].sort((left, right) => left.date.localeCompare(right.date)), by_type: distribution(types, 'type'), by_command: distribution(commands, 'command') };
}

export function buildReport({ events = [], audit = [], schedules = [], from, to, previous = false, now = new Date() } = {}) {
  assert(Array.isArray(events) && Array.isArray(audit) && Array.isArray(schedules), 'Report records must be arrays.');
  assert(typeof previous === 'boolean' || previous && typeof previous === 'object' && !Array.isArray(previous), 'The comparison option is invalid.');
  const range = reportRange({ from, to, now });
  const current = aggregate({ events, audit, schedules }, range.from, range.to);
  if (previous) {
    const source = typeof previous === 'object' ? { events: previous.events ?? events, audit: previous.audit ?? audit, schedules: previous.schedules ?? schedules } : { events, audit, schedules };
    assert(Array.isArray(source.events) && Array.isArray(source.audit) && Array.isArray(source.schedules), 'Comparison records must be arrays.');
    current.previous = aggregate(source, range.previous_from, range.previous_to);
  }
  return current;
}
