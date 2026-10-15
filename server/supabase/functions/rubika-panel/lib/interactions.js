import { assert, identifier, integer, record, text } from "./validation.js";

const VARIABLE_NAMES = new Set(["name", "user_id", "chat_title", "bot_name", "date", "time"]);
const COMMAND = /^\/[A-Za-z][A-Za-z0-9_]{0,31}$/u;
const LOCAL_ID = /^[A-Za-z0-9_-]{1,40}$/u;
const SENSITIVE_KEY = /(?:token|secret|password|passwd|authorization|api[_ -]?key|credential|privatekey|رمز|توکن|گذرواژه)/iu;
const MAX_TEXT = 4096;
const MAX_RULES = 100;
const PAGE_SIZE = 8;
const TEHRAN = "Asia/Tehran";
const WEEKDAYS = new Map([["Sun", 0], ["Mon", 1], ["Tue", 2], ["Wed", 3], ["Thu", 4], ["Fri", 5], ["Sat", 6]]);

function dateValue(value = new Date()) {
  const result = value instanceof Date ? value : new Date(value);
  assert(Number.isFinite(result.getTime()), "now must be a valid date.");
  return result;
}

function unwrap(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  return row.data && typeof row.data === "object" && !Array.isArray(row.data) ? { ...row.data, id: row.id ?? row.data.id } : row;
}

function localId(value, field) {
  assert(typeof value === "string" && LOCAL_ID.test(value), `${field} must contain 1–40 letters, digits, underscores or hyphens.`);
  return value;
}

function approval(data) {
  for (const name of ["enabled", "authorized", "case_sensitive"]) if (name in data) assert(typeof data[name] === "boolean", `${name} must be boolean.`);
  if ("status" in data) assert(["draft", "approved", "paused"].includes(data.status), "Invalid approval status.");
  if ("allowed_chat_ids" in data) {
    assert(Array.isArray(data.allowed_chat_ids) && data.allowed_chat_ids.length <= 100, "allowed_chat_ids must contain at most 100 destinations.");
    data.allowed_chat_ids.forEach(value => identifier(value));
    assert(new Set(data.allowed_chat_ids).size === data.allowed_chat_ids.length, "Allowed destinations must be unique.");
  }
  if (data.enabled === true) {
    assert(data.authorized === true && data.status === "approved", "An enabled interaction needs explicit authorization and approved status.");
    assert(data.allowed_chat_ids?.length > 0, "An enabled interaction needs an explicit destination allowlist.");
  }
  if (data.id !== undefined) { identifier(data.id, "id"); assert(data.id.length <= 64, "Interaction IDs must be at most 64 characters."); }
  return data;
}

function authorized(data, chatId) {
  return data?.enabled === true && data.authorized === true && data.status === "approved" && Array.isArray(data.allowed_chat_ids) && data.allowed_chat_ids.includes(chatId);
}

export function renderTemplate(template, variables = {}) {
  text(template, "template", MAX_TEXT);
  return template.replace(/\{\{([a-z_]+)\}\}|\{([a-z_]+)\}/gu, (whole, double, single) => {
    const name = double ?? single;
    if (!VARIABLE_NAMES.has(name) || !Object.hasOwn(variables, name)) return whole;
    const value = variables[name];
    return typeof value === "string" || typeof value === "number" ? String(value).replaceAll("\u0000", "").slice(0, 160) : whole;
  }).slice(0, MAX_TEXT);
}

export function validateWorkHours(hours) {
  record(hours, "work_hours");
  for (const key of ["start", "end"]) assert(typeof hours[key] === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(hours[key]), `${key} must be HH:MM.`);
  if (hours.days !== undefined) {
    assert(Array.isArray(hours.days) && hours.days.length >= 1 && hours.days.length <= 7 && hours.days.every(day => Number.isInteger(day) && day >= 0 && day <= 6), "Work days must be weekday numbers 0–6.");
    assert(new Set(hours.days).size === hours.days.length, "Work days must be unique.");
  }
  return hours;
}

export function withinWorkHours(hours, now = new Date()) {
  if (!hours) return true;
  validateWorkHours(hours);
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: TEHRAN, weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(dateValue(now));
  const part = type => parts.find(item => item.type === type)?.value;
  const minute = Number(part("hour")) * 60 + Number(part("minute"));
  const weekday = WEEKDAYS.get(part("weekday"));
  const parse = value => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
  const start = parse(hours.start); const end = parse(hours.end);
  const allowed = day => !hours.days || hours.days.includes(day);
  if (start === end) return allowed(weekday);
  if (start < end) return allowed(weekday) && minute >= start && minute < end;
  return minute >= start && allowed(weekday) || minute < end && allowed((weekday + 6) % 7);
}

// A small Thompson NFA: no native regex engine is used for user expressions.
// Matching cost is bounded by input length × at most 256 states, with no backtracking.
export function safeRegex(pattern, { caseSensitive = false } = {}) {
  text(pattern, "pattern", 100);
  const characters = [...pattern]; let cursor = 0;
  const startAnchor = characters[0] === "^";
  if (startAnchor) cursor++;
  let endAnchor = false; const atoms = [];
  const lower = value => caseSensitive ? value : value.toLocaleLowerCase("en-US");
  function escapeAtom(inClass = false) {
    const escaped = characters[cursor++];
    assert(escaped !== undefined, "Incomplete regex escape.");
    const predefined = {
      d: c => /^[0-9]$/u.test(c), D: c => !/^[0-9]$/u.test(c),
      w: c => /^[A-Za-z0-9_]$/u.test(c), W: c => !/^[A-Za-z0-9_]$/u.test(c),
      s: c => /^\s$/u.test(c), S: c => !/^\s$/u.test(c),
    };
    if (Object.hasOwn(predefined, escaped)) return { test: predefined[escaped], broad: /^[DSW]$/u.test(escaped) };
    const whitespace = { n: "\n", r: "\r", t: "\t" };
    if (Object.hasOwn(whitespace, escaped)) return { literal: whitespace[escaped], test: c => c === whitespace[escaped] };
    assert(/[\\.^$*+?()[\]{}|/\-]/u.test(escaped) || inClass && escaped === "^", "Unsupported regex escape; backreferences and executable expressions are forbidden.");
    return { literal: escaped, test: c => lower(c) === lower(escaped) };
  }
  function classAtom() {
    const negate = characters[cursor] === "^";
    if (negate) cursor++;
    const members = []; let closed = false;
    while (cursor < characters.length) {
      if (characters[cursor] === "]") { cursor++; closed = true; break; }
      let member = characters[cursor++] === "\\" ? escapeAtom(true) : { literal: characters[cursor - 1] };
      if (member.literal !== undefined && characters[cursor] === "-" && characters[cursor + 1] !== "]") {
        cursor++;
        const last = characters[cursor++] === "\\" ? escapeAtom(true) : { literal: characters[cursor - 1] };
        assert(member.literal !== undefined && last.literal !== undefined, "Character ranges need literal endpoints.");
        const firstCode = lower(member.literal).codePointAt(0); const lastCode = lower(last.literal).codePointAt(0);
        assert(firstCode <= lastCode, "Invalid character range.");
        members.push(c => { const code = lower(c).codePointAt(0); return code >= firstCode && code <= lastCode; });
      } else members.push(member.test ?? (c => lower(c) === lower(member.literal)));
    }
    assert(closed && members.length > 0, "Incomplete or empty regex character class.");
    return { test: c => negate !== members.some(match => match(c)), broad: negate };
  }
  while (cursor < characters.length) {
    const next = characters[cursor++];
    if (next === "$" && cursor === characters.length) { endAnchor = true; break; }
    let atom;
    if (next === "\\") atom = escapeAtom();
    else if (next === "[") atom = classAtom();
    else if (next === ".") atom = { test: c => c !== "\n" && c !== "\r", broad: true };
    else {
      assert(!"^$()|*+?{}]".includes(next), "Only literals, anchors, simple classes and bounded repetitions are supported; groups and alternatives are forbidden.");
      atom = { test: c => lower(c) === lower(next) };
    }
    let min = 1; let max = 1;
    const quantifier = characters[cursor];
    if (quantifier === "?" || quantifier === "*" || quantifier === "+") {
      cursor++; min = quantifier === "+" ? 1 : 0; max = quantifier === "?" ? 1 : null;
      assert(!(max === null && atom.broad), "Unbounded wildcard repetitions are forbidden.");
    } else if (quantifier === "{") {
      const rest = characters.slice(cursor).join("");
      const match = /^\{(\d{1,2})(?:,(\d{1,2}))?\}/u.exec(rest);
      assert(match, "Regex repetitions must have finite bounds from 0 to 64.");
      cursor += match[0].length;
      min = Number(match[1]); max = Number(match[2] ?? match[1]);
      assert(min <= max && max <= 64, "Regex repetitions must have finite bounds from 0 to 64.");
    }
    atoms.push({ ...atom, min, max });
    assert(atoms.length <= 64, "The regex has too many atoms.");
  }
  const states = [{ edges: [], epsilon: [] }]; let current = 0;
  const state = () => { assert(states.length < 256, "The regex has too many states."); states.push({ edges: [], epsilon: [] }); return states.length - 1; };
  for (const atom of atoms) {
    for (let n = 0; n < atom.min; n++) { const target = state(); states[current].edges.push({ target, test: atom.test }); current = target; }
    if (atom.max === null) states[current].edges.push({ target: current, test: atom.test });
    else for (let n = atom.min; n < atom.max; n++) { const target = state(); states[current].epsilon.push(target); states[current].edges.push({ target, test: atom.test }); current = target; }
  }
  const final = current;
  function closure(nodes) {
    const stack = [...nodes];
    while (stack.length) for (const target of states[stack.pop()].epsilon) if (!nodes.has(target)) { nodes.add(target); stack.push(target); }
    return nodes;
  }
  const initial = closure(new Set([0]));
  return Object.freeze({ source: pattern, test(value) {
    if (typeof value !== "string" || value.length > MAX_TEXT) return false;
    const input = [...value]; let active = new Set();
    for (let position = 0; position <= input.length; position++) {
      if (!startAnchor || position === 0) for (const node of initial) active.add(node);
      if (active.has(final) && (!endAnchor || position === input.length)) return true;
      if (position === input.length) break;
      const next = new Set();
      for (const node of active) for (const edge of states[node].edges) if (edge.test(input[position])) next.add(edge.target);
      active = closure(next);
    }
    return false;
  } });
}

export function validateAutomation(input) {
  const data = approval(record(input, "automation"));
  assert(["command", "keyword", "regex"].includes(data.match), "match must be command, keyword or regex.");
  text(data.trigger, "trigger", data.match === "regex" ? 100 : 200);
  if (data.match === "command") assert(COMMAND.test(data.trigger), "Custom commands must be / followed by 1–32 Latin letters, digits or underscores.");
  if (data.match === "regex") safeRegex(data.trigger, { caseSensitive: data.case_sensitive === true });
  if (data.response !== undefined) text(data.response, "response", MAX_TEXT);
  if (data.template_id !== undefined) identifier(data.template_id, "template_id");
  assert(data.response !== undefined || data.template_id !== undefined, "An interaction needs a response or template_id.");
  if (data.priority !== undefined) integer(data.priority, "priority", 0, 100);
  if (data.work_hours !== undefined) validateWorkHours(data.work_hours);
  if (data.outside_response !== undefined && data.outside_response !== "") text(data.outside_response, "outside_response", MAX_TEXT);
  return data;
}

export function validateFlow(input) {
  const data = approval(record(input, "flow"));
  text(data.title, "title", 160);
  assert(COMMAND.test(data.command), "A flow command must start with / and use Latin letters, digits or underscores.");
  assert(Array.isArray(data.steps) && data.steps.length >= 1 && data.steps.length <= 20, "A flow needs 1–20 steps.");
  const ids = new Set(); const keys = new Set();
  for (const step of data.steps) {
    record(step, "step"); localId(step.id, "step.id"); localId(step.key, "step.key");
    assert(/^[A-Za-z][A-Za-z0-9_]{0,39}$/u.test(step.key), "Answer keys must start with a Latin letter and use letters, digits or underscores.");
    assert(!ids.has(step.id) && !keys.has(step.key), "Step IDs and answer keys must be unique."); ids.add(step.id); keys.add(step.key);
    assert(!SENSITIVE_KEY.test(step.key), "Flows cannot collect credentials or secret fields.");
    text(step.prompt, "prompt", 1000);
    assert(["text", "number", "email", "choice"].includes(step.validation), "Invalid flow validation.");
    if (step.validation === "choice") {
      assert(Array.isArray(step.options) && step.options.length >= 2 && step.options.length <= 8, "Choice steps need 2–8 options.");
      step.options.forEach(option => text(option, "option", 100));
      assert(new Set(step.options).size === step.options.length, "Choice options must be unique.");
    }
  }
  if (data.session_ttl_minutes !== undefined) integer(data.session_ttl_minutes, "session_ttl_minutes", 1, 15);
  if (data.completion_response !== undefined) text(data.completion_response, "completion_response", 1000);
  return data;
}

export function validateMenu(input) {
  const data = approval(record(input, "menu"));
  text(data.title, "title", 160);
  assert(COMMAND.test(data.command), "A menu command must start with / and use Latin letters, digits or underscores.");
  const ids = new Set(); let total = 0;
  function items(values, depth) {
    assert(depth <= 4, "Menus support at most four levels.");
    assert(Array.isArray(values) && values.length >= 1 && values.length <= 100, "Menu levels need 1–100 items.");
    for (const item of values) {
      record(item, "menu item"); localId(item.id, "item.id");
      assert(!ids.has(item.id), "Menu item IDs must be unique across all levels."); ids.add(item.id);
      assert(++total <= 100, "Menus support at most 100 items in total.");
      text(item.text, "item.text", 100);
      assert(item.response !== undefined || item.children !== undefined, "A menu item needs a response or children.");
      if (item.response !== undefined && (typeof item.response !== "string" || item.response.trim() || !item.children?.length)) text(item.response, "response", MAX_TEXT);
      if (item.children !== undefined) items(item.children, depth + 1);
    }
  }
  items(data.items, 1);
  return data;
}

export function validateInteractionResource(collection, data) {
  if (collection === "flows") return validateFlow(data);
  if (collection === "menus") return validateMenu(data);
  if (["automations", "commands", "faq"].includes(collection)) return validateAutomation(data);
  return data;
}

function templateVariables(message, chat, bot, now) {
  return {
    // Message only documents sender_id; no profile lookup or inferred first name.
    name: message.sender_id, user_id: message.sender_id, chat_title: chat.title ?? "", bot_name: bot.name ?? bot.bot_title ?? "",
    date: new Intl.DateTimeFormat("en-GB", { timeZone: TEHRAN, year: "numeric", month: "2-digit", day: "2-digit" }).format(now),
    time: new Intl.DateTimeFormat("en-GB", { timeZone: TEHRAN, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now),
  };
}

function reply(chatId, value, reason, keypad) {
  const params = { chat_id: chatId, text: value.slice(0, MAX_TEXT) };
  if (keypad?.rows.length) Object.assign(params, { chat_keypad: keypad, chat_keypad_type: "New" });
  return { method: "sendMessage", params, reason };
}

function button(id, value) { return { id, type: "Simple", button_text: value.slice(0, 100) }; }
function rows(buttons) { const result = []; for (let n = 0; n < buttons.length; n += 2) result.push({ buttons: buttons.slice(n, n + 2) }); return { rows: result }; }

function sessionFor(kind, message, chat, bot, now, minutes = 15) {
  return { kind, bot_id: bot.bot_id ?? bot.id, chat_id: chat.chat_id, user_id: message.sender_id, expires_at: new Date(now.getTime() + minutes * 60000).toISOString() };
}

function validSession(input, message, chat, bot, now) {
  const value = unwrap(input);
  if (!value || !["flow", "menu"].includes(value.kind)) return null;
  const expiry = Date.parse(value.expires_at);
  if (value.bot_id !== (bot.bot_id ?? bot.id) || value.chat_id !== chat.chat_id || value.user_id !== message.sender_id || !Number.isFinite(expiry) || expiry <= now.getTime() || expiry > now.getTime() + 15 * 60000) return null;
  return value;
}

function secretAnswer(value) {
  return /(?:\bBearer\s+[A-Za-z0-9_.-]+|\b(?:token|password|secret|api[_ -]?key)\s*[:=]|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+|^[A-Za-z0-9_-]{40,}$|^[a-f0-9]{32,}$)/iu.test(value);
}

function answerValue(step, value) {
  if (typeof value !== "string" || value.trim().length < 1 || value.length > 500 || /\u0000/u.test(value) || secretAnswer(value)) return { ok: false };
  value = value.trim();
  if (step.validation === "choice") return { ok: step.options.includes(value), value };
  if (step.validation === "email") return { ok: value.length <= 254 && /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/u.test(value), value };
  if (step.validation === "number") {
    const normalized = value.replace(/[۰-۹٠-٩]/gu, digit => String("۰۱۲۳۴۵۶۷۸۹".includes(digit) ? "۰۱۲۳۴۵۶۷۸۹".indexOf(digit) : "٠١٢٣٤٥٦٧٨٩".indexOf(digit)));
    const number = Number(normalized);
    return { ok: /^-?\d{1,12}(?:\.\d{1,6})?$/u.test(normalized) && Number.isFinite(number), value: number };
  }
  return { ok: true, value };
}

function flowKeypad(flow, step) {
  const buttons = step.validation === "choice" ? step.options.map((value, index) => button(`flow:${flow.id}:${step.id}:${index}`, value)) : [];
  buttons.push(button(`flow:${flow.id}:cancel`, "لغو فرم"));
  return rows(buttons);
}

function menuLevel(menu, path) {
  let items = menu.items;
  for (const id of path) { const parent = items.find(item => item.id === id); if (!parent?.children) return null; items = parent.children; }
  return items;
}

function menuReply(menu, active, variables) {
  const items = menuLevel(menu, active.path);
  if (!items) return null;
  const pages = Math.ceil(items.length / PAGE_SIZE);
  active.page = Math.min(Math.max(0, active.page), pages - 1);
  const pageItems = items.slice(active.page * PAGE_SIZE, (active.page + 1) * PAGE_SIZE);
  const buttons = pageItems.map(item => button(`menu:${menu.id}:item:${item.id}`, item.text));
  if (active.page > 0) buttons.push(button(`menu:${menu.id}:prev`, "صفحهٔ قبل"));
  if (active.page + 1 < pages) buttons.push(button(`menu:${menu.id}:next`, "صفحهٔ بعد"));
  if (active.path.length) buttons.push(button(`menu:${menu.id}:back`, "بازگشت"));
  buttons.push(button(`menu:${menu.id}:close`, "بستن منو"));
  const content = `${renderTemplate(menu.title, variables)}\n${pageItems.map(item => `${item.text}: /choose ${item.id}`).join("\n")}\nصفحه ${active.page + 1} از ${pages}${pages > 1 ? "\n/page next یا /page prev" : ""}${active.path.length ? "\n/back" : ""}\n/cancel`;
  return reply(active.chat_id, content, "menu", rows(buttons));
}

/** Pure planning only. All outbound actions require caller authorization + idempotency. */
export function planInteraction({ message, chat, bot, automations = [], templates = [], flows = [], menus = [], session = {}, now = new Date() } = {}) {
  const result = { actions: [] };
  if (!message || !chat || !bot || message.sender_type !== "User" || typeof message.sender_id !== "string" || typeof chat.chat_id !== "string") return result;
  try { identifier(message.sender_id, "sender_id"); identifier(chat.chat_id); identifier(bot.bot_id ?? bot.id, "bot_id"); } catch { return result; }
  now = dateValue(now);
  const input = typeof message.text === "string" ? message.text.trim().slice(0, MAX_TEXT) : "";
  const callback = typeof message.aux_data?.button_id === "string" ? message.aux_data.button_id : "";
  const commandMatch = /^(\/[A-Za-z][A-Za-z0-9_]{0,31})(?:\s+([\s\S]*))?$/u.exec(input);
  const command = commandMatch?.[1].toLowerCase(); const argument = commandMatch?.[2]?.trim() ?? "";
  const variables = templateVariables(message, chat, bot, now);
  let active = validSession(session, message, chat, bot, now);
  const previousSession = unwrap(session);
  if (!active && previousSession?.kind && previousSession.bot_id === (bot.bot_id ?? bot.id) && previousSession.chat_id === chat.chat_id && previousSession.user_id === message.sender_id) result.session = null;
  function send(value, reason, keypad) { result.actions.push(reply(chat.chat_id, renderTemplate(value, variables), reason, keypad)); }
  function checked(values, validator) {
    return values.slice(0, MAX_RULES).map(unwrap).filter(value => {
      if (!authorized(value, chat.chat_id)) return false;
      try { validator(value); return true; } catch { (result.warnings ??= []).push({ code: "INVALID_INTERACTION", resource_id: typeof value.id === "string" ? value.id : null }); return false; }
    });
  }
  const validFlows = checked(flows, validateFlow); const validMenus = checked(menus, validateMenu);
  if (command === "/cancel" || active && callback === `${active.kind}:${active.flow_id ?? active.menu_id}:${active.kind === "flow" ? "cancel" : "close"}`) {
    result.session = null; result.command = "/cancel"; send("گفتگو لغو شد و پاسخ‌های موقت پاک شدند.", "cancel"); return result;
  }
  if (command === "/subscribe" || command === "/unsubscribe") {
    result.command = command;
    if (chat.settings?.subscriptions === true) {
      result.consent = { chat_id: chat.chat_id, user_id: message.sender_id, subscribed: command === "/subscribe", requested_at: now.toISOString() };
      send(command === "/subscribe" ? "درخواست عضویت شما در اعلان‌های این گفتگو ثبت شد. برای لغو /unsubscribe را بفرستید." : "درخواست لغو عضویت شما در اعلان‌ها ثبت شد.", "subscription");
    } else send("عضویت در اعلان‌ها برای این گفتگو فعال نیست.", "subscription_disabled");
    return result;
  }
  if (command === "/help") {
    result.command = command;
    const commands = checked(automations, validateAutomation).filter(value => value.match === "command").map(value => value.trigger);
    send(["فرمان‌ها: /help، /rules، /id، /cancel", ...new Set([...commands, ...validFlows.map(value => value.command), ...validMenus.map(value => value.command)])].join("\n"), "help"); return result;
  }
  if (command === "/rules") { result.command = command; send(typeof (chat.settings?.rules ?? chat.settings?.rules_text) === "string" && (chat.settings.rules ?? chat.settings.rules_text).trim() ? (chat.settings.rules ?? chat.settings.rules_text) : "قانونی برای این گفتگو ثبت نشده است.", "rules"); return result; }
  if (command === "/id") { result.command = command; send(`شناسهٔ شما: ${message.sender_id}\nشناسهٔ گفتگو: ${chat.chat_id}`, "id"); return result; }
  if (active?.kind === "flow") {
    const flow = validFlows.find(value => value.id === active.flow_id);
    if (!flow) { result.session = null; send("این فرم غیرفعال شده است. پاسخ‌های موقت پاک شدند.", "flow_disabled"); return result; }
    if (active.stage === "awaiting_consent") {
      if (command === "/confirm" || callback === `flow:${flow.id}:confirm`) {
        active = { ...active, stage: "answering", step: 0, answers: {}, consented: true };
        result.session = active; send(flow.steps[0].prompt, "flow_prompt", flowKeypad(flow, flow.steps[0]));
      } else send(`پاسخ‌های این فرم تا ${flow.session_ttl_minutes ?? 15} دقیقه به‌صورت موقت ذخیره می‌شوند. برای موافقت /confirm و برای لغو /cancel را بفرستید.`, "flow_consent");
      return result;
    }
    if (active.stage === "completed") {
      // Completed answers remain available only until the original expiry or /cancel.
      // Starting the same form explicitly replaces the earlier response set.
      if (command !== flow.command.toLowerCase()) return result;
      const minutes = flow.session_ttl_minutes ?? 15;
      result.session = { ...sessionFor("flow", message, chat, bot, now, minutes), flow_id: flow.id, stage: "awaiting_consent", step: 0, answers: {} };
      send(`پاسخ‌های فرم قبلی با فرم جدید جایگزین می‌شوند. برای موافقت /confirm و برای لغو /cancel را بفرستید. مهلت نگهداری: ${minutes} دقیقه.`, "flow_consent");
      return result;
    }
    if (active.consented !== true || !Number.isInteger(active.step) || active.step < 0 || active.step >= flow.steps.length) { result.session = null; return result; }
    const step = flow.steps[active.step]; let value = input;
    if (callback) {
      const prefix = `flow:${flow.id}:${step.id}:`;
      if (!callback.startsWith(prefix) || step.validation !== "choice") return result;
      if (!/^[0-7]$/u.test(callback.slice(prefix.length))) return result;
      const index = Number(callback.slice(prefix.length));
      if (!Number.isInteger(index) || index < 0 || index >= step.options.length) return result;
      value = step.options[index];
    }
    if (command) { send("برای خروج از فرم /cancel را بفرستید.", "flow_prompt"); return result; }
    const answer = answerValue(step, value);
    if (!answer.ok) { send("پاسخ معتبر نیست. لطفاً مقدار مناسب این مرحله را وارد کنید. اطلاعات محرمانه نفرستید.\n" + step.prompt, "flow_invalid", flowKeypad(flow, step)); return result; }
    const answers = {}; // Revalidate persisted data; never copy arbitrary session keys.
    for (const previous of flow.steps.slice(0, active.step)) {
      const saved = active.answers?.[previous.key];
      const verified = answerValue(previous, typeof saved === "number" ? String(saved) : saved);
      if (!verified.ok) { result.session = null; send("نشست فرم معتبر نیست؛ فرم را دوباره آغاز کنید.", "flow_invalid_session"); return result; }
      answers[previous.key] = verified.value;
    }
    answers[step.key] = answer.value;
    active = { ...active, step: active.step + 1, answers };
    if (active.step === flow.steps.length) {
      active.stage = "completed"; result.session = active;
      result.completed_flow = { flow_id: flow.id, chat_id: chat.chat_id, user_id: message.sender_id, answers, expires_at: active.expires_at };
      send(flow.completion_response ?? "فرم تکمیل شد. پاسخ‌ها تا پایان مهلت نگهداری موقت در دسترس مدیر هستند. برای حذف /cancel را بفرستید.", "flow_completed");
    } else { result.session = active; send(flow.steps[active.step].prompt, "flow_prompt", flowKeypad(flow, flow.steps[active.step])); }
    return result;
  }
  const newFlow = validFlows.find(value => value.command.toLowerCase() === command);
  if (newFlow) {
    const minutes = newFlow.session_ttl_minutes ?? 15;
    result.session = { ...sessionFor("flow", message, chat, bot, now, minutes), flow_id: newFlow.id, stage: "awaiting_consent", step: 0, answers: {} };
    result.command = command;
    send(`فرم ${newFlow.title}\nپاسخ‌های شما با رضایت شما تا ${minutes} دقیقه به‌صورت موقت ذخیره می‌شوند. اطلاعات محرمانه نفرستید. برای موافقت /confirm و برای لغو /cancel را بفرستید.`, "flow_consent", rows([button(`flow:${newFlow.id}:confirm`, "موافقم؛ شروع فرم"), button(`flow:${newFlow.id}:cancel`, "لغو")]));
    return result;
  }
  const newMenu = validMenus.find(value => value.command.toLowerCase() === command);
  if (newMenu) { active = { ...sessionFor("menu", message, chat, bot, now), menu_id: newMenu.id, path: [], page: 0 }; result.command = command; }
  if (active?.kind === "menu") {
    const menu = validMenus.find(value => value.id === active.menu_id);
    if (!menu || !Array.isArray(active.path) || active.path.length > 3 || !Number.isInteger(active.page)) { result.session = null; return result; }
    active = { ...active, path: [...active.path] };
    const level = menuLevel(menu, active.path);
    if (!level) { result.session = null; return result; }
    const prefix = `menu:${menu.id}:`;
    if (callback.startsWith(prefix) || command === "/page" || command === "/back" || command === "/choose") {
      const operation = callback.startsWith(prefix) ? callback.slice(prefix.length) : command === "/page" ? argument : command === "/back" ? "back" : `item:${argument}`;
      if (operation === "next") active.page = Math.min(active.page + 1, Math.ceil(level.length / PAGE_SIZE) - 1);
      else if (operation === "prev") active.page = Math.max(active.page - 1, 0);
      else if (operation === "back") { active.path.pop(); active.page = 0; }
      else if (operation.startsWith("item:")) {
        const item = level.slice(active.page * PAGE_SIZE, (active.page + 1) * PAGE_SIZE).find(value => value.id === operation.slice(5));
        if (!item) return result;
        if (item.children) { active.path.push(item.id); active.page = 0; }
        else { result.session = active; send(item.response, "menu_item"); return result; }
      } else return result;
    } else if (!newMenu) return result;
    result.session = active; const action = menuReply(menu, active, variables); if (action) result.actions.push(action); return result;
  }
  const rules = checked(automations, validateAutomation).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || String(a.id ?? a.trigger).localeCompare(String(b.id ?? b.trigger)));
  for (const rule of rules) {
    const normalize = value => rule.case_sensitive === true ? value : value.toLocaleLowerCase("en-US");
    const matches = rule.match === "command" ? command && normalize(rule.trigger) === normalize(commandMatch[1]) : rule.match === "keyword" ? input && normalize(input).includes(normalize(rule.trigger)) : input && safeRegex(rule.trigger, { caseSensitive: rule.case_sensitive === true }).test(input);
    if (!matches) continue;
    let response = rule.response;
    if (!withinWorkHours(rule.work_hours, now)) { response = rule.outside_response; if (!response) continue; }
    else if (!response && rule.template_id) {
      const template = templates.map(unwrap).find(value => value?.id === rule.template_id);
      response = template?.text ?? template?.body;
    }
    if (typeof response !== "string" || response.trim().length < 1 || response.length > MAX_TEXT) continue;
    if (rule.match === "command") result.command = command;
    send(response, `automation:${rule.id ?? rule.match}`); break;
  }
  return result;
}
