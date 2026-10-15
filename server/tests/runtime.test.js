import test from "node:test";
import assert from "node:assert/strict";
import { createRuntimeStore, sanitizeRuntimeState, sanitizeSession } from "../supabase/functions/rubika-panel/lib/runtime-store.js";
import { createWorker, workerConfig, readWithBackoff } from "../runtime/worker.js";

const scope = "a".repeat(64);
const secondScope = "b".repeat(64);
const token = "TEST_BOT_TOKEN_NEVER_REAL";
const env = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "TEST_PRIVATE_KEY", SCOPE_SALT: "test-only-scope-salt-at-least-32-characters", BOT_TOKEN: token };
const now = Date.parse("2026-10-15T12:00:00Z");
const session = { kind: "flow", stage: "awaiting_consent", bot_id: "bot1", chat_id: "g1", user_id: "u1", flow_id: "flow1", step: 0, answers: {} };

test("runtime storage scopes every row and RPC and never exposes private credentials", async () => {
  const calls = [];
  const store = createRuntimeStore({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, now: () => now, fetcher: async (url, options) => {
    calls.push({ url: new URL(url), options, body: options.body && JSON.parse(options.body) });
    if (String(url).includes("/rpc/")) return Response.json({ acquired: true });
    return Response.json([{ scope, lease_owner: "private-owner", heartbeat_at: new Date(now).toISOString(), state: { warning_count: 2 }, data: session }]);
  } });
  assert.equal((await store.getRuntime(scope)).lease_owner, undefined);
  await store.acquireLease(scope, "worker1", 300);
  await store.releaseLease(scope, "worker1");
  await store.setEnabled(scope, false);
  await store.saveRuntime(scope, { status: "running", offset_id: "offset1" }, "worker1");
  await store.claimEvent(scope, "hash1", { type: "NewMessage", text: "RAW MESSAGE MUST NOT PERSIST", token });
  await store.finishEvent(scope, "hash1", "success", { actions: 1 });
  assert.deepEqual(await store.getUserState(scope, "g1", "u1"), { warning_count: 2 });
  await store.saveUserState(scope, "g1", "u1", { warning_count: 3 });
  await store.getSession(scope, "g1", "u1");
  await store.saveSession(scope, "g1", "u1", session, { token });
  await store.deleteSession(scope, "g1", "u1");
  await store.getRuntime(secondScope);
  for (const call of calls) {
    assert.equal(call.options.headers.Authorization, `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`);
    assert.equal(call.options.redirect, "error");
    assert.equal(call.body?.p_scope ?? call.body?.scope ?? call.url.searchParams.get("scope")?.slice(3), call === calls.at(-1) ? secondScope : scope);
    assert.equal(JSON.stringify(call.body ?? {}).includes(token), false);
    assert.equal(JSON.stringify(call.body ?? {}).includes("RAW MESSAGE"), false);
  }
  const sessionRead = calls.find(call => call.url.pathname.endsWith("sessions") && call.options.method === "GET");
  assert.equal(sessionRead.url.searchParams.get("expires_at"), `gt.${new Date(now).toISOString()}`);
  const saved = calls.find(call => call.body?.data?.kind === "flow");
  assert.equal(saved.body.expires_at, "2026-10-15T12:15:00.000Z");
  assert.equal(saved.body.updated_at, "2026-10-15T12:00:00.000Z");
});

test("runtime store rejects raw content, secret keys, malformed scopes and internal failures", async () => {
  for (const state of [{ text: "body" }, { bot_token: "abcd" }, { nested: { service_credential: "abcd" } }, { raw: {} }, { name: "سلام" }, { count: Infinity }, { times: Array(101).fill(1) }]) assert.throws(() => sanitizeRuntimeState(state), { code: "UNSAFE_RUNTIME_STATE" });
  assert.deepEqual(sanitizeRuntimeState({ warning_count: 1, recent_hashes: [{ hash: "a".repeat(64), time: now }] }), { warning_count: 1, recent_hashes: [{ hash: "a".repeat(64), time: now }] });
  const store = createRuntimeStore({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, fetcher: async () => Response.json({ message: env.SUPABASE_SERVICE_ROLE_KEY, detail: "internal_schema" }, { status: 500 }) });
  await assert.rejects(store.getRuntime(scope), error => error.code === "RUNTIME_STORE_UNAVAILABLE" && !error.message.includes(env.SUPABASE_SERVICE_ROLE_KEY) && !error.message.includes("internal_schema"));
  await assert.rejects(store.getRuntime("bad"), { code: "INVALID_SCOPE" });
  await assert.rejects(store.acquireLease(scope, "worker", 301), { code: "INVALID_LEASE" });
  await assert.rejects(store.saveUserState(scope, 123, "u1", {}), { code: "INVALID_RUNTIME_ID" });
  await assert.rejects(store.listScheduleJobs(scope, "not-a-uuid"), { code: "INVALID_RUNTIME_ID" });
  assert.throws(() => createRuntimeStore({ url: "http://untrusted.example", key: "private" }), { code: "CONFIGURATION_REQUIRED" });
});

test("interaction sessions require consent, expire within fifteen minutes and reject credentials", () => {
  const waiting = sanitizeSession(session, { now });
  assert.deepEqual(waiting.answers, {});
  assert.equal(waiting.stage, "awaiting_consent");
  assert.equal(waiting.expires_at, "2026-10-15T12:15:00.000Z");
  assert.throws(() => sanitizeSession({ ...session, answers: { name: "Ali" } }, { now }), { code: "CONSENT_REQUIRED" });
  const answered = sanitizeSession({ ...session, stage: "answering", consented: true, answers: { name: "علی", age: 20 }, expires_at: "2026-10-16T12:00:00Z" }, { now, token });
  assert.equal(answered.answers.name, "علی");
  assert.equal(answered.expires_at, waiting.expires_at);
  assert.deepEqual(sanitizeSession({ ...session, answers: undefined, consented: true, values: { email: "a@example.com" } }, { now }).values, { email: "a@example.com" });
  for (const input of [{ ...session, consented: true, answers: { api_key: "key" } }, { ...session, bot_id: token }, { ...session, consented: true, answers: { name: token } }]) assert.throws(() => sanitizeSession(input, { now, token }), { code: "UNSAFE_SESSION" });
  assert.throws(() => sanitizeSession({ ...session, expires_at: "2026-10-15T11:59:00Z" }, { now }), { code: "INVALID_SESSION" });
});

test("session listings delete expired rows first and expose only scoped, consented, unexpired answers", async () => {
  const calls = [];
  const store = createRuntimeStore({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, now: () => now, fetcher: async (url, options) => {
    calls.push({ url: new URL(url), options });
    if (options.method === "DELETE") return new Response(null, { status: 204 });
    return Response.json([{ scope, chat_id: "g1", user_id: "u1", data: { ...session, consented: true, stage: "completed", answers: { name: "علی" } }, expires_at: "2026-10-15T12:10:00Z" }]);
  } });
  const rows = await store.listSessions(scope);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.method, "DELETE");
  assert.equal(calls[0].url.searchParams.get("expires_at"), "lte.2026-10-15T12:00:00.000Z");
  assert.equal(calls[1].url.searchParams.get("data->>consented"), "eq.true");
  assert.equal(calls[1].url.searchParams.get("expires_at"), "gt.2026-10-15T12:00:00.000Z");
  assert.equal(calls[1].url.searchParams.get("limit"), "100");
  assert.ok(calls.every(call => call.url.searchParams.get("scope") === `eq.${scope}`));
  assert.equal(rows[0].scope, undefined);
  assert.equal(rows[0].data.answers.name, "علی");
});

test("metric date filters follow actual occurrence time and retain deduplication event keys", async () => {
  let query;
  const store = createRuntimeStore({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, fetcher: async url => {
    query = new URL(url).searchParams;
    return Response.json([{ event_key: "eventhash", metadata: { occurred_at: "2026-10-01T00:00:00.000Z" }, received_at: "2026-10-15T00:00:00.000Z", summary: { actions: 0 }, status: "success" }]);
  } });
  const rows = await store.listMetrics(scope, "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z");
  assert.deepEqual(query.getAll("metadata->>occurred_at"), ["gte.2026-10-01T00:00:00.000Z", "lte.2026-10-02T00:00:00.000Z"]);
  assert.equal(query.has("received_at"), false);
  assert.equal(rows[0].event_key, "eventhash");
});

function harness(overrides = {}) {
  const calls = [];
  const saves = [];
  const leases = [];
  const released = [];
  let heartbeat;
  let timerCleared = false;
  const state = { offset_id: "offset_old" };
  const store = {
    acquireLease: async (...args) => { leases.push(args); return { acquired: true }; },
    releaseLease: async (...args) => { released.push(args); return true; },
    getRuntime: async () => state,
    saveRuntime: async (...args) => { saves.push(args); Object.assign(state, args[1]); return true; },
    listScheduleJobs: async () => [],
    ...overrides.store,
  };
  const db = { saveBot: async (...args) => calls.push(["saveBot", ...args]), listResources: async () => [], ...overrides.db };
  const adapter = { pollingParams: params => params, call: async (unused, method, params) => { calls.push([method, params]); return method === "getMe" ? { bot_id: "bot1", name: "Test bot" } : { updates: [{ type: "Other" }], next_offset_id: "offset_new" }; }, ...overrides.adapter };
  const options = { env, db, store, adapter, now: () => now, sleep: async () => {}, owner: "test_worker", processBatch: async () => ({ complete: true, accounted: 1, processed: 1 }), dispatchOperation: async () => ({ status: "success" }), timers: { setInterval: fn => { heartbeat = fn; return 1; }, clearInterval: () => { timerCleared = true; } }, ...overrides.options };
  const worker = createWorker(options);
  return { worker, calls, saves, leases, released, store, db, adapter, heartbeat: () => heartbeat(), timerCleared: () => timerCleared };
}

test("worker saves cursor after a fully accounted batch and releases the lease on shutdown", async () => {
  const h = harness();
  const result = await h.worker.tick();
  assert.equal(result.processed, 1);
  assert.equal(h.calls.find(item => item[0] === "getUpdates")[1].offset_id, "offset_old");
  assert.equal(h.saves.filter(item => item[1].offset_id === "offset_new").length, 1);
  assert.ok(h.leases.length >= 5);
  assert.ok(h.leases.every(args => args[1] === "test_worker" && args[2] === 300));
  assert.equal(h.timerCleared(), true);
  await h.worker.run({ maxIterations: 1 });
  assert.equal(h.released.length, 1);
  assert.equal(JSON.stringify(h.saves).includes(token), false);
});

test("initialization retries a failed bot registration and never stores an echoed token", async () => {
  let registrations = 0;
  const h = harness({ db: { saveBot: async () => { registrations++; if (registrations === 1) throw Object.assign(new Error("temporary store failure"), { code: "DATABASE_UNAVAILABLE" }); } } });
  await assert.rejects(h.worker.tick(), { code: "DATABASE_UNAVAILABLE" });
  assert.equal((await h.worker.tick()).processed, 1);
  assert.equal(registrations, 2);
  const echoed = harness({ adapter: { call: async () => ({ bot_id: "bot1", name: token }) } });
  await assert.rejects(echoed.worker.initialize());
  assert.equal(echoed.calls.some(item => item[0] === "saveBot"), false);
});

test("incomplete batches retain the previous polling cursor", async () => {
  const h = harness({ options: { processBatch: async () => ({ complete: false, accounted: 0, processed: 0 }) } });
  await assert.rejects(h.worker.tick(), { code: "BATCH_INCOMPLETE" });
  assert.equal(h.saves.some(item => item[1].offset_id), false);
  assert.equal(h.saves.at(-1)[1].last_error_code, "BATCH_INCOMPLETE");
});

test("a busy scope and overlapping local ticks never poll", async () => {
  const h = harness({ store: { acquireLease: async () => ({ acquired: false }) } });
  assert.equal((await h.worker.tick()).lease_acquired, false);
  assert.equal(h.calls.some(item => item[0] === "getUpdates"), false);
  let resume;
  const paused = new Promise(resolve => { resume = resolve; });
  const overlap = harness({ options: { processBatch: async () => { await paused; return { complete: true, accounted: 1, processed: 1 }; } } });
  const first = overlap.worker.tick();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await overlap.worker.tick()).lease_acquired, false);
  resume(); await first;
  assert.equal(overlap.calls.filter(item => item[0] === "getUpdates").length, 1);
});

test("lease loss just before an event mutation prevents dispatch and cursor advancement", async () => {
  let allow = true;
  const h = harness({ store: { acquireLease: async () => ({ acquired: allow }) }, options: { processBatch: async ({ adapter }) => {
    allow = false;
    await adapter.call(token, "sendMessage", { chat_id: "g1", text: "must never send" });
    return { complete: true, accounted: 1, processed: 1 };
  } } });
  await assert.rejects(h.worker.tick(), { code: "LEASE_LOST" });
  assert.equal(h.calls.some(item => item[0] === "sendMessage"), false);
  assert.equal(h.saves.some(item => item[1].offset_id), false);
});

test("paused bots heartbeat without polling or advancing the cursor", async () => {
  const h = harness({ store: { getRuntime: async () => ({ enabled: false, offset_id: "offset_old" }) } });
  const result = await h.worker.tick();
  assert.equal(result.paused, true);
  assert.equal(h.calls.some(item => item[0] === "getUpdates"), false);
  assert.equal(h.saves.some(item => item[1].offset_id), false);
  assert.equal(h.saves.at(-1)[1].status, "paused");
});

test("pausing during an event prevents its next outbound call and keeps the old cursor", async () => {
  let enabled = true;
  const h = harness({ store: { getRuntime: async () => ({ enabled, offset_id: "offset_old" }) }, options: { processBatch: async ({ adapter }) => {
    enabled = false;
    await adapter.call(token, "sendMessage", { chat_id: "g1", text: "never" });
    return { complete: true, accounted: 1, processed: 1 };
  } } });
  assert.equal((await h.worker.tick()).paused, true);
  assert.equal(h.calls.some(item => item[0] === "sendMessage"), false);
  assert.equal(h.saves.some(item => item[1].offset_id), false);
  assert.equal(h.saves.at(-1)[1].status, "paused");
});

test("heartbeat failure remains fatal even when the database later recovers", async () => {
  let canRenew = true;
  let h;
  h = harness({ store: { acquireLease: async () => { if (!canRenew) throw Object.assign(new Error("private network details"), { code: "RUNTIME_STORE_UNAVAILABLE" }); return { acquired: true }; } }, options: { processBatch: async ({ adapter }) => {
    canRenew = false; h.heartbeat();
    await new Promise(resolve => setImmediate(resolve));
    canRenew = true;
    await assert.rejects(adapter.call(token, "sendMessage", { chat_id: "g1", text: "never" }), { code: "RUNTIME_STORE_UNAVAILABLE" });
    return { complete: true, accounted: 1, processed: 1 };
  } } });
  await assert.rejects(h.worker.tick(), { code: "RUNTIME_STORE_UNAVAILABLE" });
  assert.equal(h.calls.some(item => item[0] === "sendMessage"), false);
  assert.equal(h.saves.some(item => item[1].offset_id), false);
});

test("health checks only read and require a recent heartbeat and unexpired lease", async () => {
  const h = harness({ store: { getRuntime: async () => ({ status: "running", heartbeat_at: new Date(now - 1000).toISOString(), lease_until: new Date(now + 30000).toISOString() }) } });
  assert.equal(await h.worker.health(), true);
  assert.equal(h.calls.some(item => item[0] === "saveBot"), false);
  assert.equal(h.leases.length, 0);
  const paused = harness({ store: { getRuntime: async () => ({ status: "paused", enabled:false, heartbeat_at: new Date(now - 1000).toISOString(), lease_until: new Date(now + 30000).toISOString() }) } });
  assert.equal(await paused.worker.health(),true);
  const stale = harness({ store: { getRuntime: async () => ({ status: "running", heartbeat_at: new Date(now - 180000).toISOString(), lease_until: new Date(now + 30000).toISOString() }) } });
  assert.equal(await stale.worker.health(), false);
});

test("worker configuration and read retries stay bounded and stop after authentication/lease failures", async () => {
  assert.equal(workerConfig(env).batchLimit, 5);
  assert.throws(() => workerConfig({ ...env, BOT_TOKEN: "" }), { code: "CONFIGURATION_REQUIRED" });
  assert.throws(() => workerConfig({ ...env, WORKER_BATCH_LIMIT: "11" }), { code: "CONFIGURATION_REQUIRED" });
  const waits = []; let attempts = 0;
  assert.equal(await readWithBackoff(async () => { if (++attempts < 3) throw Error("temporary"); return "ok"; }, { sleep: async ms => waits.push(ms) }), "ok");
  assert.deepEqual(waits, [1000, 2000]);
  attempts = 0;
  await assert.rejects(readWithBackoff(async () => { attempts++; throw { code: "LEASE_LOST" }; }, { sleep: async () => {} }), { code: "LEASE_LOST" });
  assert.equal(attempts, 1);
  await assert.rejects(readWithBackoff(async () => "bad", { attempts: 0 }), TypeError);
});
