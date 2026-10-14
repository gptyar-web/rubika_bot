export const LOCKS = {
  link: 'لینک', hyperlink: 'هایپرلینک', username: 'نام کاربری', hashtag: 'هشتگ', text: 'متن', profanity: 'کلمات نامناسب',
  forward: 'فوروارد', inline: 'محتوای Inline', unverified: 'کاربر تأییدنشده', file: 'فایل و سند', photo: 'عکس', video: 'ویدئو',
  voice: 'ویس', gif: 'GIF', sticker: 'استیکر', location: 'موقعیت مکانی', contact: 'مخاطب', mention: 'منشن', poll: 'نظرسنجی', story: 'استوری',
};
export function defaults() {
  return { active: false, anti_spam: true, warn_limit: 3, flood_count: 6, flood_seconds: 8, quiet_enabled: false,
    quiet_start: '23:00', quiet_end: '07:00', rules: '', welcome: '', goodbye: '', allowed_domains: '', blocked_words: '',
    admin_exceptions: '', locks: Object.fromEntries(Object.keys(LOCKS).map(key => [key, false])) };
}
export function settingsFor(group) {
  const base = defaults();
  return { ...base, ...group?.settings, locks: { ...base.locks, ...group?.settings?.locks } };
}
export function escapeHTML(value = '') { return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char])); }
export function faNumber(value) { return new Intl.NumberFormat('fa-IR').format(value); }
export function faDate(value) {
  if (!value) return 'ثبت نشده';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'نامعتبر' : new Intl.DateTimeFormat('fa-IR', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Tehran' }).format(date);
}
export function tehranDateTimeInput(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(date).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}
export function tehranInputToISO(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) throw new Error('تاریخ و ساعت معتبر نیست.');
  // Iran has used a fixed UTC+03:30 offset since 2023; plans use current/future dates.
  const date = new Date(`${value}:00+03:30`);
  if (Number.isNaN(date.getTime()) || tehranDateTimeInput(date) !== value) throw new Error('تاریخ و ساعت معتبر نیست.');
  return date.toISOString();
}
export function safeFilename(value) { return String(value).replace(/[^a-z0-9_-]/gi, '_'); }
export function csv(rows) {
  return '\uFEFF' + rows.map(row => row.map(value => {
    let text = String(value ?? '');
    if (/^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }).join(',')).join('\r\n');
}
export function exportFile(name, contents, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const anchor = document.createElement('a'); anchor.href = url; anchor.download = name; anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
export function validateBackup(value) {
  if (!value || value.version !== 1 || !Array.isArray(value.groups) || value.groups.length > 200) throw new Error('ساختار پشتیبان معتبر نیست.');
  const ids = new Set();
  return value.groups.map(group => {
    if (!group || typeof group.chat_id !== 'string' || !group.chat_id.trim() || group.chat_id.length > 200 || typeof group.title !== 'string' || group.title.length > 200 || !group.settings || typeof group.settings !== 'object' || Array.isArray(group.settings)) throw new Error('اطلاعات یکی از مقصدها نامعتبر است.');
    if (ids.has(group.chat_id)) throw new Error('شناسه تکراری در پشتیبان وجود دارد.'); ids.add(group.chat_id);
    const base = defaults(); const settings = {};
    for (const key of Object.keys(base)) {
      const supplied = group.settings[key];
      if (key === 'locks') {
        settings.locks = Object.fromEntries(Object.keys(LOCKS).map(name => [name, Boolean(group.settings.locks?.[name])]));
      } else if (typeof base[key] === 'boolean') settings[key] = supplied === undefined ? base[key] : supplied === true;
      else if (typeof base[key] === 'number') {
        const number = supplied ?? base[key]; if (!Number.isInteger(number) || number < 1 || number > 120) throw new Error('محدودیت عددی پشتیبان نامعتبر است.'); settings[key] = number;
      } else { const text = supplied ?? base[key]; if (typeof text !== 'string' || text.length > 2000) throw new Error('متن پشتیبان نامعتبر است.'); settings[key] = text; }
    }
    if (![settings.quiet_start, settings.quiet_end].every(time => /^([01]\d|2[0-3]):[0-5]\d$/.test(time))) throw new Error('ساعت پشتیبان نامعتبر است.');
    return { chat_id: group.chat_id.trim(), title: group.title, type: group.type === 'channel' ? 'channel' : 'group', settings };
  });
}
