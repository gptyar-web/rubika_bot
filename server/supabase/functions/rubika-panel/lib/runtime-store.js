import { ApiError } from "./validation.js";

const PREFIX = "rubika_panel_v3_";
const scopeValue = scope => {
  if (typeof scope !== "string" || !/^[a-f0-9]{64}$/u.test(scope)) throw new ApiError(400, "INVALID_SCOPE", "Invalid runtime scope.");
  return scope;
};
const publicError = () => new ApiError(503, "RUNTIME_STORE_UNAVAILABLE", "Runtime state could not be recorded. Do not repeat an unconfirmed action.");
const ID = /^[A-Za-z0-9_:.\-]{1,160}$/u;
const SAFE_KEY = /(?:token|secret|authorization|password|passwd|api_?key|credential|private_?key)|^(?:text|message_body|raw|content|phone_number)$/iu;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const timestamp = value => typeof value === "function" ? value() : value;

// State contains counters, timestamps and hashes only. Message bodies and tokens never
// enter the runtime tables; configurable outgoing templates stay in resources.
export function sanitizeRuntimeState(input) {
  let count = 0;
  function visit(value, depth = 0, key = "") {
    if (depth > 4 || ++count > 500 || SAFE_KEY.test(key)) throw new ApiError(400, "UNSAFE_RUNTIME_STATE", "Runtime state may contain counters and identifiers only.");
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      if (value.length > 160 || !/^[A-Za-z0-9_:.,\-+ TZ/]*$/u.test(value)) throw new ApiError(400, "UNSAFE_RUNTIME_STATE", "Runtime state may contain identifiers, hashes and timestamps only.");
      return value;
    }
    if (Array.isArray(value) && value.length <= 100) return value.map(item => visit(item, depth + 1, key));
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
      return Object.fromEntries(Object.entries(value).map(([name, item]) => {
        if (!/^[a-zA-Z0-9_:.-]{1,160}$/u.test(name)) throw new ApiError(400, "UNSAFE_RUNTIME_STATE", "Invalid runtime state key.");
        return [name, visit(item, depth + 1, name)];
      }));
    }
    throw new ApiError(400, "UNSAFE_RUNTIME_STATE", "Invalid runtime state value.");
  }
  const value = visit(input);
  if (!value || Array.isArray(value) || typeof value !== "object") throw new ApiError(400, "UNSAFE_RUNTIME_STATE", "Runtime state must be an object.");
  if (JSON.stringify(value).length > 12000) throw new ApiError(400, "UNSAFE_RUNTIME_STATE", "Runtime state exceeds the size limit.");
  return value;
}

export function sanitizeSession(input, { token, now = Date.now() } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) || !["flow", "menu"].includes(input.kind)) throw new ApiError(400, "INVALID_SESSION", "Invalid interaction session.");
  const allowed = ["kind", "stage", "bot_id", "chat_id", "user_id", "flow_id", "menu_id", "step", "path", "page", "consented", "values", "answers", "expires_at"];
  if (Object.keys(input).some(name => !allowed.includes(name))) throw new ApiError(400, "INVALID_SESSION", "Unknown interaction session field.");
  if (token && JSON.stringify(input).includes(token)) throw new ApiError(400, "UNSAFE_SESSION", "Credentials may not be stored in interaction sessions.");
  if (input.stage !== undefined && !["awaiting_consent", "answering", "completed"].includes(input.stage)) throw new ApiError(400, "INVALID_SESSION", "Invalid interaction stage.");
  if (Object.keys(input.values ?? {}).length && Object.keys(input.answers ?? {}).length) throw new ApiError(400, "INVALID_SESSION", "Use a single collection of consented answers.");
  const values = input.answers ?? input.values ?? {};
  if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).length > 20) throw new ApiError(400, "INVALID_SESSION", "Invalid collected fields.");
  if (input.consented !== true && Object.keys(values).length) throw new ApiError(400, "CONSENT_REQUIRED", "Collected fields require explicit consent.");
  for (const [name, value] of Object.entries(values)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(name) || /token|secret|authorization|password|passwd|api_?key|credential|private_?key/iu.test(name)) throw new ApiError(400, "UNSAFE_SESSION", "Credential fields may not be collected.");
    if (!["string", "number", "boolean"].includes(typeof value) || (typeof value === "number" && !Number.isFinite(value)) || (typeof value === "string" && (value.length > 500 || (token && value.includes(token))))) throw new ApiError(400, "UNSAFE_SESSION", "Invalid collected field value.");
  }
  const metadata = sanitizeRuntimeState(Object.fromEntries(Object.entries(input).filter(([name]) => !["values", "answers", "expires_at"].includes(name))));
  now = timestamp(now);
  if (!Number.isFinite(now)) throw new ApiError(400, "INVALID_SESSION", "A valid session timestamp is required.");
  const requested = input.expires_at === undefined ? now + 900000 : new Date(input.expires_at).getTime();
  if (!Number.isFinite(requested) || requested <= now) throw new ApiError(400, "INVALID_SESSION", "Session expiry must be in the future.");
  return { ...metadata, [input.answers !== undefined ? "answers" : "values"]: values, expires_at: new Date(Math.min(requested, now + 900000)).toISOString() };
}

export function createRuntimeStore({ url, key, fetcher = fetch, now = Date.now }) {
  if (!url || !key) throw new ApiError(503, "CONFIGURATION_REQUIRED", "Private Supabase runtime configuration is required.");
  const base = new URL(url);
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1", "kong"].includes(base.hostname)) throw new ApiError(503, "CONFIGURATION_REQUIRED", "Runtime storage requires HTTPS outside localhost.");
  async function request(path, { method = "GET", body, prefer } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      let response;
      try {
        response = await fetcher(new URL(`/rest/v1/${path}`, base), {
          method, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal, redirect: "error",
        });
      } catch { throw publicError(); }
      if (!response.ok) throw publicError();
      if (response.status === 204) return null;
      const raw = await response.text();
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { throw publicError(); }
    } finally { clearTimeout(timer); }
  }
  const rpc = (name, body) => request(`rpc/${PREFIX}${name}`, { method: "POST", body });
  const filter = (scope, values = {}) => new URLSearchParams({ scope: `eq.${scopeValue(scope)}`, ...Object.fromEntries(Object.entries(values).map(([name, value]) => [name, `eq.${value}`])) });
  function id(value) { if (typeof value !== "string" || !ID.test(value)) throw new ApiError(400, "INVALID_RUNTIME_ID", "Invalid runtime identifier."); return value; }
  function uuid(value) { if (typeof value !== "string" || !UUID.test(value)) throw new ApiError(400, "INVALID_RUNTIME_ID", "Invalid runtime UUID."); return value; }
  const instant = () => { const value = timestamp(now); if (!Number.isFinite(value)) throw new ApiError(400, "INVALID_RUNTIME_TIME", "A valid runtime timestamp is required."); return new Date(value).toISOString(); };
  async function purgeExpiredSessions(scope) {
    const query = filter(scope); query.set("expires_at", `lte.${instant()}`);
    return request(`${PREFIX}sessions?${query}`, { method: "DELETE" });
  }
  return {
    async acquireLease(scope, owner, ttlSecs = 60) {
      if (!Number.isInteger(ttlSecs) || ttlSecs < 15 || ttlSecs > 300) throw new ApiError(400, "INVALID_LEASE", "Lease duration must be 15–300 seconds.");
      return rpc("acquire_lease", { p_scope: scopeValue(scope), p_owner: id(owner), p_ttl: ttlSecs });
    },
    async releaseLease(scope, owner) { return rpc("release_lease", { p_scope: scopeValue(scope), p_owner: id(owner) }); },
    async setEnabled(scope, enabled) {
      if (typeof enabled !== "boolean") throw new ApiError(400, "INVALID_RUNTIME_STATUS", "Runtime enabled must be boolean.");
      return rpc("set_enabled", { p_scope: scopeValue(scope), p_enabled: enabled });
    },
    async getRuntime(scope) {
      const rows = await request(`${PREFIX}runtime?${filter(scope)}`);
      if (!rows?.length) return null;
      const { scope: ignored, lease_owner: ignoredOwner, ...state } = rows[0];
      return state;
    },
    async saveRuntime(scope, data, owner) {
      const fields = {};
      if (data.offset_id !== undefined) fields.offset_id = data.offset_id === null ? null : id(data.offset_id);
      if (data.last_error_code !== undefined) fields.last_error_code = data.last_error_code === null ? null : id(data.last_error_code);
      if (data.status !== undefined) {
        if (!["idle", "running", "paused", "error"].includes(data.status)) throw new ApiError(400, "INVALID_RUNTIME_STATUS", "Invalid runtime status.");
        fields.status = data.status;
      }
      return rpc("save_runtime", { p_scope: scopeValue(scope), p_owner: owner ? id(owner) : null, p_data: fields });
    },
    async claimEvent(scope, eventKey, metadata = {}) {
      const allowed = Object.fromEntries(["type", "chat_id", "user_id", "message_id", "occurred_at"].filter(name => metadata[name] !== undefined).map(name => [name, metadata[name]]));
      return rpc("claim_event", { p_scope: scopeValue(scope), p_key: id(eventKey), p_metadata: sanitizeRuntimeState(allowed) });
    },
    async finishEvent(scope, eventKey, status, summary = {}) {
      if (!["success", "skipped", "rejected", "unknown"].includes(status)) throw new ApiError(400, "INVALID_EVENT_STATUS", "Invalid event status.");
      return rpc("finish_event", { p_scope: scopeValue(scope), p_key: id(eventKey), p_status: status, p_summary: sanitizeRuntimeState(summary) });
    },
    async getUserState(scope, chat_id, user_id) {
      const rows = await request(`${PREFIX}user_state?${filter(scope, { chat_id: id(chat_id), user_id: id(user_id) })}`);
      return rows?.[0]?.state ?? {};
    },
    async saveUserState(scope, chat_id, user_id, state) {
      return request(`${PREFIX}user_state?on_conflict=scope,chat_id,user_id`, { method: "POST", body: { scope: scopeValue(scope), chat_id: id(chat_id), user_id: id(user_id), state: sanitizeRuntimeState(state), updated_at: instant() }, prefer: "resolution=merge-duplicates,return=representation" });
    },
    async listMetrics(scope, from, to) {
      const query = filter(scope); query.set("order", "received_at.desc"); query.set("limit", "5000");
      if (from) query.set("metadata->>occurred_at", `gte.${new Date(from).toISOString()}`);
      if (to) query.append("metadata->>occurred_at", `lte.${new Date(to).toISOString()}`);
      const rows = await request(`${PREFIX}runtime_events?${query}`);
      return (rows ?? []).map(({ event_key, metadata, summary, status, received_at }) => ({ event_key, ...metadata, summary, status, received_at }));
    },
    async getSession(scope, chat_id, user_id) {
      await purgeExpiredSessions(scope);
      const query = filter(scope, { chat_id: id(chat_id), user_id: id(user_id) });
      query.set("expires_at", `gt.${instant()}`);
      const rows = await request(`${PREFIX}sessions?${query}`);
      return rows?.[0]?.data ?? null;
    },
    async saveSession(scope, chat_id, user_id, input, security = {}) {
      const data = sanitizeSession(input, { now: timestamp(now), ...security });
      await purgeExpiredSessions(scope);
      return request(`${PREFIX}sessions?on_conflict=scope,chat_id,user_id`, { method: "POST", body: { scope: scopeValue(scope), chat_id: id(chat_id), user_id: id(user_id), data, expires_at: data.expires_at, updated_at: instant() }, prefer: "resolution=merge-duplicates,return=representation" });
    },
    purgeExpiredSessions,
    async listSessions(scope) {
      await purgeExpiredSessions(scope);
      const query = filter(scope); query.set("data->>consented", "eq.true"); query.set("expires_at", `gt.${instant()}`); query.set("order", "updated_at.desc"); query.set("limit", "100");
      const rows = await request(`${PREFIX}sessions?${query}`);
      return (rows ?? []).map(({ scope: ignoredScope, ...row }) => row);
    },
    async deleteSession(scope, chat_id, user_id) { return request(`${PREFIX}sessions?${filter(scope, { chat_id: id(chat_id), user_id: id(user_id) })}`, { method: "DELETE" }); },
    async listScheduleJobs(scope, schedule_id) {
      const query = filter(scope, { schedule_id: uuid(schedule_id) }); query.set("order", "occurrence_at.asc"); query.set("limit", "10000");
      return request(`${PREFIX}schedule_jobs?${query}`);
    },
    async claimSchedule(scope, { schedule_id, occurrence_at, destination, snapshot, content_hash }) {
      if (typeof content_hash !== "string" || !/^[a-f0-9]{64}$/u.test(content_hash) || !Number.isFinite(Date.parse(occurrence_at))) throw new ApiError(400, "INVALID_JOB", "Invalid scheduled occurrence.");
      return rpc("claim_schedule", { p_scope: scopeValue(scope), p_schedule_id: uuid(schedule_id), p_occurrence: new Date(occurrence_at).toISOString(), p_destination: id(destination), p_snapshot: snapshot, p_hash: content_hash });
    },
    async finishSchedule(scope, operation_id, status, error_code = null) {
      if (!["success", "rejected", "unknown"].includes(status)) throw new ApiError(400, "INVALID_JOB_STATUS", "Invalid schedule status.");
      return rpc("finish_schedule", { p_scope: scopeValue(scope), p_operation: uuid(operation_id), p_status: status, p_error: error_code ? id(error_code) : null });
    },
  };
}
