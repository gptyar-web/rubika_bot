import test from "node:test";
import assert from "node:assert/strict";
import { buildMessage, createRubikaAdapter } from "../supabase/functions/rubika-panel/lib/adapter.js";
import { safeData } from "../supabase/functions/rubika-panel/lib/validation.js";

const token = "TEST_token_123456789";

test("message adapter whitelists methods and fields", () => {
  assert.throws(() => buildMessage("banChatMember", { chat_id: "g1" }), { code: "UNSUPPORTED_METHOD" });
  assert.deepEqual(buildMessage("sendMessage", { chat_id: "g1", text: "hello", token: "ignored", reply_to_message_id: "m1" }), { chat_id: "g1", text: "hello", reply_to_message_id: "m1" });
  assert.deepEqual(buildMessage("forwardMessage", { from_chat_id: "g1", to_chat_id: "g2", message_id: "m1" }), { from_chat_id: "g1", to_chat_id: "g2", message_id: "m1" });
});

test("validation rejects malformed destinations, polls, locations and keypads", () => {
  assert.throws(() => buildMessage("sendMessage", { chat_id: "g1&scope=eq.other", text: "hello" }));
  assert.throws(() => buildMessage("sendPoll", { chat_id: "g1", question: "q", options: ["a", "a"] }));
  assert.throws(() => buildMessage("sendLocation", { chat_id: "g1", latitude: 91, longitude: 0 }));
  assert.throws(() => buildMessage("sendLocation", { chat_id: "g1", latitude: "", longitude: 0 }));
  assert.throws(() => buildMessage("sendMessage", { chat_id: "g1", text: "text", inline_keypad: { rows: [{ buttons: [{ id: "url", type: "Link", button_text: "link" }] }] } }));
});

test("generic resources reject secret fields and literal active tokens", () => {
  assert.throws(() => safeData({ nested: { bot_token: token } }, token));
  assert.throws(() => safeData({ description: `paste ${token}` }, token));
  assert.throws(() => safeData({ nested: { password: "credential" } }, token));
  for (const key of ["botToken", "apiKey", "access_token", "refreshToken", "service-role-key"]) assert.throws(() => safeData({ nested: { [key]: "another-credential" } }, token));
  assert.deepEqual(safeData({ role: "support", text: "سلام" }, token), { role: "support", text: "سلام" });
});

test("Rubika response shapes are normalized without claiming missing send results", async () => {
  const calls = [];
  const adapter = createRubikaAdapter({ fetcher: async (url, options) => {
    calls.push({ url, options });
    return Response.json({ status: "OK", data: { bot: { bot_id: "b1", bot_title: "Test bot", username: "test" } } });
  } });
  assert.deepEqual(await adapter.call(token, "getMe"), { bot_id: "b1", id: "b1", name: "Test bot", username: "test" });
  assert.equal(calls[0].options.redirect, "error");
  const missing = createRubikaAdapter({ fetcher: async () => Response.json({ status: "OK", data: {} }) });
  await assert.rejects(missing.call(token, "sendMessage", { chat_id: "g1", text: "hello" }), { code: "INVALID_RUBIKA_RESPONSE" });
  assert.deepEqual(await missing.call(token, "deleteMessage", { chat_id: "g1", message_id: "m1" }), {});
});

test("Rubika errors never contain token, raw upstream descriptions, or request URLs", async () => {
  const broken = createRubikaAdapter({ fetcher: async url => { throw Error(`fetch failed ${url}`); } });
  await assert.rejects(broken.call(token, "getMe"), error => !error.message.includes(token) && error.details.outcome === "unknown");
  const rejected = createRubikaAdapter({ fetcher: async () => Response.json({ status: "INVALID_TOKEN", description: token }, { status: 401 }) });
  await assert.rejects(rejected.call(token, "getMe"), error => error.status === 401 && !error.message.includes(token));
  const uppercaseToken = "UPPERCASE_TEST_TOKEN_12345";
  const unusualStatus = createRubikaAdapter({ fetcher: async () => Response.json({ status: uppercaseToken }, { status: 400 }) });
  await assert.rejects(unusualStatus.call(uppercaseToken, "getMe"), error => !JSON.stringify({ message: error.message, details: error.details }).includes(uppercaseToken));
  assert.throws(() => createRubikaAdapter({ base: "http://localhost/private" }), { code: "CONFIGURATION_REQUIRED" });
});
