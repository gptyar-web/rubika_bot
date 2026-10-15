import { buildMessage, destinations } from "./adapter.js";
import { safeData } from "./validation.js";

const SEND_METHODS = new Set(["sendMessage", "sendPoll", "sendLocation", "sendContact", "sendSticker", "sendFile", "forwardMessage"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const ID = /^[A-Za-z0-9_:.\-]{1,160}$/u;
export const SCHEDULE_LIMITS = Object.freeze({ destinations: 20, interval_minutes: 60, max_occurrences: 366, jobs_per_run: 10 });

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
async function hash(value) {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical(value))));
  return [...bytes].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export function schedulePlan(resource) {
  const data = resource?.data;
  if (!UUID.test(resource?.id ?? "") || !data || data.status !== "approved" || data.enabled !== true || data.authorized !== true) return null;
  const scheduled_at = data.scheduled_at ?? data.scheduledAt;
  if (typeof scheduled_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(scheduled_at)) return null;
  const starts = Date.parse(scheduled_at);
  if (!Number.isFinite(starts)) return null;
  if (new Date(`${scheduled_at.slice(0, 10)}T00:00:00Z`).toISOString().slice(0, 10) !== scheduled_at.slice(0, 10)) return null;
  const method = data.method ?? "sendMessage";
  if (!SEND_METHODS.has(method)) return null;
  const chats = data.chat_ids ?? [data.chat_id ?? data.params?.chat_id ?? data.params?.to_chat_id];
  if (!Array.isArray(chats) || chats.length < 1 || chats.length > SCHEDULE_LIMITS.destinations || chats.some(chat => !ID.test(chat)) || new Set(chats).size !== chats.length) return null;
  const params = chats.map(chat_id => buildMessage(method, method === "forwardMessage"
    ? { ...data.params, to_chat_id: chat_id }
    : { ...(data.params ?? { text: data.text }), chat_id }));
  let max_occurrences = 1; let interval = 0;
  if (data.recurrence !== undefined && data.recurrence !== null) {
    const recurrence = data.recurrence;
    if (!Number.isInteger(recurrence.interval_minutes) || recurrence.interval_minutes < 60 || recurrence.interval_minutes > 525600
      || !Number.isInteger(recurrence.max_occurrences) || recurrence.max_occurrences < 1 || recurrence.max_occurrences > 366) return null;
    interval = recurrence.interval_minutes * 60000;
    max_occurrences = recurrence.max_occurrences;
  }
  return { id: resource.id, data, method, chats, params, starts, interval, max_occurrences };
}

function nextOccurrence(plan, jobs, now) {
  if (jobs.some(job => job.status !== "success")) return { halted: true };
  for (let index = 0; index < plan.max_occurrences; index++) {
    const time = plan.starts + index * plan.interval;
    if (time > now) return null;
    const rows = jobs.filter(job => Date.parse(job.occurrence_at) === time);
    // Pending/unknown/rejected outcomes require a human to inspect the destination.
    // They must also stop recurrence, including other destinations in this run.
    if (rows.some(job => job.status !== "success")) return { halted: true };
    const completed = new Set(rows.filter(job => job.status === "success").map(job => job.destination));
    if (plan.chats.every(chat => completed.has(chat))) continue;
    return { at: new Date(time).toISOString(), remaining: plan.chats.map((chat, index) => ({ chat, params: plan.params[index] })).filter(item => !completed.has(item.chat)) };
  }
  return null;
}

export async function runDueSchedules({ scope, token, db, store, adapter, now = Date.now(), dispatchOperation, maxJobs = 10 }) {
  const instant = typeof now === "function" ? now() : Number(now);
  if (!Number.isFinite(instant)) throw new TypeError("A valid scheduler timestamp is required.");
  if (typeof dispatchOperation !== "function") throw new TypeError("An idempotent operation dispatcher is required.");
  const limit = Math.max(1, Math.min(SCHEDULE_LIMITS.jobs_per_run, Number.isInteger(maxJobs) ? maxJobs : 10));
  const summary = { sent: 0, rejected: 0, unknown: 0, skipped: 0, halted: 0, attempted: 0, jobs: [] };
  const resources = await db.listResources(scope, "schedules", { limit: 500, offset: 0 });
  for (const resource of resources) {
    if (summary.attempted >= limit) break;
    let plan;
    try { plan = schedulePlan(resource); } catch { plan = null; }
    if (!plan) { summary.skipped++; continue; }
    const jobs = await store.listScheduleJobs(scope, plan.id);
    try { safeData(plan.data, token); } catch { summary.skipped++; continue; }
    const content_hash = await hash(plan.data);
    if ((jobs ?? []).some(job => job.content_hash !== content_hash)) { summary.halted++; continue; }
    const occurrence = nextOccurrence(plan, jobs ?? [], instant);
    if (!occurrence) continue;
    if (occurrence.halted) { summary.halted++; continue; }
    for (const { chat, params } of occurrence.remaining) {
      if (summary.attempted >= limit) break;
      let registered = true;
      for (const destination of destinations(plan.method, params)) if (!await db.getChat(scope, destination)) registered = false;
      if (!registered) { summary.skipped++; continue; }
      const claim = await store.claimSchedule(scope, { schedule_id: plan.id, occurrence_at: occurrence.at, destination: chat, snapshot: plan.data, content_hash });
      if (!claim.claimed) { summary.skipped++; if (!["success", "blocked"].includes(claim.status)) { summary.halted++; break; } continue; }
      summary.attempted++;
      const started = Date.now();
      let outcome;
      try {
        outcome = await dispatchOperation({ scope, token, db, adapter, authorized: true, method: plan.method, params, operation_id: claim.operation_id });
      } catch (error) {
        outcome = { status: error.details?.outcome === "rejected" ? "rejected" : "unknown", error_code: /^[A-Z0-9_]{1,80}$/u.test(error.code ?? "") ? error.code : "OPERATION_UNCONFIRMED" };
      }
      const status = outcome.status === "success" ? "success" : outcome.status === "rejected" || outcome.status === "blocked" ? "rejected" : "unknown";
      const error_code = /^[A-Z0-9_]{1,80}$/u.test(outcome.error_code ?? "") ? outcome.error_code : status === "success" ? null : "OPERATION_UNCONFIRMED";
      let recording_pending = false;
      try {
        if (await store.finishSchedule(scope, claim.operation_id, status, error_code) !== true) throw new Error("The schedule result was not recorded.");
        await db.audit(scope, { action: "schedule", status: outcome.status ?? status, schedule_id: plan.id, operation_id: claim.operation_id, chat_id: chat, occurred_at: new Date(instant).toISOString(), latency_ms: Math.max(0, Date.now() - started) });
      } catch { recording_pending = true; }
      summary[status === "success" ? "sent" : status]++;
      summary.jobs.push({ schedule_id: plan.id, operation_id: claim.operation_id, chat_id: chat, occurrence_at: occurrence.at, status, ...(recording_pending ? { recording_pending: true } : {}), ...(error_code ? { error_code } : {}) });
      if (status !== "success" || recording_pending) { summary.halted++; break; }
    }
  }
  return summary;
}
