export class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function assert(condition, message, code = "INVALID_INPUT") {
  if (!condition) throw new ApiError(400, code, message);
}

export function record(value, field = "data") {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${field} must be an object.`);
  return value;
}

export function text(value, field, max = 4096, optional = false) {
  if (optional && (value === undefined || value === null || value === "")) return undefined;
  assert(typeof value === "string" && value.trim().length > 0 && value.length <= max, `${field} is required and must be at most ${max} characters.`);
  assert(!/[\u0000]/u.test(value), `${field} contains an invalid character.`);
  return value;
}

export function identifier(value, field = "chat_id", optional = false) {
  const result = text(value, field, 160, optional);
  if (result !== undefined) assert(/^[A-Za-z0-9_:\-]+$/u.test(result), `${field} contains invalid characters.`);
  return result;
}

export function tokenValue(value) {
  const token = text(value, "token", 512);
  assert(/^[A-Za-z0-9_:\-]{10,512}$/u.test(token), "The bot token format is invalid.");
  return token;
}

export function integer(value, field, min, max, fallback) {
  const result = value === undefined ? fallback : value;
  assert(Number.isInteger(result) && result >= min && result <= max, `${field} must be an integer between ${min} and ${max}.`);
  return result;
}

export function uuid(value, field = "id", optional = false) {
  if (value === undefined && optional) return undefined;
  assert(typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value), `${field} must be a UUID.`);
  return value;
}

// Prevent accidental token/credential persistence inside the generic JSON collections.
// Payloads are application data, never user-provided environment configuration.
export function safeData(value, token, maxBytes = 24000) {
  record(value);
  const json = JSON.stringify(value);
  assert(new TextEncoder().encode(json).length <= maxBytes, "The resource payload is too large.");
  assert(!token || !json.includes(token), "Bot tokens must never be stored in resource data.");
  function visit(node, depth = 0) {
    assert(depth <= 12, "The resource payload is too deeply nested.");
    if (!node || typeof node !== "object") return;
    for (const [key, item] of Object.entries(node)) {
      const normalized = key.toLowerCase().replace(/[^a-z0-9]/gu, "");
      assert(!/^(token|bottoken|secret|password|apikey|authorization|servicerolekey|accesstoken|refreshtoken|clientsecret|signingsecret)$/u.test(normalized), "Secret fields must not be stored in resource data.");
      visit(item, depth + 1);
    }
  }
  visit(value);
  return JSON.parse(json);
}

export const COLLECTIONS = Object.freeze(["drafts", "templates", "automations", "schedules", "tickets", "users", "logs", "violations", "consents"]);

export function collectionName(value) {
  assert(COLLECTIONS.includes(value), "Unknown resource collection.");
  return value;
}

export function groupInput(body, token) {
  const settings = safeData(body.settings ?? {}, token);
  for (const name of ["warn_limit", "flood_count", "flood_seconds"]) {
    if (name in settings) integer(settings[name], name, 1, 3600);
  }
  for (const name of ["quiet_start", "quiet_end"]) {
    if (name in settings) assert(typeof settings[name] === "string" && /^([01]\d|2[0-3]):[0-5]\d$/u.test(settings[name]), `${name} must be HH:MM.`);
  }
  const type = body.type ?? "group";
  assert(["group", "channel"].includes(type), "type must be group or channel.");
  return safeData({ chat_id: identifier(body.chat_id), title: text(body.title, "title", 160), type, settings }, token);
}
