import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Window } from "happy-dom";
import "fake-indexeddb/auto";
import { Actions } from "../js/actions.js";
import { Vault } from "../js/vault.js";
import { initialState } from "../js/utils.js";
import { pageFor } from "../js/pages.js";
import { closeModal } from "../js/ui.js";
const window = new Window({ url: "https://example.test/rubika_bot/" });
const document = window.document;
document.body.innerHTML =
  '<div id="app"></div><dialog id="modal"></dialog><div id="toasts"></div>';
globalThis.FormData = window.FormData;
globalThis.document = document;
globalThis.window = window;
globalThis.requestAnimationFrame = window.requestAnimationFrame.bind(window);
const state = initialState(),
  requests = [],
  vault = { state };
const app = {
  vault,
  ctx: { days: 7 },
  api: {
    call: async (token, method, payload) => {
      requests.push({ method, payload });
      if (method === "getMe")
        return { bot: { bot_id: "bot-api-id", username: "test_bot" } };
      if (method === "getChat")
        return { chat: { chat_id: payload.chat_id, chat_type: "Group" } };
      if (method === "sendMessage") return { message_id: "message-api-id" };
      return {};
    },
  },
  persist: async () => {},
  render: () => {},
};
const actions = new Actions(app);
const modal = () => document.querySelector("#modal");
function value(name, v) {
  const el = modal().querySelector(`[name="${name}"]`);
  assert(el, `Missing form field ${name}`);
  el.value = v;
}
function checked(name, v) {
  const el = modal().querySelector(`[name="${name}"]`);
  assert(el);
  el.checked = v;
}
async function submit() {
  const form = modal().querySelector("form");
  assert(form);
  await form.onsubmit({ preventDefault() {} });
}
function error() {
  return modal().querySelector(".form-error")?.textContent;
}
test("DOM integration: validated forms, encrypted state model and API writes", async () => {
  actions.addBot();
  value("name", "بات آزمون");
  value("token", "SYNTHETIC_TOKEN");
  checked("verify", true);
  await submit();
  assert.equal(state.bots.length, 1);
  assert.equal(state.bots[0].botId, "bot-api-id");
  assert.equal(modal().open, false);
  actions.addBot();
  value("name", "دوباره");
  value("token", "SYNTHETIC_TOKEN");
  await submit();
  assert.match(error(), /قبلاً/);
  assert.equal(state.bots.length, 1);
  closeModal();
  actions.chatForm("Group");
  value("name", "گروه آزمون");
  value("chatId", "chat-id");
  checked("consent", true);
  checked("verify", true);
  await submit();
  assert.equal(state.chats.length, 1);
  assert.equal(state.chats[0].verified, true);
  actions.compose();
  value("text", "پیام آزمایشی");
  await submit();
  assert.equal(state.messages.length, 1);
  assert.equal(requests.at(-1).method, "sendMessage");
  assert.equal(state.messages[0].status, "sent");
  const original = app.api.call;
  app.api.call = async () => ({});
  actions.compose();
  value("text", "نباید موفق شود");
  await submit();
  assert.match(error(), /شناسهٔ پیام/);
  assert.equal(state.messages.length, 1);
  closeModal();
  app.api.call = original;
  actions.ruleForm();
  value("name", "قانون سلام");
  value("trigger", "سلام");
  value("response", "درود");
  await submit();
  assert.equal(state.rules.length, 1);
  actions.templateForm();
  value("name", "قالب");
  value("text", "سلام {{name}}");
  value("buttons", "help:راهنما | contact:تماس");
  await submit();
  assert.equal(state.templates[0].keypad.rows[0].buttons.length, 2);
  actions.templateForm();
  value("name", "غلط");
  value("text", "تست");
  value("buttons", "x:الف | x:ب");
  await submit();
  assert.match(error(), /یکتای/);
  closeModal();
  actions.postForm();
  value("title", "پست");
  value("text", "محتوا");
  checked("destinations", true);
  await submit();
  assert.equal(state.posts.length, 1);
  assert.equal(state.posts[0].status, "draft");
  actions.postForm();
  value("title", "پست دیگر");
  value("text", "محتوا");
  checked("destinations", true);
  await submit();
  assert.match(error(), /یکسان/);
  assert.equal(state.posts.length, 1);
  closeModal();
  actions.approvePost(state.posts[0].id);
  value("scheduledAt", "2099-10-15T12:30");
  checked("approved", true);
  await submit();
  assert.equal(state.posts[0].status, "scheduled");
  assert.equal(state.posts[0].scheduledAt, "2099-10-15T09:00:00.000Z");
  actions.addTicket();
  value("subject", "پشتیبانی");
  value("text", "کمک");
  await submit();
  assert.equal(state.tickets.length, 1);
  assert.equal(state.tickets[0].history.length, 1);
  await actions.settings(
    new FormData(
      (() => {
        const form = document.createElement("form");
        form.innerHTML =
          '<input name="panelName" value="تیم"><input name="idleMinutes" value="15"><input name="transport" value="direct"><input name="relayUrl" value=""><input name="relayKey" value="">';
        return form;
      })(),
    ),
  );
  assert.equal(state.settings.panelName, "تیم");
});
test("all page renderers escape hostile values and have working target elements", async () => {
  const features = JSON.parse(await readFile("docs/features.json", "utf8"));
  const hostile = "<img src=x onerror=alert(1)>";
  state.bots[0].name = hostile;
  state.chats[0].name = hostile;
  state.messages[0].text = hostile;
  state.templates[0].text = hostile;
  state.posts[0].title = hostile;
  for (const route of [
    "dashboard",
    "bots",
    "groups",
    "channels",
    "messages",
    "locks",
    "automation",
    "schedule",
    "templates",
    "tickets",
    "users",
    "reports",
    "logs",
    "features",
    "settings",
  ]) {
    const body = pageFor(
      route,
      state,
      { days: 7, query: "", running: false },
      features,
    );
    document.querySelector("#app").innerHTML = body;
    assert(document.querySelector("h1"), route);
    assert.equal(document.querySelector("#app [onerror]"), null, route);
    assert(!body.includes("<img src=x onerror"));
  }
  document.querySelector("#app").innerHTML = pageFor(
    "features",
    state,
    { query: "" },
    features,
  );
  assert.equal(document.querySelectorAll("tbody tr").length, 150);
});
