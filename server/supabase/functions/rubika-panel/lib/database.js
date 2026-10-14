import { ApiError } from "./validation.js";

const TABLES = { bots: "rubika_panel_v3_bots", chats: "rubika_panel_v3_chats", resources: "rubika_panel_v3_resources", audit: "rubika_panel_v3_audit", operations: "rubika_panel_v3_operations", events: "rubika_panel_v3_events" };

export function createDatabase({ url, key, fetcher = fetch }) {
  if (!url || !key) throw new ApiError(503, "CONFIGURATION_REQUIRED", "Supabase server configuration is missing.");
  const base = new URL(url);
  if (base.protocol !== "https:" && !["localhost", "127.0.0.1", "kong"].includes(base.hostname)) throw new ApiError(503, "CONFIGURATION_REQUIRED", "Supabase must use HTTPS outside localhost.");
  async function request(path, { method = "GET", body, prefer } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      let response;
      try {
        response = await fetcher(new URL(`/rest/v1/${path}`, base), {
          method, headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json", ...(prefer ? { Prefer: prefer } : {}) },
          ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: controller.signal, redirect: "error",
        });
      } catch { throw new ApiError(503, "DATABASE_UNAVAILABLE", "The database is currently unavailable."); }
      if (!response.ok) {
        // Never expose PostgREST errors, schema internals, or private headers to callers.
        throw new ApiError(503, "DATABASE_UNAVAILABLE", "The database request failed. Check the server migration and configuration.");
      }
      if (response.status === 204) return null;
      const raw = await response.text();
      if (!raw) return null;
      try { return JSON.parse(raw); } catch { throw new ApiError(503, "DATABASE_UNAVAILABLE", "The database returned an unreadable response."); }
    } finally { clearTimeout(timer); }
  }
  const filter = (scope, values = {}) => new URLSearchParams({ scope: `eq.${scope}`, ...Object.fromEntries(Object.entries(values).map(([name, value]) => [name, `eq.${value}`])) });
  const upsert = (table, row, conflict) => request(`${table}?on_conflict=${conflict}`, { method: "POST", body: row, prefer: "resolution=merge-duplicates,return=representation" });
  return {
    async rateLimit(bucket, limit) { return request("rpc/rubika_panel_v3_rate_limit", { method: "POST", body: { p_bucket: bucket, p_limit: limit } }); },
    async saveBot(scope, bot) {
      const rows = await upsert(TABLES.bots, { scope, bot_id: bot.bot_id, name: bot.name, username: bot.username, last_seen_at: new Date().toISOString() }, "scope");
      return rows?.[0];
    },
    async listChats(scope) {
      const query = filter(scope); query.set("order", "updated_at.desc"); query.set("limit", "500");
      return request(`${TABLES.chats}?${query}`);
    },
    async getChat(scope, chat_id) {
      const rows = await request(`${TABLES.chats}?${filter(scope, { chat_id })}`);
      return rows?.[0];
    },
    async saveChat(scope, data) { return (await upsert(TABLES.chats, { scope, ...data, updated_at: new Date().toISOString() }, "scope,chat_id"))?.[0]; },
    async deleteChat(scope, chat_id) { return request(`${TABLES.chats}?${filter(scope, { chat_id })}`, { method: "DELETE", prefer: "return=representation" }); },
    async listResources(scope, collection, { limit = 500, offset = 0 } = {}) {
      const query = filter(scope, collection === "logs" ? {} : { collection });
      query.set("order", collection === "logs" ? "created_at.desc" : "updated_at.desc");
      query.set("limit", String(limit)); query.set("offset", String(offset));
      const rows = await request(`${collection === "logs" ? TABLES.audit : TABLES.resources}?${query}`);
      return rows.map(({ scope: ignoredScope, collection: ignoredCollection, ...item }) => ({ ...item, updated_at: item.updated_at ?? item.created_at }));
    },
    async saveResource(scope, collection, id, data) {
      const row = (await upsert(TABLES.resources, { scope, collection, id, data, updated_at: new Date().toISOString() }, "scope,collection,id"))?.[0];
      if (!row) throw new ApiError(503, "DATABASE_UNAVAILABLE", "The resource could not be saved.");
      const { scope: ignoredScope, collection: ignoredCollection, ...item } = row;
      return item;
    },
    async deleteResource(scope, collection, id) { return request(`${TABLES.resources}?${filter(scope, { collection, id })}`, { method: "DELETE", prefer: "return=representation" }); },
    async audit(scope, data) { return request(TABLES.audit, { method: "POST", body: { scope, data } }); },
    async claimOperation(scope, id, hash) { return request("rpc/rubika_panel_v3_claim_operation", { method: "POST", body: { p_scope: scope, p_id: id, p_hash: hash } }); },
    async finishOperation(scope, operation_id, status, result = null, error_code = null) {
      return request(`${TABLES.operations}?${filter(scope, { operation_id })}`, { method: "PATCH", body: { status, result, error_code, updated_at: new Date().toISOString() } });
    },
    async recordEvents(scope, rows) {
      if (!rows.length) return [];
      return request(`${TABLES.events}?on_conflict=scope,event_hash`, { method: "POST", body: rows.map(row => ({ scope, ...row })), prefer: "resolution=ignore-duplicates,return=representation" });
    },
  };
}
