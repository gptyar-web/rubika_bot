import { normalize, inQuietHours, safePattern } from "./utils.js";
export const LOCKS = [
  ["links", "لینک", "پیوندهای http، https و www در متن", true],
  [
    "hyperlinks",
    "هایپرلینک",
    "پیوند در metadata؛ فقط وقتی API آن را برگرداند",
    true,
  ],
  ["usernames", "نام کاربری", "شناسه‌های شروع‌شده با @", true],
  ["hashtags", "هشتگ", "عبارت‌های شروع‌شده با #", true],
  ["text", "پیام متنی", "همهٔ پیام‌های متنی", true],
  ["badwords", "کلمات ممنوع", "فهرست اختصاصی هر گروه", true],
  ["forward", "فوروارد", "وجود forwarded_from در پیام", true],
  ["inline", "محتوای Inline", "نیازمند مشخصهٔ معتبر نوع محتوا در API", false],
  [
    "authentication",
    "کاربر تأییدنشده",
    "نیازمند رویداد و فرایند تأیید عضویت",
    false,
  ],
  ["files", "فایل و سند", "تمام پیوست‌های file", true],
  ["photos", "تصویر", "نوع فایل در مدل فعلی پیام مستند نیست", false],
  ["videos", "ویدئو", "نوع فایل در مدل فعلی پیام مستند نیست", false],
  ["voice", "ویس و صدا", "نوع فایل در مدل فعلی پیام مستند نیست", false],
  ["gifs", "گیف", "نوع فایل در مدل فعلی پیام مستند نیست", false],
  ["stickers", "استیکر", "وجود sticker در پیام", true],
  ["location", "موقعیت", "وجود location در پیام", true],
  ["contact", "مخاطب", "وجود contact_message در پیام", true],
  ["mentions", "منشن", "MentionText در metadata؛ در صورت دریافت", true],
  ["polls", "نظرسنجی", "وجود poll در پیام", true],
  ["story", "استوری", "نیازمند رویداد مستند API", false],
].map(([id, title, description, supported]) => ({
  id,
  title,
  description,
  supported,
}));
export function violationsFor(message, chat, recent = [], now = new Date()) {
  if (
    !chat?.moderationEnabled ||
    !message.sender_id ||
    message.sender_type === "Bot" ||
    (chat.adminIds || []).includes(message.sender_id) ||
    (chat.exemptIds || []).includes(message.sender_id)
  )
    return [];
  const reasons = [],
    locks = chat.locks || {},
    text = message.text || "",
    parts = message.metadata?.meta_data_parts || [];
  const foundLinks = [...text.matchAll(/(?:https?:\/\/|www\.)[^\s<>]+/giu)].map(
    (x) => x[0],
  );
  const hasDisallowedLink = foundLinks.some((link) => {
    try {
      const host = new URL(
        link.startsWith("www.") ? "https://" + link : link,
      ).hostname.toLowerCase();
      return !(chat.allowedDomains || []).some(
        (domain) =>
          host === domain.toLowerCase() ||
          host.endsWith("." + domain.toLowerCase()),
      );
    } catch {
      return true;
    }
  });
  if (locks.links && hasDisallowedLink) reasons.push("لینک غیرمجاز");
  if (locks.hyperlinks && parts.some((p) => p.type === "Link"))
    reasons.push("هایپرلینک");
  if (locks.usernames && /@[\p{L}\p{N}_]+/u.test(text))
    reasons.push("نام کاربری");
  if (locks.hashtags && /#[\p{L}\p{N}_]+/u.test(text)) reasons.push("هشتگ");
  if (locks.text && text) reasons.push("پیام متنی");
  if (
    locks.badwords &&
    (chat.words || []).some(
      (w) => w.trim() && normalize(text).includes(normalize(w)),
    )
  )
    reasons.push("کلمهٔ ممنوع");
  if (
    (chat.patterns || []).some((p) => {
      try {
        return safePattern(p).test(text.slice(0, 4096));
      } catch {
        return false;
      }
    })
  )
    reasons.push("الگوی ممنوع");
  for (const [lock, field, label] of [
    ["forward", "forwarded_from", "فوروارد"],
    ["files", "file", "فایل"],
    ["stickers", "sticker", "استیکر"],
    ["location", "location", "موقعیت"],
    ["contact", "contact_message", "مخاطب"],
    ["polls", "poll", "نظرسنجی"],
  ])
    if (locks[lock] && message[field]) reasons.push(label);
  if (locks.mentions && parts.some((p) => p.type === "MentionText"))
    reasons.push("منشن");
  if (inQuietHours(chat.quietHours, now)) reasons.push("ساعت سکوت");
  const windowMs = (chat.floodSeconds || 10) * 1000;
  const own = recent.filter(
    (x) =>
      x.userId === message.sender_id &&
      x.chatId === chat.chatId &&
      x.botId === chat.botId &&
      now - new Date(x.at) < windowMs &&
      now >= new Date(x.at),
  );
  if (chat.floodLimit && own.length >= chat.floodLimit)
    reasons.push("ارسال پشت‌سرهم");
  if (
    chat.preventDuplicates &&
    text.trim() &&
    own.some((x) => normalize(x.text) === normalize(text))
  )
    reasons.push("پیام تکراری");
  return [...new Set(reasons)];
}
export function ruleMatches(rule, text, now = new Date()) {
  if (!rule.enabled) return false;
  if (rule.hours?.start && rule.hours?.end && !inQuietHours(rule.hours, now))
    return false;
  const value = normalize(text),
    trigger = normalize(rule.trigger);
  if (!trigger) return false;
  if (rule.type === "regex") {
    try {
      return safePattern(rule.trigger).test(text.slice(0, 4096));
    } catch {
      return false;
    }
  }
  if (["exact", "command", "flow", "faq"].includes(rule.type))
    return value === trigger;
  return value.includes(trigger);
}
