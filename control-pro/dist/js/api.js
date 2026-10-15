export const API_BASE = "https://botapi.rubika.ir/v3/";
export const METHODS = new Set([
  "getMe",
  "getChat",
  "getUpdates",
  "sendMessage",
  "editMessageText",
  "deleteMessage",
  "forwardMessage",
  "sendPoll",
  "sendLocation",
  "sendContact",
  "sendFile",
  "requestSendFile",
  "getFile",
  "editMessageKeypad",
  "editChatKeypad",
  "setCommands",
  "banChatMember",
  "unbanChatMember",
]);
const READ_METHODS = new Set(["getMe", "getChat", "getUpdates", "getFile"]);
export class ApiError extends Error {
  constructor(message, code = "API_ERROR") {
    super(message);
    this.name = "ApiError";
    this.code = code;
  }
}
export class RubikaAPI {
  constructor({
    fetchImpl = globalThis.fetch.bind(globalThis),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    settings = () => ({}),
  } = {}) {
    this.fetch = fetchImpl;
    this.sleep = sleep;
    this.settings = settings;
  }
  async call(token, method, payload = {}) {
    if (!METHODS.has(method))
      throw new ApiError("این متد تأیید نشده است.", "UNSUPPORTED");
    if (
      typeof token !== "string" ||
      !token.trim() ||
      token.length > 512 ||
      /[\s/?#]/.test(token)
    )
      throw new ApiError("قالب توکن معتبر نیست.", "TOKEN");
    const settings = this.settings();
    let url = API_BASE + encodeURIComponent(token) + "/" + method;
    let body = payload,
      headers = { "Content-Type": "application/json" };
    if (settings.transport === "relay") {
      let relay;
      try {
        relay = new URL(settings.relayUrl);
      } catch {
        throw new ApiError("نشانی واسط معتبر نیست.", "RELAY");
      }
      if (
        relay.protocol !== "https:" ||
        relay.username ||
        relay.password ||
        relay.search ||
        relay.hash
      )
        throw new ApiError("واسط باید یک نشانی HTTPS معتبر باشد.", "RELAY");
      if (!settings.relayKey)
        throw new ApiError("کلید دسترسی واسط تنظیم نشده است.", "RELAY");
      url = relay.href;
      body = { token, method, payload };
      headers.Authorization = "Bearer " + settings.relayKey;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
      let response;
      try {
        response = await this.fetch(url, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(20000),
          cache: "no-store",
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
      } catch {
        if (READ_METHODS.has(method) && attempt < 2) {
          await this.sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new ApiError(
          "اتصال برقرار نشد؛ اینترنت و مجوز CORS روبیکا را بررسی کنید. برای رفع CORS، واسط شخصی JavaScript را تنظیم کنید. نتیجهٔ عملیات ممکن است نامشخص باشد؛ پیش از تکرار ارسال بررسی کنید.",
          "NETWORK",
        );
      }
      if (!response.ok) {
        if (
          READ_METHODS.has(method) &&
          [429, 502, 503, 504].includes(response.status) &&
          attempt < 2
        ) {
          await this.sleep(1000 * 2 ** attempt);
          continue;
        }
        throw new ApiError(
          `درخواست توسط سرویس رد شد (${response.status}).`,
          String(response.status),
        );
      }
      let result;
      try {
        result = await response.json();
      } catch {
        throw new ApiError("پاسخ API قابل خواندن نیست.", "INVALID_RESPONSE");
      }
      if (result.status !== "OK")
        throw new ApiError(
          "API عملیات را تأیید نکرد. توکن، شناسهٔ مقصد و مجوز بات را بررسی کنید.",
          "REJECTED",
        );
      return result.data ?? {};
    }
  }
}
export function messagePayload(type, fields) {
  const chat_id = String(fields.chatId || "").trim();
  if (!chat_id) throw new Error("یک مقصد مجاز انتخاب کنید.");
  const payload = { chat_id };
  if (fields.replyId) payload.reply_to_message_id = fields.replyId;
  if (type === "text") {
    if (!fields.text?.trim() || fields.text.length > 4096)
      throw new Error("متن پیام باید بین ۱ و ۴۰۹۶ نویسه باشد.");
    payload.text = fields.text;
    if (fields.keypad) {
      payload[
        fields.keypadType === "normal" ? "chat_keypad" : "inline_keypad"
      ] = fields.keypad;
      if (fields.keypadType === "normal") payload.chat_keypad_type = "New";
    }
    return { method: "sendMessage", payload };
  }
  if (type === "poll") {
    const options = fields.options
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);
    if (options.length < 2 || options.length > 10 || !fields.question?.trim())
      throw new Error("سؤال و ۲ تا ۱۰ گزینهٔ نظرسنجی لازم است.");
    return {
      method: "sendPoll",
      payload: { ...payload, question: fields.question, options },
    };
  }
  if (type === "location") {
    const latitude = Number(fields.latitude),
      longitude = Number(fields.longitude);
    if (
      !fields.latitude ||
      !fields.longitude ||
      !Number.isFinite(latitude) ||
      !Number.isFinite(longitude) ||
      Math.abs(latitude) > 90 ||
      Math.abs(longitude) > 180
    )
      throw new Error("مختصات معتبر وارد کنید.");
    return {
      method: "sendLocation",
      payload: {
        ...payload,
        latitude: String(latitude),
        longitude: String(longitude),
      },
    };
  }
  if (type === "contact") {
    if (!fields.firstName || !/^\+?[\d -]{7,20}$/.test(fields.phone))
      throw new Error("نام و شمارهٔ مخاطب معتبر لازم است.");
    return {
      method: "sendContact",
      payload: {
        ...payload,
        first_name: fields.firstName,
        last_name: fields.lastName || "",
        phone_number: fields.phone,
      },
    };
  }
  if (type === "file") {
    if (!fields.fileId?.trim())
      throw new Error("شناسهٔ فایلِ آپلودشده در روبیکا لازم است.");
    return {
      method: "sendFile",
      payload: { ...payload, file_id: fields.fileId },
    };
  }
  throw new Error("این نوع پیام نیازمند پشتیبانی تأییدشدهٔ API است.");
}
