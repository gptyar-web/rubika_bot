import test from "node:test";
import assert from "node:assert/strict";
import { ApiError } from "../supabase/functions/rubika-panel/lib/validation.js";
import { botScope, createHandler } from "../supabase/functions/rubika-panel/lib/handler.js";

const token = "TEST_token_123456789";
const salt = "test-salt-for-unit-tests-only-at-least-32";
const operation_id = "11111111-1111-4111-8111-111111111111";
const origin = "https://mozdbaranarshiya.github.io";
function request(body, customOrigin = origin) {
  return new Request("https://example.supabase.co/functions/v1/rubika-panel", { method: "POST", headers: { "Content-Type": "application/json", ...(customOrigin ? { Origin: customOrigin } : {}) }, body: JSON.stringify(body) });
}
function fixtures() {
  const chats = new Map(); const ops = new Map(); const audit = []; const calls = []; const resources = [];
  const database = {
    async rateLimit() { return true; }, async saveBot() {},
    async audit(scope, data) { audit.push({ scope, data }); },
    async listChats(scope) { return [...chats.values()].filter(chat => chat.scope === scope); },
    async getChat(scope, id) { return chats.get(`${scope}:${id}`); },
    async saveChat(scope, data) { const row = { scope, ...data }; chats.set(`${scope}:${data.chat_id}`, row); return row; },
    async deleteChat(scope, id) { const row = chats.get(`${scope}:${id}`); chats.delete(`${scope}:${id}`); return row ? [row] : []; },
    async listResources(scope, collection) { return collection === "logs" ? audit.filter(item => item.scope === scope).map(({ data }, index) => ({ id: String(index), data })) : resources.filter(item => item.scope === scope && item.collection === collection); },
    async saveResource(scope, collection, id, data) { const row = { scope, collection, id, data }; resources.push(row); return row; },
    async deleteResource() { return []; },
    async claimOperation(scope, id, hash) {
      const key = `${scope}:${id}`;
      if (ops.has(key)) return { claimed: false, ...ops.get(key) };
      ops.set(key, { request_hash: hash, status: "pending" });
      return { claimed: true, request_hash: hash, status: "pending" };
    },
    async finishOperation(scope, id, status, result, error_code) { Object.assign(ops.get(`${scope}:${id}`), { status, result, error_code }); },
    async recordEvents(scope, rows) { return rows; },
  };
  const adapter = {
    async call(activeToken, method, params) { calls.push({ activeToken, method, params }); return method === "getMe" ? { bot_id: activeToken === token ? "b1" : "b2", id: "b1", name: "Test", username: "test" } : { message_id: "m1" }; },
    pollingParams(body) { return { limit: body.limit ?? 25 }; },
  };
  const handler = createHandler({ env: { SCOPE_SALT: salt }, database, adapter });
  return { handler, database, adapter, calls, audit, chats, ops, resources };
}
async function json(handler, body) { const response = await handler(request(body)); return { status: response.status, body: await response.json() }; }
async function addChat(handler, chat_id = "g1") { return json(handler, { action: "save", token, chat_id, title: "Group", settings: {} }); }
const message = { action: "message", token, method: "sendMessage", params: { chat_id: "g1", text: "hello" }, authorized: true, operation_id };

test("health exposes actual runtime limitations and configuration readiness", async () => {
  const handler = createHandler();
  const { status, body } = await json(handler, { action: "health" });
  assert.equal(status, 200); assert.equal(body.configured, false);
  assert.equal(body.capabilities.webhook, false); assert.equal(body.capabilities.moderation, false); assert.equal(body.capabilities.scheduling, false);
  assert.equal((await json(handler, { action: "login", token })).status, 503);
});

test("strict CORS and JSON body validation reject unauthorized origins and content", async () => {
  const { handler } = fixtures();
  const denied = await handler(request({ action: "health" }, "https://evil.example"));
  assert.equal(denied.status, 403); assert.equal(denied.headers.get("access-control-allow-origin"), null);
  const invalid = new Request("https://example.test", { method: "POST", body: "{}" });
  assert.equal((await handler(invalid)).status, 415);
  const oversized = request({ action: "health", text: "x".repeat(65536) });
  assert.equal((await handler(oversized)).status, 413);
});

test("legacy group CRUD survives and every authenticated call validates getMe", async () => {
  const { handler, calls } = fixtures();
  assert.equal((await addChat(handler)).body.applied, false);
  const listed = await json(handler, { action: "list", token });
  assert.equal(listed.body.groups.length, 1); assert.equal(listed.body.groups[0].type, "group"); assert.equal("scope" in listed.body.groups[0], false);
  assert.equal((await json(handler, { action: "delete", token, chat_id: "g1" })).body.deleted, true);
  assert.equal(calls.filter(call => call.method === "getMe").length, 3);
});

test("scope is stable for a bot and separates bot data", async () => {
  assert.equal(await botScope("b1", salt), await botScope("b1", salt));
  assert.notEqual(await botScope("b1", salt), await botScope("b2", salt));
  const { handler } = fixtures(); await addChat(handler);
  const listed = await json(handler, { action: "list", token: "OTHER_token_123456789" });
  assert.deepEqual(listed.body.groups, []);
});

test("registered destinations and explicit permission are required before mutations", async () => {
  const { handler, calls } = fixtures();
  assert.equal((await json(handler, message)).body.code, "DESTINATION_NOT_REGISTERED");
  await addChat(handler);
  assert.equal((await json(handler, { ...message, authorized: false })).body.code, "PERMISSION_REQUIRED");
  const forwarded = { ...message, method: "forwardMessage", params: { from_chat_id: "g1", to_chat_id: "g2", message_id: "m1" } };
  assert.equal((await json(handler, forwarded)).body.code, "DESTINATION_NOT_REGISTERED");
  assert.equal(calls.filter(call => call.method !== "getMe").length, 0);
});

test("concurrent duplicate mutation IDs produce exactly one upstream send", async () => {
  const { handler, calls } = fixtures(); await addChat(handler);
  const replies = await Promise.all([json(handler, message), json(handler, message)]);
  assert.equal(calls.filter(call => call.method === "sendMessage").length, 1);
  assert(replies.some(reply => reply.body.ok === true));
  const replay = await json(handler, message);
  assert.equal(replay.body.replayed, true); assert.equal(replay.body.result.message_id, "m1");
  const conflict = await json(handler, { ...message, params: { chat_id: "g1", text: "different" } });
  assert.equal(conflict.body.code, "OPERATION_CONFLICT");
});

test("unknown upstream outcomes remain non-retryable and are audited", async () => {
  const { handler, adapter, calls, audit } = fixtures(); await addChat(handler);
  const oldCall = adapter.call;
  adapter.call = async (...args) => {
    if (args[1] === "sendMessage") { calls.push({ method: "sendMessage" }); throw new ApiError(502, "RUBIKA_UNAVAILABLE", "Unknown response", { outcome: "unknown" }); }
    return oldCall(...args);
  };
  assert.equal((await json(handler, message)).body.outcome, "unknown");
  const replay = await json(handler, message);
  assert.equal(replay.status, 409); assert.equal(replay.body.outcome, "unknown");
  assert.equal(replay.body.operation_id, operation_id);
  assert.equal(calls.filter(call => call.method === "sendMessage").length, 1);
  assert(audit.some(item => item.data.status === "unknown"));
  assert(!JSON.stringify(audit).includes(token));
});

test("a confirmed upstream operation is never repeated after a database recording failure", async () => {
  const { handler, database, calls } = fixtures(); await addChat(handler);
  database.finishOperation = async () => { throw new ApiError(503, "DATABASE_UNAVAILABLE", "Unavailable"); };
  const first = await json(handler, message);
  assert.equal(first.body.code, "OPERATION_RECORDING_INCOMPLETE");
  assert.equal(first.body.outcome, "confirmed_unrecorded");
  assert.equal(first.body.operation_id, operation_id);
  const retry = await json(handler, message);
  assert.equal(retry.body.outcome, "pending");
  assert.equal(calls.filter(call => call.method === "sendMessage").length, 1);
});

test("upstream errors preserve operation ID even when failure recording is unavailable", async () => {
  const { handler, database, adapter } = fixtures(); await addChat(handler);
  const oldCall = adapter.call;
  adapter.call = async (...args) => {
    if (args[1] !== "getMe") throw new ApiError(502, "RUBIKA_UNAVAILABLE", "Unknown response", { outcome: "unknown" });
    return oldCall(...args);
  };
  database.finishOperation = async () => { throw new ApiError(503, "DATABASE_UNAVAILABLE", "Unavailable"); };
  const response = await json(handler, message);
  assert.equal(response.body.operation_id, operation_id); assert.equal(response.body.outcome, "unknown");
  assert.equal(response.body.recording_pending, true);
});

test("audit logs are immutable and resource data cannot persist the active token", async () => {
  const { handler, resources } = fixtures();
  assert.equal((await json(handler, { action: "collection_save", token, collection: "logs", data: { status: "success" } })).body.code, "AUDIT_READ_ONLY");
  assert.equal((await json(handler, { action: "collection_delete", token, collection: "logs", id: operation_id })).body.code, "AUDIT_READ_ONLY");
  assert.equal((await json(handler, { action: "collection_save", token, collection: "drafts", data: { text: token } })).status, 400);
  assert.equal(resources.length, 0);
  const saved = await json(handler, { action: "collection_save", token, collection: "schedules", data: { title: "Reminder", scheduled_at: "2026-10-15T09:00:00Z" } });
  assert.equal(saved.body.executed, false); assert.equal(resources.length, 1);
});

test("chat titles, identifiers and polled event metadata never persist the active token", async () => {
  const { handler, adapter, database, chats, audit } = fixtures();
  for (const body of [
    { action: "save", token, chat_id: "g1", title: `prefix ${token}`, settings: {} },
    { action: "save", token, chat_id: token, title: "Title", settings: {} },
    { action: "delete", token, chat_id: token },
    { ...message, params: { chat_id: token, text: "text" } },
  ]) assert.equal((await json(handler, body)).status, 400);
  assert.equal(chats.size, 0);
  const oldCall = adapter.call; const rowsSeen = [];
  adapter.call = async (...args) => args[1] === "getUpdates" ? { updates: [{ type: `NewMessage${token}`, chat_id: token, new_message: { time: 1791970000 } }] } : oldCall(...args);
  database.recordEvents = async (scope, rows) => { rowsSeen.push(...rows); return rows; };
  assert.equal((await json(handler, { action: "poll", token })).status, 200);
  assert(!JSON.stringify(rowsSeen).includes(token));
  assert(!JSON.stringify(audit).includes(token));
});

test("polling records unique event metadata without saving message content", async () => {
  const { handler, adapter, database } = fixtures();
  const oldCall = adapter.call; const rowsSeen = [];
  adapter.call = async (...args) => args[1] === "getUpdates" ? { updates: [{ type: "NewMessage", chat_id: "g1", new_message: { message_id: "m1", text: "private message", time: 1791970000 } }], next_offset_id: "offset1" } : oldCall(...args);
  database.recordEvents = async (scope, rows) => { rowsSeen.push(...rows); return rows; };
  const polled = await json(handler, { action: "poll", token });
  assert.equal(polled.body.next_offset_id, "offset1"); assert.equal(polled.body.new_events, 1);
  assert(!JSON.stringify(rowsSeen).includes("private message")); assert.equal(rowsSeen[0].event_hash.length, 64);
});

test("rate limit denial avoids Rubika calls", async () => {
  const { handler, database, calls } = fixtures(); database.rateLimit = async () => false;
  const denied = await json(handler, { action: "login", token });
  assert.equal(denied.status, 429); assert.equal(calls.length, 0);
});
