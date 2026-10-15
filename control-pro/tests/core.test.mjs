import test from "node:test";
import assert from "node:assert/strict";
import {
  deriveKey,
  seal,
  openEnvelope,
  validateEnvelope,
  ITERATIONS,
} from "../js/vault.js";
import {
  initialState,
  csv,
  esc,
  safePattern,
  renderTemplate,
  localInputISO,
  inQuietHours,
  validateState,
} from "../js/utils.js";
import { RubikaAPI, messagePayload } from "../js/api.js";
import { violationsFor, ruleMatches } from "../js/moderation.js";
import { parseKeypadText, makeKeypad } from "../js/keypad.js";
import { Runtime, eventKey } from "../js/runtime.js";
const password = "test vault passphrase 2026";
const token = "SYNTHETIC_TEST_TOKEN_ONLY";
const response = (data) => ({
  ok: true,
  status: 200,
  json: async () => ({ status: "OK", data }),
});
test("AES-GCM vault round-trip; token absent from persistent envelope; fresh IV", async () => {
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    key = await deriveKey(password, salt),
    state = initialState();
  state.bots.push({ id: "b1", token });
  const a = await seal(state, key, salt),
    b = await seal(state, key, salt);
  assert.notEqual(a.iv, b.iv);
  assert(!JSON.stringify(a).includes(token));
  assert.equal((await openEnvelope(a, password)).state.bots[0].token, token);
  assert.equal(a.iterations, ITERATIONS);
});
test("wrong password and tampered ciphertext are rejected", async () => {
  const salt = crypto.getRandomValues(new Uint8Array(16)),
    key = await deriveKey(password, salt),
    e = await seal(initialState(), key, salt);
  await assert.rejects(openEnvelope(e, "wrong password"));
  const bytes = Uint8Array.from(atob(e.data), (c) => c.charCodeAt(0));
  bytes[0] ^= 1;
  const corrupt = { ...e, data: btoa(String.fromCharCode(...bytes)) };
  await assert.rejects(openEnvelope(corrupt, password));
});
test("unsupported backups and KDF parameters are rejected without weak fallback", () => {
  assert.throws(() =>
    validateEnvelope({
      format: "rubika-control-pro",
      version: 1,
      iterations: 1,
    }),
  );
  assert.throws(() =>
    validateState({ ...initialState(), bots: [{ id: "a" }] }),
  );
  assert.throws(() =>
    validateState({
      ...initialState(),
      settings: { transport: "attacker", idleMinutes: 15 },
    }),
  );
});
test("reading retries transient failures; writing never blindly repeats", async () => {
  let calls = 0;
  const api = new RubikaAPI({
    fetchImpl: async () => {
      calls++;
      if (calls < 3) throw new TypeError("failure " + token);
      return response({ bot: { bot_id: "b1" } });
    },
    sleep: async () => {},
  });
  assert.equal((await api.call(token, "getMe")).bot.bot_id, "b1");
  assert.equal(calls, 3);
  calls = 0;
  await assert.rejects(
    api.call(token, "sendMessage", { text: "hi" }),
    (e) => !e.message.includes(token),
  );
  assert.equal(calls, 1);
});
test("API rejection and malformed response never report success", async () => {
  const rejected = new RubikaAPI({
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ status: "ERROR", message: token }),
    }),
  });
  await assert.rejects(
    rejected.call(token, "getMe"),
    (e) => e.code === "REJECTED" && !e.message.includes(token),
  );
  const bad = new RubikaAPI({
    fetchImpl: async () => ({
      ok: true,
      json: async () => {
        throw Error();
      },
    }),
  });
  await assert.rejects(bad.call(token, "getMe"));
  await assert.rejects(bad.call(token, "undocumentedMethod"));
});
test("API endpoint is fixed and relay requires HTTPS and authentication", async () => {
  let url, options;
  const api = new RubikaAPI({
    fetchImpl: async (u, o) => {
      url = u;
      options = o;
      return response({});
    },
  });
  await api.call(token, "getMe");
  assert.equal(url, "https://botapi.rubika.ir/v3/" + token + "/getMe");
  assert.equal(options.credentials, "omit");
  const relay = new RubikaAPI({
    settings: () => ({
      transport: "relay",
      relayUrl: "http://bad.example",
      relayKey: "a",
    }),
  });
  await assert.rejects(relay.call(token, "getMe"));
});
test("message types validate their documented payload fields", () => {
  assert.throws(() => messagePayload("text", { chatId: "a", text: " " }));
  assert.throws(() =>
    messagePayload("location", {
      chatId: "a",
      latitude: "999",
      longitude: "1",
    }),
  );
  assert.throws(() =>
    messagePayload("poll", { chatId: "a", question: "Q", options: "one" }),
  );
  assert.equal(
    messagePayload("text", { chatId: "a", text: "سلام", replyId: "m1" }).payload
      .reply_to_message_id,
    "m1",
  );
  assert.deepEqual(
    messagePayload("poll", { chatId: "a", question: "Q", options: "yes\nno" })
      .payload.options,
    ["yes", "no"],
  );
});
test("moderation respects trusted admins, exemptions, disabled processing and scoped rate limit", () => {
  const m = {
      sender_id: "u1",
      sender_type: "User",
      text: "سلام https://evil.test",
    },
    chat = {
      botId: "b1",
      chatId: "c1",
      moderationEnabled: true,
      locks: { links: true },
      adminIds: ["admin"],
      exemptIds: ["vip"],
      floodLimit: 2,
      floodSeconds: 10,
    };
  assert.deepEqual(violationsFor({ ...m, sender_id: "admin" }, chat), []);
  assert.deepEqual(violationsFor({ ...m, sender_id: "vip" }, chat), []);
  assert.deepEqual(violationsFor(m, { ...chat, moderationEnabled: false }), []);
  assert(violationsFor(m, chat).includes("لینک غیرمجاز"));
  const now = new Date(),
    recent = [
      { botId: "b2", chatId: "c1", userId: "u1", at: now.toISOString() },
    ];
  assert(
    !violationsFor(m, { ...chat, floodLimit: 1 }, recent, now).includes(
      "ارسال پشت‌سرهم",
    ),
  );
});
test("allowed domain handling rejects suffix impersonation", () => {
  const chat = {
    moderationEnabled: true,
    locks: { links: true },
    allowedDomains: ["example.com"],
  };
  assert.deepEqual(
    violationsFor({ sender_id: "u", text: "https://sub.example.com/a" }, chat),
    [],
  );
  assert(
    violationsFor(
      { sender_id: "u", text: "https://example.com.evil.test" },
      chat,
    ).length,
  );
});
test("safe patterns reject catastrophic repetition and invalid regex; Persian input normalized", () => {
  assert.throws(() => safePattern("(a+)+$"));
  assert.throws(() => safePattern("["));
  assert(
    ruleMatches({ enabled: true, trigger: "کتاب", type: "keyword" }, "كتاب"),
  );
  assert(safePattern("^تبلیغ|فروش").test("تبلیغ سلام"));
});
test("time windows and scheduled inputs use Tehran, independent of device timezone", () => {
  assert.equal(localInputISO("2026-10-15T15:30"), "2026-10-15T12:00:00.000Z");
  assert(
    inQuietHours(
      { start: "22:00", end: "06:00" },
      new Date("2026-10-15T20:00:00Z"),
    ),
  );
  assert(
    !inQuietHours(
      { start: "22:00", end: "06:00" },
      new Date("2026-10-15T12:00:00Z"),
    ),
  );
});
test("escaping, CSV injection mitigation, templates and keypad ID uniqueness", () => {
  assert.equal(esc('<img onerror="x">'), "&lt;img onerror=&quot;x&quot;&gt;");
  assert(csv([{ x: '=HYPERLINK("bad")' }]).includes("'=HYPERLINK"));
  assert.equal(
    renderTemplate("سلام {{name}} {{missing}}", { name: "مینا" }),
    "سلام مینا ",
  );
  assert.equal(parseKeypadText("help:راهنما | تماس").rows[0].buttons.length, 2);
  assert.throws(() =>
    makeKeypad([
      [
        { id: "x", text: "a" },
        { id: "x", text: "b" },
      ],
    ]),
  );
});
function runner() {
  const state = initialState();
  const bot = { id: "b1", token, name: "بات", enabled: true };
  state.bots.push(bot);
  state.chats.push({
    id: "c",
    botId: "b1",
    chatId: "chat",
    name: "گروه",
    consent: true,
    moderationEnabled: false,
  });
  let calls = [];
  const rt = new Runtime({
    state: () => state,
    persist: async () => {},
    api: {
      call: async (t, m, p) => {
        calls.push({ m, p });
        return { message_id: "out" + calls.length };
      },
    },
  });
  rt.running = true;
  return { state, bot, rt, calls };
}
test("event checkpoint prevents duplicate replies and unknown destinations are ignored", async () => {
  const { state, bot, rt, calls } = runner();
  state.rules.push({
    id: "r",
    botId: "b1",
    type: "exact",
    trigger: "سلام",
    response: "درود",
    enabled: true,
  });
  const update = {
    type: "NewMessage",
    chat_id: "chat",
    new_message: {
      message_id: "m1",
      sender_id: "u1",
      sender_type: "User",
      text: "سلام",
    },
  };
  await rt.processUpdate(bot, update);
  await rt.processUpdate(bot, update);
  assert.equal(calls.length, 1);
  assert.equal(state.events.length, 1);
  await rt.processUpdate(bot, { ...update, chat_id: "unknown" });
  assert.equal(state.events.length, 1);
  assert.equal(eventKey(bot.id, { chat_id: "chat", event_data: {} }), null);
});
test("bot echoes never trigger auto replies", async () => {
  const { state, bot, rt, calls } = runner();
  state.rules.push({
    id: "r",
    botId: "b1",
    type: "keyword",
    trigger: "hi",
    response: "hi",
    enabled: true,
  });
  await rt.processUpdate(bot, {
    type: "NewMessage",
    chat_id: "chat",
    new_message: { message_id: "m", text: "hi", sender_type: "Bot" },
  });
  assert.equal(calls.length, 0);
});
test("queue skips successful destinations, records unknown failures and never publishes stale posts", async () => {
  const { state, rt, calls } = runner();
  state.posts.push({
    id: "p",
    botId: "b1",
    title: "پست",
    text: "متن",
    chatIds: ["chat"],
    status: "scheduled",
    scheduledAt: new Date(Date.now() - 1000).toISOString(),
    deliveries: { chat: { status: "sent", messageId: "already" } },
  });
  await rt.runQueue();
  assert.equal(calls.length, 0);
  assert.equal(state.posts[0].status, "sent");
  state.posts.push({
    id: "old",
    botId: "b1",
    title: "گذشته",
    text: "x",
    chatIds: ["chat"],
    status: "scheduled",
    scheduledAt: new Date(Date.now() - 700000).toISOString(),
    deliveries: {},
  });
  await rt.runQueue();
  assert.equal(state.posts[1].status, "missed");
  assert.equal(calls.length, 0);
});
test("queue never marks an API failure as delivered", async () => {
  const { state, rt } = runner();
  rt.api.call = async () => {
    throw new Error("network");
  };
  state.posts.push({
    id: "p",
    botId: "b1",
    title: "p",
    text: "t",
    chatIds: ["chat"],
    status: "scheduled",
    scheduledAt: new Date().toISOString(),
    deliveries: {},
  });
  await rt.runQueue();
  assert.equal(state.posts[0].status, "failed");
  assert.equal(state.posts[0].deliveries.chat.status, "unknown");
});
test("interactive flow state persists between steps; ticket created from explicit command", async () => {
  const { state, bot, rt, calls } = runner();
  state.rules.push({
    id: "flow",
    botId: "b1",
    type: "flow",
    trigger: "/form",
    response: "تمام",
    steps: ["نام؟", "شهر؟"],
    enabled: true,
  });
  const send = async (id, text) =>
    rt.processUpdate(bot, {
      type: "NewMessage",
      chat_id: "chat",
      new_message: {
        message_id: id,
        sender_id: "u",
        sender_type: "User",
        text,
      },
    });
  await send("m1", "/form");
  assert.equal(Object.keys(state.sessions).length, 1);
  await send("m2", "علی");
  assert.equal(calls.at(-1).p.text, "شهر؟");
  await send("m3", "تهران");
  assert.equal(Object.keys(state.sessions).length, 0);
  assert.equal(calls.at(-1).p.text, "تمام");
  await send("m4", "/ticket کمک");
  assert.equal(state.tickets.length, 1);
});
