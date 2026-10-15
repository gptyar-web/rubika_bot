import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReport, reportRange } from '../supabase/functions/rubika-panel/lib/reports.js';

const now = new Date('2026-10-15T00:00:00.000Z');
const from = '2026-10-13T00:00:00.000Z';
const to = '2026-10-15T00:00:00.000Z';
const event = (key, occurred_at, user_id, summary = {}, type = 'NewMessage') => ({ event_key: key, metadata: { occurred_at, user_id, type, chat_id: 'g1', message_id: key }, summary });

test('reports aggregate measured metadata, deduplicate event keys and bucket Tehran midnight correctly', () => {
  const first = event('m1', '2026-10-13T20:29:59Z', 'u1', { processed: true, warnings: 1, violations: ['link'], errors: 0, latency_ms: 12, command: '/RULES' });
  const report = buildReport({ now, from, to, events: [
    first, first,
    event('m2', '2026-10-13T20:30:00Z', 'u1', { processed: true, warnings: 2, violations: ['text', 'file'], errors: 1, latency_ms: 20, command: '/rules' }),
    { event_key: 'm3', occurred_at: '2026-10-14T09:00:00Z', user_id: 'u2', type: 'UpdatedMessage', summary: { processed: false, skipped: true, latency_ms: -2 } },
    { ...event('m4', '2026-10-14T12:00:00Z', 'bot', { processed: true }), metadata: { occurred_at: '2026-10-14T12:00:00Z', user_id: 'bot', is_bot: true, type: 'NewMessage' } },
    { ...event('m5', '2026-10-14T13:00:00Z', 'outgoing'), metadata: { occurred_at: '2026-10-14T13:00:00Z', user_id: 'outgoing', is_outgoing: true } },
    event('future', to, 'u3', { processed: true }),
    event('old', '2026-10-12T23:59:59Z', 'u3', { processed: true }),
  ] });
  assert.deepEqual(report.summary, { received: 5, processed: 3, active_users: 2, warnings: 3, violations: 3, api_errors: 1, average_response_ms: 16, schedule_success: 0, schedule_failed: 0, schedule_unknown: 0 });
  assert.deepEqual(report.daily, [
    { date: '2026-10-13', received: 1, processed: 1, warnings: 1, violations: 1, errors: 0 },
    { date: '2026-10-14', received: 4, processed: 2, warnings: 2, violations: 2, errors: 1 },
  ]);
  assert.deepEqual(report.by_type, [{ type: 'NewMessage', count: 3 }, { type: 'unknown', count: 1 }, { type: 'UpdatedMessage', count: 1 }]);
  assert.deepEqual(report.by_command, [{ command: '/rules', count: 2 }]);
});

test('half-open equal comparison intervals never count a boundary event twice', () => {
  const report = buildReport({ now, from, to, previous: true, events: [
    event('previous', '2026-10-11T00:00:00Z', 'u1', { processed: true }),
    event('boundary', from, 'u2', { processed: true }),
    event('end', to, 'u3', { processed: true }),
  ] });
  assert.equal(report.summary.received, 1); assert.equal(report.previous.summary.received, 1);
  assert.equal(report.previous.from, '2026-10-11T00:00:00.000Z'); assert.equal(report.previous.to, from);
  assert.equal(report.previous.summary.active_users, 1);
});

test('schedule summaries count unique confirmed executions and retain unknown outcomes separately', () => {
  const run = (operation_id, status, occurred_at = '2026-10-14T09:00:00Z') => ({ data: { action: 'schedule', schedule_id: 's1', operation_id, status, occurred_at } });
  const report = buildReport({ now, from, to, audit: [
    run('success', 'success'), run('success', 'success'), run('rejected', 'rejected'), run('unknown', 'unknown'),
    run('confirmed', 'confirmed_unrecorded'), run('pending', 'pending'), run('blocked', 'blocked'),
    run('old', 'success', '2026-10-12T09:00:00Z'), { data: { action: 'message', status: 'success', occurred_at: '2026-10-14T09:00:00Z' } },
  ], schedules: [{ id: 's1', data: { last_run_at: '2026-10-14T09:00:00Z', last_run_status: 'success' } }] });
  assert.equal(report.summary.schedule_success, 2); assert.equal(report.summary.schedule_failed, 1); assert.equal(report.summary.schedule_unknown, 1);
  assert.equal(report.summary.received, 0); assert.deepEqual(report.daily, []);
});

test('unexecuted saved schedules are never reported as successful runs', () => {
  const report = buildReport({ now, from, to, schedules: [
    { id: 'planned', updated_at: '2026-10-14T09:00:00Z', data: { status: 'success', scheduled_at: '2026-10-14T09:00:00Z' } },
    { id: 'run', data: { last_run_at: '2026-10-14T09:00:00Z', last_run_status: 'failed' } },
  ] });
  assert.equal(report.summary.schedule_success, 0); assert.equal(report.summary.schedule_failed, 1);
});

test('absent records return actual zero counts and no fabricated daily chart points', () => {
  const report = buildReport({ now, from, to, previous: true });
  assert(Object.values(report.summary).every(value => value === 0));
  assert(Object.values(report.previous.summary).every(value => value === 0));
  assert.deepEqual(report.daily, []); assert.deepEqual(report.by_type, []); assert.deepEqual(report.by_command, []);
});

test('invalid records and unmeasured counters cannot manufacture activity or latency', () => {
  const report = buildReport({ now, from, to, events: [
    null, {}, event('invalid-date', '2026-02-30T10:00:00Z', 'u1'),
    event('local-date', '2026-10-14T10:00:00', 'u1'),
    event('valid', '2026-10-14T10:00:00+03:30', null, { processed: false, warnings: -1, errors: NaN, violations: 'fake', command: '=DANGEROUS()', latency_ms: Infinity }),
  ] });
  assert.equal(report.summary.received, 1); assert.equal(report.summary.active_users, 0); assert.equal(report.summary.warnings, 0); assert.equal(report.summary.api_errors, 0); assert.equal(report.summary.average_response_ms, 0);
  assert.deepEqual(report.by_command, []);
});

test('range validation defaults to trailing seven days and rejects ambiguous or excessive intervals', () => {
  assert.deepEqual(reportRange({ now }), { from: '2026-10-08T00:00:00.000Z', to: now.toISOString(), previous_from: '2026-10-01T00:00:00.000Z', previous_to: '2026-10-08T00:00:00.000Z' });
  for (const input of [
    { from: to, to: from }, { from, to: from }, { from: '2026-02-30T00:00:00Z', to },
    { from: '2026-10-13T00:00:00', to }, { from: '2026-10-13T24:00:00Z', to },
    { from: '2026-10-13T00:00:00+14:01', to }, { from: '2024-01-01T00:00:00Z', to }, { now: new Date('invalid') },
  ]) assert.throws(() => reportRange({ now, ...input }), error => error.status === 400);
  assert.throws(() => buildReport({ now, events: {} }), error => error.status === 400);
  assert.throws(() => buildReport({ now, previous: 'yes' }), error => error.status === 400);
});
