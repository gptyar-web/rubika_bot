import test from "node:test";
import assert from "node:assert/strict";
import { schedulePlan, runDueSchedules } from "../supabase/functions/rubika-panel/lib/scheduler.js";

const scope = "a".repeat(64);
const token = "TEST_BOT_TOKEN_NEVER_REAL";
const id = "11111111-1111-4111-8111-111111111111";
const now = Date.parse("2026-10-15T12:00:00Z");
const resource = changes => ({ id, data: { title: "Approved message", status: "approved", enabled: true, authorized: true, scheduled_at: "2026-10-15T11:00:00Z", method: "sendMessage", chat_ids: ["g1"], params: { text: "A configured outgoing message" }, ...changes } });

function harness({ resources = [resource()], registered = ["g1", "g2", "source"], outcome = { status: "success" }, initialJobs = [], finish = true, dispatch } = {}) {
  const jobs = structuredClone(initialJobs);
  const sent = [];
  const claims = [];
  const audits = [];
  const db = { listResources: async (seenScope, collection) => { assert.equal(seenScope, scope); assert.equal(collection, "schedules"); return resources; }, getChat: async (seenScope, chat) => { assert.equal(seenScope, scope); return registered.includes(chat) ? { chat_id: chat } : null; }, audit: async (seenScope, input) => { assert.equal(seenScope, scope); audits.push(input); } };
  const store = {
    listScheduleJobs: async (seenScope, scheduleId) => { assert.equal(seenScope, scope); return jobs.filter(job => job.schedule_id === scheduleId); },
    claimSchedule: async (seenScope, input) => {
      assert.equal(seenScope, scope); claims.push(input);
      const existing = jobs.find(job => job.schedule_id === input.schedule_id && job.occurrence_at === input.occurrence_at && job.destination === input.destination);
      if (existing) return { claimed: false, status: existing.status, operation_id: existing.operation_id };
      const job = { ...input, operation_id: crypto.randomUUID(), status: "pending" }; jobs.push(job);
      return { claimed: true, status: "pending", operation_id: job.operation_id };
    },
    finishSchedule: async (seenScope, operationId, status, error_code) => { assert.equal(seenScope, scope); if (!finish) return false; Object.assign(jobs.find(job => job.operation_id === operationId), { status, error_code }); return true; },
  };
  const run = extra => runDueSchedules({ scope, token, db, store, adapter: {}, now, dispatchOperation: dispatch ?? (async input => { sent.push(input); return outcome; }), ...extra });
  return { jobs, sent, claims, audits, run, resources, db, store };
}

test("scheduler only plans approved, enabled, explicitly authorized resources with valid dates and bounds", () => {
  assert.equal(schedulePlan(resource()).method, "sendMessage");
  for (const data of [{ status: "draft" }, { enabled: false }, { authorized: false }, { scheduled_at: "2026-02-30T11:00:00Z" }, { scheduled_at: "2026/10/15 11:00" }, { method: "deleteMessage" }, { chat_ids: ["g1", "g1"] }, { chat_ids: Array.from({ length: 21 }, (_, i) => `g${i}`) }, { recurrence: { interval_minutes: 59, max_occurrences: 3 } }, { recurrence: { interval_minutes: 60, max_occurrences: 367 } }]) assert.equal(schedulePlan(resource(data)), null, JSON.stringify(data));
  assert.equal(schedulePlan({ ...resource(), id: "bad" }), null);
});

test("approved due schedules get immutable UUID claims and never resend success", async () => {
  const h = harness();
  const first = await h.run();
  assert.equal(first.sent, 1);
  assert.equal(first.attempted, 1);
  assert.equal(h.sent[0].authorized, true);
  assert.equal(h.sent[0].operation_id, h.jobs[0].operation_id);
  assert.equal(h.sent[0].params.chat_id, "g1");
  assert.equal(h.jobs[0].content_hash.length, 64);
  assert.equal(h.jobs[0].status, "success");
  assert.equal(h.audits[0].action, "schedule");
  assert.equal((await h.run()).sent, 0);
  assert.equal(h.sent.length, 1);
  assert.equal(JSON.stringify(h.jobs).includes(token), false);
});

test("future, unapproved, unregistered and credential-bearing schedules never dispatch", async () => {
  const h = harness({ resources: [resource({ scheduled_at: "2026-10-16T11:00:00Z" }), resource({ enabled: false }), resource({ chat_ids: ["missing"] }), resource({ params: { text: `Never store or dispatch ${token}` } })] });
  const result = await h.run();
  assert.equal(result.sent, 0);
  assert.equal(h.claims.length, 0);
  assert.equal(h.sent.length, 0);
});

test("forwarding requires both registered source and destination", async () => {
  const input = resource({ method: "forwardMessage", chat_ids: ["g1"], params: { from_chat_id: "source", message_id: "m1" } });
  const missing = harness({ resources: [input], registered: ["g1"] });
  assert.equal((await missing.run()).sent, 0);
  assert.equal(missing.claims.length, 0);
  const registered = harness({ resources: [input] });
  assert.equal((await registered.run()).sent, 1);
  assert.deepEqual(registered.sent[0].params, { from_chat_id: "source", to_chat_id: "g1", message_id: "m1" });
});

test("unknown and rejected outcomes stop destinations and every recurrence", async () => {
  for (const status of ["unknown", "rejected", "pending", "confirmed_unrecorded"]) {
    const h = harness({ resources: [resource({ chat_ids: ["g1", "g2"], recurrence: { interval_minutes: 60, max_occurrences: 3 } })], outcome: { status } });
    const first = await h.run();
    assert.equal(first.attempted, 1, status);
    assert.equal(first.halted, 1, status);
    const later = await h.run({ now: now + 86400000 });
    assert.equal(later.sent, 0, status);
    assert.equal(later.halted, 1, status);
    assert.equal(h.sent.length, 1, status);
  }
});

test("a lost result write leaves a permanent pending claim and halts further sends", async () => {
  const h = harness({ resources: [resource({ chat_ids: ["g1", "g2"] })], finish: false });
  const first = await h.run();
  assert.equal(first.sent, 1);
  assert.equal(first.jobs[0].recording_pending, true);
  assert.equal(h.jobs[0].status, "pending");
  assert.equal((await h.run()).halted, 1);
  assert.equal(h.sent.length, 1);
});

test("editing a schedule with existing jobs does not create a second send", async () => {
  const h = harness();
  await h.run();
  h.resources[0].data.params.text = "Edited content";
  h.resources[0].data.chat_ids = ["g1", "g2"];
  assert.equal((await h.run()).halted, 1);
  assert.equal(h.sent.length, 1);
});

test("recurrence progresses one occurrence at a time and respects per-run limits", async () => {
  const h = harness({ resources: [resource({ chat_ids: ["g1", "g2"], recurrence: { interval_minutes: 60, max_occurrences: 2 } })] });
  assert.equal((await h.run({ maxJobs: 1 })).sent, 1);
  assert.equal((await h.run()).sent, 1);
  assert.equal((await h.run()).sent, 2);
  assert.equal((await h.run()).sent, 0);
  assert.equal(new Set(h.jobs.map(job => job.operation_id)).size, 4);
  assert.deepEqual([...new Set(h.jobs.map(job => job.occurrence_at))], ["2026-10-15T11:00:00.000Z", "2026-10-15T12:00:00.000Z"]);
});

test("atomic concurrent claims allow a single dispatch for each occurrence", async () => {
  const h = harness();
  const results = await Promise.all([h.run(), h.run(), h.run()]);
  assert.equal(results.reduce((count, result) => count + result.sent, 0), 1);
  assert.equal(h.sent.length, 1);
  assert.equal(h.jobs.length, 1);
});

test("an exception without a confirmed rejection becomes unknown and is never retried", async () => {
  let dispatched = 0;
  const h = harness({ dispatch: async () => { dispatched++; throw Object.assign(new Error("private upstream content"), { code: "RUBIKA_UNAVAILABLE" }); } });
  const first = await h.run();
  assert.equal(first.unknown, 1);
  assert.equal(first.jobs[0].error_code, "RUBIKA_UNAVAILABLE");
  assert.equal(JSON.stringify(first).includes("private upstream content"), false);
  await h.run(); assert.equal(dispatched, 1);
});
