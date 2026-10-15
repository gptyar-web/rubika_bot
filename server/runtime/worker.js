import { createDatabase } from "../supabase/functions/rubika-panel/lib/database.js";
import { createRubikaAdapter } from "../supabase/functions/rubika-panel/lib/adapter.js";
import { botScope } from "../supabase/functions/rubika-panel/lib/handler.js";
import { identifier, safeData, tokenValue } from "../supabase/functions/rubika-panel/lib/validation.js";
import { createRuntimeStore } from "../supabase/functions/rubika-panel/lib/runtime-store.js";
import { runDueSchedules } from "../supabase/functions/rubika-panel/lib/scheduler.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const safeCode = error => /^[A-Z0-9_]{1,80}$/u.test(error?.code ?? "") ? error.code : "WORKER_UNAVAILABLE";
const delay = (milliseconds, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const done = () => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, milliseconds);
  signal?.addEventListener("abort", done, { once: true });
});

export function workerConfig(env) {
  for (const name of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SCOPE_SALT", "BOT_TOKEN"]) {
    if (!env[name]) throw Object.assign(new Error(`Configure ${name} in the private worker environment.`), { code: "CONFIGURATION_REQUIRED" });
  }
  if (env.SCOPE_SALT.length < 32) throw Object.assign(new Error("SCOPE_SALT must contain at least 32 characters."), { code: "CONFIGURATION_REQUIRED" });
  const token = tokenValue(env.BOT_TOKEN);
  const interval = Number(env.WORKER_POLL_INTERVAL_MS ?? 5000);
  const batchLimit = Number(env.WORKER_BATCH_LIMIT ?? 5);
  if (!Number.isInteger(interval) || interval < 1000 || interval > 60000 || !Number.isInteger(batchLimit) || batchLimit < 1 || batchLimit > 10) throw Object.assign(new Error("Use a poll interval of 1000–60000 ms and batch limit of 1–10."), { code: "CONFIGURATION_REQUIRED" });
  return { token, interval, batchLimit, salt: env.SCOPE_SALT };
}

// Only read-only API operations are retried. Mutation recovery belongs to the
// permanent operation/event claims, which never repeat an uncertain action.
export async function readWithBackoff(operation, { attempts = 3, sleep = delay, signal } = {}) {
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > 5) throw new TypeError("Use one to five read attempts.");
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw Object.assign(new Error("Worker stopped."), { code: "WORKER_STOPPED" });
    try { return await operation(); } catch (error) {
      if ([400, 401, 403].includes(error?.status) || ["LEASE_LOST", "WORKER_STOPPED", "WORKER_PAUSED", "CONFIGURATION_REQUIRED", "RUNTIME_STORE_UNAVAILABLE"].includes(error?.code) || attempt + 1 === attempts) throw error;
      await sleep(Math.min(30000, 1000 * 2 ** attempt), signal);
    }
  }
}

export function createWorker({ env = process.env, db, store, adapter, processBatch, dispatchOperation, now = Date.now, sleep = delay, logger = () => {}, owner = crypto.randomUUID(), timers = { setInterval, clearInterval } } = {}) {
  const config = workerConfig(env);
  db ??= createDatabase({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY });
  store ??= createRuntimeStore({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, now });
  adapter ??= createRubikaAdapter({ base: env.RUBIKA_API_BASE });
  if (typeof processBatch !== "function" || typeof dispatchOperation !== "function") throw new TypeError("Inject the engine event processor and operation dispatcher.");
  let bot; let scope; let activeTick = false;
  async function initialize(signal) {
    if (!bot) {
      const candidate = await readWithBackoff(() => adapter.call(config.token, "getMe", {}), { sleep, signal });
      safeData(candidate, config.token);
      identifier(candidate.bot_id, "bot_id");
      const candidateScope = await botScope(candidate.bot_id, config.salt);
      await db.saveBot(candidateScope, candidate);
      scope = candidateScope;
      bot = candidate;
    }
    return scope;
  }
  async function tick(signal) {
    if (activeTick) return { lease_acquired: false, processed: 0 };
    activeTick = true;
    let heartbeat; let renewalInFlight; let heartbeatFailure = null;
    const stopped = () => { if (signal?.aborted) throw Object.assign(new Error("Worker stopped."), { code: "WORKER_STOPPED" }); };
    async function assertLease() {
      stopped();
      if (heartbeatFailure) throw heartbeatFailure;
      if (!renewalInFlight) {
        renewalInFlight = (async () => {
          const renewal = await store.acquireLease(scope, owner, 300);
          if (renewal?.acquired !== true) throw Object.assign(new Error("Worker lease is no longer owned."), { code: "LEASE_LOST" });
          if ((await store.getRuntime(scope))?.enabled === false) {
            await store.saveRuntime(scope, { status: "paused", last_error_code: null }, owner);
            throw Object.assign(new Error("Worker is paused for this bot."), { code: "WORKER_PAUSED" });
          }
          await store.saveRuntime(scope, { status: "running", last_error_code: null }, owner);
        })().catch(error => { heartbeatFailure = error; throw error; });
      }
      const pending = renewalInFlight;
      try { await pending; } finally { if (renewalInFlight === pending) renewalInFlight = null; }
      stopped();
    }
    try {
      stopped();
      await initialize(signal);
      const lease = await store.acquireLease(scope, owner, 300);
      if (lease?.acquired !== true) return { lease_acquired: false, processed: 0 };
      await store.purgeExpiredSessions?.(scope);
      heartbeat = timers.setInterval(() => { void assertLease().catch(() => {}); }, 30000);
      heartbeat?.unref?.();
      // Renew immediately before every Rubika operation. A failed/uncertain renewal
      // permanently stops this tick; no later action may reacquire and resume it.
      const guardedAdapter = { ...adapter, call: async (...args) => { await assertLease(); return adapter.call(...args); } };
      await assertLease();
      const runtime = await store.getRuntime(scope);
      const params = guardedAdapter.pollingParams({ limit: config.batchLimit, ...(runtime?.offset_id ? { offset_id: runtime.offset_id } : {}) });
      const batch = await readWithBackoff(() => guardedAdapter.call(config.token, "getUpdates", params), { sleep, signal });
      if (!Array.isArray(batch?.updates) || batch.updates.length > config.batchLimit) throw Object.assign(new Error("Invalid update batch."), { code: "INVALID_RUBIKA_RESPONSE" });
      await assertLease();
      const events = await processBatch({ scope, token: config.token, bot, updates: batch.updates, db, store, adapter: guardedAdapter, now: now() });
      if (events.complete !== true || events.accounted !== batch.updates.length) throw Object.assign(new Error("The event batch was not completely accounted for."), { code: "BATCH_INCOMPLETE" });
      await assertLease();
      // Persist the Rubika cursor only after every event has a permanent outcome.
      await store.saveRuntime(scope, { ...(batch.next_offset_id ? { offset_id: batch.next_offset_id } : {}), status: "running", last_error_code: null }, owner);
      const schedules = await runDueSchedules({ scope, token: config.token, db, store, adapter: guardedAdapter, now: now(), dispatchOperation });
      await assertLease();
      await store.saveRuntime(scope, { status: "running", last_error_code: null }, owner);
      return { lease_acquired: true, processed: events.processed, events, schedules };
    } catch (error) {
      if (error?.code === "WORKER_PAUSED") return { lease_acquired: true, paused: true, processed: 0 };
      try { await store.saveRuntime(scope, { status: "error", last_error_code: safeCode(error) }, owner); } catch {}
      throw error;
    } finally {
      if (heartbeat !== undefined) timers.clearInterval(heartbeat);
      if (renewalInFlight) try { await renewalInFlight; } catch {}
      activeTick = false;
      // Keeping the lease between ticks avoids an idle gap in which another worker
      // could start, while a clean shutdown releases it immediately.
    }
  }
  async function run({ signal, maxIterations = Infinity } = {}) {
    let failures = 0;
    try {
      for (let iteration = 0; iteration < maxIterations && !signal?.aborted; iteration++) {
        try {
          const result = await tick(signal);
          failures = 0;
          logger({ event: result.lease_acquired ? "worker_tick" : "lease_busy", processed: result.processed });
        } catch (error) { failures++; logger({ event: "worker_error", code: safeCode(error) }); }
        if (iteration + 1 < maxIterations && !signal?.aborted) await sleep(Math.min(60000, config.interval * 2 ** Math.min(failures, 4)), signal);
      }
    } finally { if (scope) try { await store.releaseLease(scope, owner); } catch {} }
  }
  async function health() {
    // A container probe is read-only: it never registers a bot or renews its lease.
    const healthScope = scope ?? await botScope((await adapter.call(config.token, "getMe", {})).bot_id, config.salt);
    const runtime = await store.getRuntime(healthScope);
    return Boolean(["running", "paused"].includes(runtime?.status) && Date.parse(runtime.heartbeat_at) >= now() - 120000 && Date.parse(runtime.lease_until) > now());
  }
  return { initialize, tick, run, health };
}

async function main() {
  const { processBatch, dispatchOperation } = await import("../supabase/functions/rubika-panel/lib/engine.js");
  const worker = createWorker({ processBatch, dispatchOperation, logger: value => console.log(JSON.stringify(value)) });
  if (process.argv.includes("--healthcheck")) { process.exitCode = await worker.health() ? 0 : 1; return; }
  const stop = new AbortController();
  for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => stop.abort());
  await worker.run({ signal: stop.signal });
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(JSON.stringify({ event: "worker_start_failed", code: safeCode(error) })); process.exitCode = 1; });
