import { ApiError, assert, identifier, integer, record, text, tokenValue } from "./validation.js";

export const MESSAGE_METHODS = Object.freeze(["sendMessage", "sendPoll", "sendLocation", "sendContact", "sendSticker", "sendFile", "forwardMessage", "editMessageText", "deleteMessage", "getChat"]);
const API_BASES = ["https://messengerg2b1.iranlms.ir/v3"];

function bool(value, field) {
  assert(typeof value === "boolean", `${field} must be boolean.`);
  return value;
}

function keypad(value) {
  record(value, "keypad");
  assert(Array.isArray(value.rows) && value.rows.length <= 20, "Keypad must have at most 20 rows.");
  return { rows: value.rows.map(row => {
    record(row, "keypad row");
    assert(Array.isArray(row.buttons) && row.buttons.length >= 1 && row.buttons.length <= 8, "Invalid keypad buttons.");
    return { buttons: row.buttons.map(button => {
      record(button, "button");
      const type = button.type ?? "Simple";
      assert(type === "Simple", "Only documented Simple keypad buttons are supported in this adapter.");
      return { id: identifier(button.id, "button.id"), type, button_text: text(button.button_text, "button_text", 100) };
    }) };
  }) };
}

function common(params, out, withKeypads = true) {
  if (params.disable_notification !== undefined) out.disable_notification = bool(params.disable_notification, "disable_notification");
  if (params.reply_to_message_id !== undefined) out.reply_to_message_id = identifier(params.reply_to_message_id, "reply_to_message_id");
  if (withKeypads && params.inline_keypad !== undefined) out.inline_keypad = keypad(params.inline_keypad);
  if (withKeypads && params.chat_keypad !== undefined) {
    out.chat_keypad = keypad(params.chat_keypad);
    assert(params.chat_keypad_type === "New", "chat_keypad_type must be New when a keypad is supplied.");
    out.chat_keypad_type = "New";
  }
}

export function buildMessage(method, params) {
  assert(MESSAGE_METHODS.includes(method), "This operation requires API support and is not enabled.", "UNSUPPORTED_METHOD");
  record(params, "params");
  const out = {};
  if (method === "forwardMessage") {
    out.from_chat_id = identifier(params.from_chat_id, "from_chat_id");
    out.to_chat_id = identifier(params.to_chat_id, "to_chat_id");
    out.message_id = identifier(params.message_id, "message_id");
    if (params.disable_notification !== undefined) out.disable_notification = bool(params.disable_notification, "disable_notification");
    return out;
  }
  out.chat_id = identifier(params.chat_id);
  if (["editMessageText", "deleteMessage"].includes(method)) out.message_id = identifier(params.message_id, "message_id");
  if (["sendMessage", "editMessageText"].includes(method)) out.text = text(params.text, "text");
  if (method === "sendPoll") {
    out.question = text(params.question, "question", 300);
    assert(Array.isArray(params.options) && params.options.length >= 2 && params.options.length <= 10, "Polls need 2–10 options.");
    out.options = params.options.map(option => text(option, "option", 100));
    assert(new Set(out.options).size === out.options.length, "Poll options must be distinct.");
  }
  if (method === "sendLocation") {
    for (const [key, bound] of [["latitude", 90], ["longitude", 180]]) {
      const value = Number(params[key]);
      assert(params[key] !== "" && params[key] !== null && Number.isFinite(value) && Math.abs(value) <= bound, `Invalid ${key}.`);
      out[key] = String(value);
    }
  }
  if (method === "sendContact") {
    out.first_name = text(params.first_name, "first_name", 100);
    out.last_name = typeof params.last_name === "string" && params.last_name.length <= 100 ? params.last_name : "";
    out.phone_number = text(params.phone_number, "phone_number", 32);
    assert(/^\+?[0-9 ()\-]{5,32}$/u.test(out.phone_number), "Invalid phone number.");
  }
  if (method === "sendSticker") out.sticker_id = identifier(params.sticker_id, "sticker_id");
  if (method === "sendFile") out.file_id = identifier(params.file_id, "file_id");
  if (method.startsWith("send")) common(params, out);
  return out;
}

export function destinations(method, params) {
  return method === "forwardMessage" ? [params.from_chat_id, params.to_chat_id] : [params.chat_id];
}

export function createRubikaAdapter({ base = API_BASES[0], fetcher = fetch, timeoutMs = 12000 } = {}) {
  base = base.replace(/\/$/u, "");
  if (!API_BASES.includes(base)) throw new ApiError(503, "CONFIGURATION_REQUIRED", "RUBIKA_API_BASE must use a verified Rubika HTTPS API host.");
  return {
    async call(token, method, params = {}) {
      tokenValue(token);
      if (!["getMe", "getUpdates", ...MESSAGE_METHODS].includes(method)) throw new ApiError(400, "UNSUPPORTED_METHOD", "Unsupported Rubika API method.");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        let response;
        try {
          response = await fetcher(`${base}/${encodeURIComponent(token)}/${method}`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify(params), signal: controller.signal, redirect: "error",
          });
        } catch {
          // Never forward fetch exception messages: they may contain the token URL.
          throw new ApiError(502, "RUBIKA_UNAVAILABLE", "Rubika did not return a confirmed response. Do not automatically repeat a message operation.", { outcome: "unknown" });
        }
        let body;
        try { body = await response.json(); } catch {
          throw new ApiError(502, "INVALID_RUBIKA_RESPONSE", "Rubika returned an unreadable response.", { outcome: "unknown" });
        }
        if (!response.ok || body?.status !== "OK") {
          const publicStatuses = ["INVALID_TOKEN", "NOT_AUTHORIZED", "INVALID_AUTH", "INVALID_INPUT", "ACCESS_DENIED", "TOO_MANY_REQUESTS", "NOT_FOUND", "INVALID_METHOD", "CHAT_NOT_FOUND", "MESSAGE_NOT_FOUND", "ERROR", "INTERNAL_ERROR"];
          const code = publicStatuses.includes(body?.status) && !body.status.includes(token) ? body.status : `HTTP_${response.status}`;
          // Upstream descriptions and raw bodies are deliberately excluded.
          throw new ApiError(method === "getMe" && ["INVALID_TOKEN", "NOT_AUTHORIZED", "INVALID_AUTH"].includes(code) ? 401 : 502, "RUBIKA_REJECTED", `Rubika rejected the operation (${code}).`, { upstream_status: code, outcome: "rejected" });
        }
        if (body.data === undefined || body.data === null) {
          // Some no-result mutation methods legitimately return only {status:"OK"}.
          if (["editMessageText", "deleteMessage"].includes(method)) return {};
          throw new ApiError(502, "INVALID_RUBIKA_RESPONSE", "Rubika returned no result.", { outcome: "unknown" });
        }
        if (method === "getMe") {
          const bot = body.data.bot ?? body.data;
          assert(typeof bot.bot_id === "string" && bot.bot_id.length > 0, "Rubika returned incomplete bot information.");
          return { bot_id: bot.bot_id, id: bot.bot_id, name: String(bot.bot_title ?? bot.name ?? bot.username ?? "Rubika bot"), username: String(bot.username ?? "") };
        }
        if (method.startsWith("send") && !body.data.message_id) throw new ApiError(502, "INVALID_RUBIKA_RESPONSE", "Rubika did not return a message identifier.", { outcome: "unknown" });
        if (method === "forwardMessage" && !body.data.new_message_id) throw new ApiError(502, "INVALID_RUBIKA_RESPONSE", "Rubika did not return a forwarded message identifier.", { outcome: "unknown" });
        return body.data;
      } finally { clearTimeout(timer); }
    },
    pollingParams(params) {
      const out = { limit: integer(params.limit, "limit", 1, 100, 25) };
      if (params.offset_id !== undefined) out.offset_id = identifier(params.offset_id, "offset_id");
      return out;
    },
  };
}
