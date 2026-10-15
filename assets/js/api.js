export const DEFAULT_ENDPOINT = 'https://efibfevyiepkwpnobaro.supabase.co/functions/v1/rubika-panel';

export function validateEndpoint(value) {
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash) throw new Error('نشانی سرویس نباید شامل رمز، پارامتر یا توکن باشد.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(url.hostname))) throw new Error('نشانی سرویس باید HTTPS باشد.');
  return url.href.replace(/\/$/, '');
}

export class PanelAPI {
  constructor(endpoint = DEFAULT_ENDPOINT) { this.endpoint = validateEndpoint(endpoint); }
  async request(action, token = '', body = {}, signal) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    try {
      let response;
      try {
        response = await fetch(this.endpoint, {
          method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(action === 'health' ? { action } : { ...body, action, token }), signal: controller.signal,
        });
      } catch (error) {
        const failure = new Error(error.name === 'AbortError' ? 'درخواست لغو شد یا زمان ارتباط با سرور پایان یافت.' : 'ارتباط با سرویس برقرار نشد. اینترنت، نشانی سرویس و تنظیم CORS را بررسی کنید.');
        if (['message','engine_run','schedule_run'].includes(action)) failure.outcome = 'unknown';
        throw failure;
      }
      let data;
      try { data = await response.json(); } catch {
        const failure = new Error(`پاسخ سرویس معتبر نیست (HTTP ${response.status}).`);
        if (action === 'message') failure.outcome = 'unknown';
        throw failure;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        const failure = new Error('ساختار پاسخ سرویس معتبر نیست.');
        if (action === 'message') failure.outcome = 'unknown';
        throw failure;
      }
      if (!response.ok || data.ok !== true) {
        const messages = {
          CONFIGURATION_REQUIRED: 'متغیرهای امن سرویس سروری هنوز تنظیم نشده‌اند.',
          ENGINE_BUSY: 'این ربات در حال پردازش توسط Worker یا درخواست دیگری است. کمی بعد تلاش کنید.',
          ENGINE_PAUSED: 'موتور این ربات متوقف شده است. ابتدا آن را فعال کنید.',
          ENGINE_LEASE_LOST: 'اجازهٔ اجرای این نوبت پایان یافته است. پیش از تلاش تازه، مقصدها و سوابق را بررسی کنید.',
          RUNTIME_STORE_UNAVAILABLE: 'پایگاه دادهٔ موتور در دسترس نیست. migration جدید و تنظیمات سرویس را بررسی کنید.',
          CONSENT_READ_ONLY: 'عضویت اعلان فقط با درخواست خود مخاطب قابل تغییر است.',
          RATE_LIMITED: 'به سقف درخواست‌ها رسیده‌اید. یک دقیقه بعد دوباره تلاش کنید.',
          DESTINATION_NOT_REGISTERED: 'ابتدا مقصد مجاز را در همین پنل ثبت کنید.',
          PERMISSION_REQUIRED: 'مجوز عملیات در مقصد را تأیید کنید.',
          ORIGIN_DENIED: 'نشانی این پنل در تنظیم CORS سرویس مجاز نشده است.',
          AUDIT_READ_ONLY: 'سوابق فعالیت فقط خواندنی هستند.',
          RUBIKA_UNAVAILABLE: 'پاسخ تأییدشده‌ای از روبیکا دریافت نشد. پیش از ارسال مجدد، مقصد را بررسی کنید.',
          RUBIKA_REJECTED: 'روبیکا درخواست را رد کرد. اعتبار توکن، شناسه‌ها و مجوز ربات را بررسی کنید.',
          OPERATION_ALREADY_ATTEMPTED: 'این عملیات قبلاً انجام یا تلاش شده است. پیش از عملیات جدید، مقصد را بررسی کنید.',
          OPERATION_CONFLICT: 'شناسه عملیات با محتوای متفاوت استفاده شده است.',
          OPERATION_RECORDING_INCOMPLETE: 'روبیکا عملیات را تأیید کرده، اما ثبت نتیجه در پایگاه داده کامل نشد. این پیام را دوباره ارسال نکنید.',
          INTERNAL_ERROR: 'سرویس نتوانست درخواست را کامل کند. برای عملیات پیام، ابتدا مقصد را بررسی کنید.',
          UNSUPPORTED_METHOD: 'این عملیات در API تأییدشدهٔ سرویس پشتیبانی نمی‌شود.',
        };
        const failure = new Error(messages[data.code] || (typeof data.error === 'string' ? data.error : `خطای سرویس (HTTP ${response.status}).`));
        failure.code = data.code;
        failure.outcome = data.outcome || ((['message','engine_run','schedule_run'].includes(action) && response.status >= 500) ? 'unknown' : undefined);
        failure.operationId = data.operation_id;
        throw failure;
      }
      return data;
    } finally { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
  }
}

export const LEGACY_CAPABILITIES = Object.freeze({ collections: false, messaging: false, polling: false, engine: false, reports: false, moderation: false, scheduling: false, webhook: false, background: false, rbac: false });
