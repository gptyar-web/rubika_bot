export const uid = () => crypto.randomUUID();
export const fa = (value) => new Intl.NumberFormat("fa-IR").format(value ?? 0);
export const date = (value, time = true) =>
  value
    ? new Intl.DateTimeFormat("fa-IR", {
        timeZone: "Asia/Tehran",
        dateStyle: "medium",
        ...(time ? { timeStyle: "short" } : {}),
      }).format(new Date(value))
    : "هنوز ثبت نشده";
export const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (x) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        x
      ],
  );
export function csv(rows) {
  const safe = (value) => {
    const text = String(value ?? "");
    return (
      '"' +
      (/^[\s]*[=+@\-]/.test(text) ? "'" : "") +
      text.replaceAll('"', '""') +
      '"'
    );
  };
  if (!rows.length) return "\ufeff";
  const keys = [...new Set(rows.flatMap(Object.keys))];
  return (
    "\ufeff" +
    [
      keys.map(safe).join(","),
      ...rows.map((row) => keys.map((k) => safe(row[k])).join(",")),
    ].join("\r\n")
  );
}
export function download(name, content, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export const normalize = (value) =>
  String(value || "")
    .normalize("NFKC")
    .replace(/ي/g, "ی")
    .replace(/ك/g, "ک")
    .toLocaleLowerCase("fa")
    .trim();
export function renderTemplate(text, variables = {}) {
  return String(text).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (_, key) =>
    String(variables[key] ?? ""),
  );
}
export function safePattern(pattern) {
  if (!pattern || pattern.length > 160 || /[(){}\\]|\*|\+|\?/.test(pattern))
    throw new Error(
      "برای جلوگیری از توقف مرورگر، الگو فقط حروف، نقطه، کروشه، ^، $ و | را پشتیبانی می‌کند.",
    );
  return new RegExp(pattern, "iu");
}
export function localInputISO(value) {
  // datetime-local is deliberately interpreted in the documented Tehran time zone.
  const d = new Date(`${value}:00+03:30`);
  if (!Number.isFinite(d.getTime())) throw new Error("زمان نامعتبر است.");
  return d.toISOString();
}
export function inQuietHours(hours, now = new Date()) {
  if (!hours?.start || !hours?.end || hours.start === hours.end) return false;
  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tehran",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(now);
  return hours.start < hours.end
    ? time >= hours.start && time < hours.end
    : time >= hours.start || time < hours.end;
}
export function initialState() {
  return {
    schema: 1,
    bots: [],
    chats: [],
    messages: [],
    rules: [],
    posts: [],
    tickets: [],
    templates: [],
    violations: [],
    users: [],
    logs: [],
    seen: [],
    events: [],
    sessions: {},
    clicks: {},
    settings: {
      panelName: "Rubika Control Pro",
      idleMinutes: 15,
      autoResume: false,
      transport: "direct",
      relayUrl: "",
      relayKey: "",
    },
  };
}
export function audit(state, action, details = "", level = "info") {
  state.logs.unshift({
    id: uid(),
    at: new Date().toISOString(),
    action,
    details: String(details).slice(0, 300),
    level,
  });
  state.logs = state.logs.slice(0, 1500);
}
export function validateState(s) {
  if (!s || s.schema !== 1 || !s.settings || typeof s.settings !== "object")
    throw new Error("ساختار پشتیبان معتبر نیست.");
  for (const key of [
    "bots",
    "chats",
    "messages",
    "rules",
    "posts",
    "tickets",
    "templates",
    "violations",
    "users",
    "logs",
    "seen",
    "events",
  ]) {
    if (!Array.isArray(s[key]) || s[key].length > 15000)
      throw new Error("ساختار پشتیبان معتبر نیست.");
    if (
      s[key].some(
        (item) => key !== "seen" && (!item || typeof item !== "object"),
      )
    )
      throw new Error("رکورد نامعتبر در پشتیبان.");
  }
  if (
    s.bots.some(
      (b) => typeof b.token !== "string" || typeof b.id !== "string",
    ) ||
    s.chats.some(
      (c) => typeof c.chatId !== "string" || typeof c.botId !== "string",
    )
  )
    throw new Error("شناسه یا توکن نامعتبر در پشتیبان.");
  if (
    !["direct", "relay"].includes(s.settings.transport) ||
    !Number.isFinite(s.settings.idleMinutes) ||
    s.settings.idleMinutes < 1 ||
    s.settings.idleMinutes > 120
  )
    throw new Error("تنظیمات پشتیبان معتبر نیست.");
  return s;
}
