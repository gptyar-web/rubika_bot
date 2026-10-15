import { esc, fa, date, normalize } from "./utils.js";
import { icon } from "./icons.js";
import {
  btn,
  pill,
  empty,
  notice,
  field,
  select,
  textarea,
  check,
  toggle,
  pageHead,
  table,
} from "./ui.js";
import { activityChart, publishChart } from "./charts.js";
import { LOCKS } from "./moderation.js";
const botName = (s, id) =>
  s.bots.find((b) => b.id === id)?.name || "بات حذف‌شده";
const chatName = (s, id, botId) =>
  s.chats.find((c) => c.chatId === id && (!botId || c.botId === botId))?.name ||
  id;
const opts = (s) => s.bots.map((b) => [b.id, b.name]);
const chatOpts = (s) =>
  s.chats
    .filter((c) => c.consent)
    .map((c) => [c.id, c.name + " · " + botName(s, c.botId)]);
const search = (rows, q, keys) =>
  q
    ? rows.filter((row) =>
        keys.some((k) => normalize(row[k]).includes(normalize(q))),
      )
    : rows;
const postLabels = {
  draft: ["پیش‌نویس", ""],
  pending: ["منتظر تأیید", "warning"],
  scheduled: ["زمان‌بندی‌شده", "primary"],
  sending: ["در حال ارسال", "primary"],
  sent: ["منتشرشده", "success"],
  failed: ["نیازمند بررسی", "error"],
  missed: ["زمان گذشته", "warning"],
  interrupted: ["ارسال نامشخص", "warning"],
  cancelled: ["لغوشده", ""],
};
export const postPill = (p) =>
  pill(...(postLabels[p.status] || [p.status, ""]));
export function dashboard(s, ctx) {
  const metrics = [
    [
      "bot",
      "ربات‌های فعال",
      s.bots.filter((b) => b.enabled).length,
      `${fa(s.bots.length)} بات در فضای کار`,
    ],
    [
      "users",
      "گروه‌ها و کانال‌ها",
      s.chats.filter((c) => c.type !== "User").length,
      "مقصدهای ثبت‌شده و مجاز",
    ],
    [
      "message",
      "پیام‌های پردازش‌شده",
      s.events.length,
      "داده‌های دریافتی همین فضای کار",
    ],
    [
      "shield",
      "تخلفات ثبت‌شده",
      s.violations.length,
      "بر اساس قوانین اختصاصی شما",
    ],
  ];
  return `${pageHead("داشبورد", "از اینجا همه‌چیز را زیر نظر داشته باشید.", btn("افزودن ربات", "add-bot", "plus", "primary"), date(new Date(), false))}<section class="hero"><div class="hero-copy"><div class="eyebrow">فضای کار شما، تحت کنترل شما</div><h2>سلام، به مرکز کنترل خوش آمدید <span aria-hidden="true">✦</span></h2><p>${s.bots.length ? "ربات‌ها، پیام‌ها و برنامهٔ انتشار خود را از یک نقطه مدیریت کنید." : "همه‌چیز برای شروع آماده است. اولین رباتتان را اضافه کنید و فضای کار خود را شکل بدهید."}</p><div class="actions">${btn(s.bots.length ? "مدیریت ربات‌ها" : "افزودن اولین ربات", s.bots.length ? "go-bots" : "add-bot", "bot", "primary")}${btn("وضعیت قابلیت‌ها", "go-features", "arrow", "text")}</div></div><div class="hero-visual"><img src="./assets/icons/icon.svg" width="123" height="123" alt=""><div class="float-chip">${icon("shield")}توکن‌های شما رمزگذاری می‌شوند</div></div></section><div class="stats">${metrics.map(([ico, title, value, foot]) => `<article class="card stat"><div class="stat-top"><p>${title}</p><span class="stat-icon">${icon(ico)}</span></div><div class="stat-value">${fa(value)}</div><div class="stat-foot">${icon("info")}${foot}</div></article>`).join("")}</div><div class="dashboard-charts"><section class="card"><div class="card-head"><div><h2>فعالیت پیام‌ها</h2><p>نمایی از پیام‌های دریافت‌شده در روزهای اخیر</p></div><div class="segmented">${[7, 30].map((n) => `<button data-action="chart-range" data-days="${n}" class="${ctx.days === n ? "active" : ""}">${n === 7 ? "هفتگی" : "ماهانه"}</button>`).join("")}</div></div><div class="card-body">${activityChart(s.events, ctx.days)}</div></section><section class="card"><div class="card-head"><div><h2>وضعیت انتشار</h2><p>تصویر کلی از صف محتوای شما</p></div>${icon("chart")}</div><div class="card-body">${publishChart(s.posts)}</div></section></div><div class="dashboard-bottom"><section class="card"><div class="card-head"><div><h2>آخرین فعالیت‌ها</h2><p>رویدادهای ثبت‌شده در فضای کار</p></div><a class="btn text small" href="#/logs">مشاهدهٔ همه ${icon("arrow")}</a></div><div class="card-body">${
    s.logs.length
      ? s.logs
          .slice(0, 5)
          .map(
            (l) =>
              `<div class="activity-row"><div class="activity-marker">${icon(l.level === "error" ? "warning" : "history")}</div><div><p>${esc(l.action)}</p><small>${esc(l.details)} · ${date(l.at)}</small></div></div>`,
          )
          .join("")
      : empty(
          "هنوز فعالیتی ثبت نشده",
          "با افزودن اولین بات، تاریخچهٔ فعالیت‌ها در این بخش شکل می‌گیرد.",
          "history",
        )
  }</div></section><section class="card"><div class="card-head"><div><h2>دسترسی سریع</h2><p>کارهای روزمره، یک قدم نزدیک‌تر</p></div></div><div class="card-body"><div class="quick-grid">${[
    ["bot", "افزودن ربات", "اتصال یک بات جدید", "add-bot"],
    ["users", "مدیریت گروه", "قوانین و مقصدهای مجاز", "go-groups"],
    ["send", "ساخت پست", "پیش‌نویس و زمان‌بندی", "add-post"],
    ["chart", "گزارش عملکرد", "آمار واقعی فضای کار", "go-reports"],
  ]
    .map(
      ([ico, title, desc, action]) =>
        `<button class="quick-btn" data-action="${action}">${icon(ico)}<strong>${title}</strong><small>${desc}</small></button>`,
    )
    .join(
      "",
    )}</div></div></section></div><div class="notice ${ctx.running ? "success" : "warning"}">${icon("clock")}<p>${ctx.running ? "پردازش تا زمانی که این صفحه باز و مخزن باز باشد انجام می‌شود. مرورگر ممکن است فعالیت زبانه‌های پس‌زمینه را کند کند." : "پردازش پیام و انتشار زمان‌بندی‌شده متوقف است. برای شروع، ربات را فعال و سپس «شروع پردازش» را انتخاب کنید."}</p>${btn(ctx.running ? "توقف پردازش" : "شروع پردازش", "runtime", ctx.running ? "power" : "bolt", "small")}</div>`;
}
export function botsPage(s, ctx) {
  const bots = search(s.bots, ctx.query, ["name", "username"]);
  return `${pageHead("ربات‌های شما", "همهٔ بات‌ها در یک فضای کار؛ با اتصال مستقل و توکن رمزگذاری‌شده.", btn("افزودن ربات", "add-bot", "plus", "primary"))}${notice("توکن فقط یک‌بار ثبت می‌شود. با بازکردن مخزن، برای بررسی اتصال و ارسال پیام آماده است. پردازش فقط در صفحهٔ باز انجام می‌شود.")}<div class="actions filter-row">${btn(ctx.running ? "توقف پردازش" : "شروع پردازش", "runtime", ctx.running ? "power" : "bolt", ctx.running ? "" : "soft")}<span class="hint">وضعیت اتصال بر اساس آخرین پاسخ واقعی API است.</span></div>${bots.length ? `<div class="grid-3">${bots.map((b) => `<article class="card bot-card"><div class="bot-card-top"><span class="bot-logo">${icon("bot")}</span>${toggle("فعال‌بودن " + b.name, "toggle-bot", b.enabled, `data-id="${esc(b.id)}"`)}</div><h3>${esc(b.name)}</h3><p class="muted small" dir="ltr">${b.username ? "@" + esc(b.username) : "Rubika Bot"}</p><div class="details"><div class="detail-row"><span>وضعیت اتصال</span>${pill(b.status === "connected" ? "تأییدشده" : b.status === "error" ? "خطای اتصال" : "بررسی‌نشده", b.status === "connected" ? "success" : b.status === "error" ? "error" : "warning")}</div><div class="detail-row"><span>توکن</span><strong>محرمانه · رمزگذاری‌شده</strong></div><div class="detail-row"><span>آخرین بررسی</span><small>${date(b.lastReceived || b.verifiedAt)}</small></div><div class="detail-row"><span>زمان پاسخ</span><small>${b.latency ? fa(b.latency) + " میلی‌ثانیه" : "—"}</small></div></div><div class="actions">${btn("بررسی اتصال", "test-bot", "refresh", "small", `data-id="${esc(b.id)}"`)}${btn("دستورات", "bot-commands", "code", "small", `data-id="${esc(b.id)}"`)}<button class="icon-btn" data-action="delete-bot" data-id="${esc(b.id)}" aria-label="حذف ${esc(b.name)}">${icon("trash")}</button></div></article>`).join("")}</div>` : `<section class="card">${empty("هنوز رباتی اینجا نیست", "توکن بات خود را از BotFather روبیکا بگیرید و آن را به مخزن امن اضافه کنید.", "bot", btn("افزودن ربات", "add-bot", "plus", "primary"))}</section>`}`;
}
export function chatsPage(s, ctx, type) {
  const title = type === "Group" ? "گروه‌ها" : "کانال‌ها";
  const rows = search(
    s.chats.filter((c) => c.type === type),
    ctx.query,
    ["name", "chatId"],
  );
  return `${pageHead(title, `مقصدهای مجاز ${type === "Group" ? "برای مدیریت قوانین و پیام‌ها" : "برای انتشار محتوا"}.`, btn(type === "Group" ? "افزودن گروه" : "افزودن کانال", "add-chat", "plus", "primary", `data-type="${type}"`))}${notice("ثبت مقصد با شناسهٔ واقعی انجام می‌شود. بات باید در مقصد دسترسی لازم داشته باشد. ثبت مقصد به معنی اعطای دسترسی در روبیکا نیست.")}<section class="card">${
    rows.length
      ? table(
          ["نام و مقصد", "ربات", "مجوز ارسال", "قوانین", "عملیات"],
          rows.map((c) => [
            `<div class="cell-title"><span class="avatar">${icon(type === "Group" ? "users" : "channel")}</span><div>${esc(c.name)}<small dir="ltr">${esc(c.chatId)}</small></div></div>`,
            esc(botName(s, c.botId)),
            pill(
              c.consent ? "تأییدشده" : "لغوشده",
              c.consent ? "success" : "warning",
            ),
            type === "Group"
              ? pill(
                  c.moderationEnabled ? "پردازش فعال" : "غیرفعال",
                  c.moderationEnabled ? "primary" : "",
                )
              : "—",
            `<div class="actions">${btn("تنظیمات", "edit-chat", "settings", "small", `data-id="${esc(c.id)}"`)}${btn("بررسی", "test-chat", "refresh", "small", `data-id="${esc(c.id)}"`)}<button class="icon-btn" data-action="delete-chat" data-id="${esc(c.id)}" aria-label="حذف مقصد">${icon("trash")}</button></div>`,
          ]),
        )
      : empty(
          `هنوز ${type === "Group" ? "گروهی" : "کانالی"} ثبت نشده`,
          "مقصدهایی را اضافه کنید که برای مدیریت یا ارسال در آن‌ها مجوز دارید.",
          type === "Group" ? "users" : "channel",
        )
  }</section>`;
}
export function messagesPage(s, ctx) {
  const messages = search([...s.messages].reverse(), ctx.query, [
    "text",
    "chatId",
    "userId",
  ]).slice(0, 100);
  return `${pageHead("پیام‌ها", "ارسال، پاسخ، ویرایش و مدیریت پیام‌ها با API واقعی.", btn("پیام جدید", "compose", "plus", "primary"))}<div class="actions filter-row">${btn("ثبت گفتگوی مجاز", "add-chat", "users", "", 'data-type="User"')}<span class="hint">۱۰۰ پیام آخر مطابق جستجو نمایش داده می‌شود. آرشیو رمزگذاری‌شده تا ۵۰۰۰ پیام نگهداری می‌شود.</span></div><section class="card">${
    messages.length
      ? table(
          ["پیام", "گفتگو", "جهت و وضعیت", "زمان", "عملیات"],
          messages.map((m) => [
            `<div class="wrap preview-text">${esc(m.text || "[" + m.type + "]").slice(0, 200)}<small class="muted"> ${esc(m.messageId)}</small></div>`,
            esc(chatName(s, m.chatId, m.botId)),
            `${pill(m.direction === "in" ? "دریافتی" : "ارسالی", m.direction === "in" ? "" : "primary")} ${pill(m.status, ["sent", "received"].includes(m.status) ? "success" : "warning")}`,
            date(m.at),
            `<div class="actions">${btn("پاسخ", "reply-message", "message", "small", `data-id="${esc(m.id)}"`)}${m.direction === "out" ? btn("ویرایش", "edit-message", "edit", "small", `data-id="${esc(m.id)}"`) : ""}${btn("فوروارد", "forward-message", "arrow", "small", `data-id="${esc(m.id)}"`)}<button class="icon-btn" data-action="delete-message" data-id="${esc(m.id)}" aria-label="حذف پیام">${icon("trash")}</button></div>`,
          ]),
        )
      : empty(
          "گفتگوها از اینجا شروع می‌شوند",
          "پس از ثبت یک بات و مقصد مجاز، پیام بفرستید یا دریافت رویدادها را آغاز کنید.",
          "message",
          btn("نوشتن پیام", "compose", "send", "soft"),
        )
  }</section>`;
}
export function locksPage(s, ctx) {
  const groups = s.chats.filter((c) => c.type === "Group"),
    chat = groups.find((c) => c.id === ctx.groupId) || groups[0];
  if (!chat)
    return `${pageHead("قفل‌ها و قوانین", "قوانین مستقل برای هر گروه و استثناهای مدیران.")}<section class="card">${empty("ابتدا یک گروه اضافه کنید", "برای هر گروه، قفل‌ها، استثناها و نحوهٔ رسیدگی جداگانه ذخیره می‌شوند.", "lock", btn("ثبت گروه", "add-chat", "plus", "primary", 'data-type="Group"'))}</section>`;
  return `${pageHead("قفل‌ها و قوانین", `تنظیمات اختصاصی ${esc(chat.name)}`, btn("تنظیم رفتار و استثناها", "edit-chat", "settings", "", `data-id="${esc(chat.id)}"`))}<div class="filter-row">${select(
    "group-filter",
    "گروه",
    groups.map((c) => [c.id, c.name]),
    chat.id,
  )}${pill(chat.moderationEnabled ? "موتور قوانین این گروه فعال است" : "موتور قوانین این گروه غیرفعال است", chat.moderationEnabled ? "success" : "warning")}</div>${notice("قفل‌ها فقط روی رویدادهای دریافتی و هنگام اجرای پردازش اعمال می‌شوند. مدیران و استثناهای ثبت‌شده مستثنا هستند. موارد خاکستری نیازمند دادهٔ مستند API هستند.")}<div class="lock-grid">${LOCKS.map((l) => `<article class="card lock-item ${l.supported ? "" : "unsupported"}"><div class="lock-item-top"><h3>${esc(l.title)}</h3>${toggle(l.title, "toggle-lock", chat.locks?.[l.id], `data-chat="${esc(chat.id)}" data-lock="${l.id}" ${!l.supported ? "disabled" : ""}`)}</div><p>${esc(l.description)}</p>${l.supported ? pill(chat.locks?.[l.id] ? "فعال" : "غیرفعال", chat.locks?.[l.id] ? "primary" : "") : pill("نیازمند پشتیبانی API", "warning")}</article>`).join("")}</div>`;
}
export function violationsPage(s, ctx) {
  const rows = search(s.violations, ctx.query, ["userId", "chatId", "review"]);
  return `${pageHead("مدیریت تخلفات", "سوابق اخطار، اقدام‌های واقعی و بازبینی مدیر.", btn("خروجی CSV", "export-violations", "download"))}<section class="card">${
    rows.length
      ? table(
          ["کاربر", "گروه", "علت", "اقدام ثبت‌شده", "زمان", "بازبینی"],
          rows
            .slice(0, 150)
            .map((v) => [
              esc(v.userId),
              esc(chatName(s, v.chatId, v.botId)),
              esc(v.reasons.join("، ")),
              pill(v.status, v.status === "recorded" ? "warning" : "primary"),
              date(v.at),
              btn(
                v.review ? "مشاهدهٔ بازبینی" : "ثبت بازبینی",
                "review-violation",
                "edit",
                "small",
                `data-id="${esc(v.id)}"`,
              ),
            ]),
        )
      : empty(
          "تخلفی ثبت نشده",
          "پس از فعال‌کردن قوانین گروه، فقط تخلفات واقعی رویدادهای دریافتی ثبت می‌شوند.",
          "shield",
        )
  }</section>${notice("اقدام پیش‌فرض فقط ثبت تخلف است. اخطار یا حذف پیام باید در تنظیمات گروه انتخاب شود. مسدودسازی کاربر در صفحهٔ کاربران با تأیید جداگانه انجام می‌شود.", "warning")}`;
}
export function automationPage(s, ctx) {
  const rules = search(s.rules, ctx.query, ["name", "trigger", "response"]);
  const labels = {
    keyword: "کلمهٔ کلیدی",
    exact: "مطابقت کامل",
    regex: "الگوی امن",
    command: "دستور",
    faq: "پرسش پرتکرار",
    flow: "فرم چندمرحله‌ای",
  };
  return `${pageHead("اتوماسیون", "پاسخ‌های خودکار و سناریوهای گفتگوی شما.", btn("قانون جدید", "add-rule", "plus", "primary"))}${notice("پاسخ خودکار به گفتگوهای مجاز محدود است و به روشن‌بودن موتور پردازش نیاز دارد. الگوهای متنی برای جلوگیری از توقف مرورگر به یک زیرمجموعهٔ امن محدود شده‌اند.")}<section class="card">${
    rules.length
      ? table(
          ["نام قانون", "محرک", "ربات", "پاسخ‌ها", "وضعیت", "عملیات"],
          rules.map((r) => [
            `${esc(r.name)}<div>${pill(labels[r.type] || r.type)}</div>`,
            esc(r.trigger),
            esc(botName(s, r.botId)),
            fa(r.hits || 0),
            toggle(
              "فعال‌بودن " + r.name,
              "toggle-rule",
              r.enabled,
              `data-id="${esc(r.id)}"`,
            ),
            `<div class="actions">${btn("ویرایش", "edit-rule", "edit", "small", `data-id="${esc(r.id)}"`)}${btn("آزمایش", "test-rule", "bolt", "small", `data-id="${esc(r.id)}"`)}<button class="icon-btn" data-action="delete-rule" data-id="${esc(r.id)}" aria-label="حذف قانون">${icon("trash")}</button></div>`,
          ]),
        )
      : empty(
          "اولین پاسخ خودکار را بسازید",
          "برای سلام، راهنما یا پرسش‌های پرتکرار، یک محرک و پاسخ تعریف کنید.",
          "bolt",
          btn("ساخت قانون", "add-rule", "plus", "soft"),
        )
  }</section>`;
}
export function schedulePage(s, ctx) {
  let posts = search(s.posts, ctx.query, ["title", "text", "category"]);
  if (ctx.postStatus) posts = posts.filter((p) => p.status === ctx.postStatus);
  return `${pageHead("زمان‌بندی و انتشار", "پیش‌نویس، بازبینی و صف انتشار در مقصدهای مجاز.", btn("ساخت پست", "add-post", "plus", "primary"))}${notice("زمان‌ها به وقت تهران هستند و تاریخ شمسی نمایش داده می‌شود. ارسال خودکار فقط در صفحهٔ باز انجام می‌شود. پست بیش از ۱۰ دقیقه عقب‌افتاده برای بازبینی متوقف می‌شود.", "warning")}<div class="filter-row">${select("post-filter", "وضعیت", [["", "همهٔ پست‌ها"], ...Object.entries(postLabels).map(([k, v]) => [k, v[0]])], ctx.postStatus || "")}${btn(ctx.running ? "توقف پردازش" : "شروع پردازش", "runtime", "bolt", ctx.running ? "" : "soft")}</div><section class="card">${
    posts.length
      ? table(
          ["محتوا", "مقصدها", "زمان تهران", "وضعیت", "عملیات"],
          posts.map((p) => [
            `${esc(p.title)}<div class="muted small">${esc(p.category || "بدون دسته‌بندی")}</div>`,
            p.chatIds.map((id) => esc(chatName(s, id, p.botId))).join("، "),
            date(p.scheduledAt),
            postPill(p),
            `<div class="actions">${btn("پیش‌نمایش", "preview-post", "eye", "small", `data-id="${esc(p.id)}"`)}${["draft", "pending", "missed", "cancelled"].includes(p.status) ? btn("ویرایش", "edit-post", "edit", "small", `data-id="${esc(p.id)}"`) : ""}${["draft", "pending", "missed"].includes(p.status) ? btn("تأیید و زمان‌بندی", "approve-post", "check", "small soft", `data-id="${esc(p.id)}"`) : ""}${["failed", "interrupted"].includes(p.status) ? btn("بازبینی ارسال", "retry-post", "refresh", "small", `data-id="${esc(p.id)}"`) : ""}${p.status === "scheduled" ? btn("لغو", "cancel-post", "close", "small", `data-id="${esc(p.id)}"`) : ""}</div>`,
          ]),
        )
      : empty(
          "تقویم محتوایتان را بسازید",
          "یک پست بنویسید، پیش‌نمایش را ببینید و پس از تأیید، زمان انتشارش را مشخص کنید.",
          "calendar",
          btn("اولین پیش‌نویس", "add-post", "plus", "soft"),
        )
  }</section>`;
}
export function templatesPage(s, ctx) {
  const rows = search(s.templates, ctx.query, ["name", "text"]);
  return `${pageHead("قالب‌ها و دکمه‌ها", "پیام‌های آماده با متغیرهای پویا و کیبورد بصری.", btn("قالب جدید", "add-template", "plus", "primary"))}${notice('متغیرهای مجاز: <b dir="ltr">{{name}}، {{chat}}، {{date}}، {{user_id}}</b>. هر خط یک ردیف دکمه است و | دکمه‌ها را جدا می‌کند. برای شناسهٔ ثابت از <b dir="ltr">id:عنوان</b> استفاده کنید.')}<div class="grid-2">${rows.map((t) => `<article class="card"><div class="card-head"><div><h2>${esc(t.name)}</h2><p>${t.keypadType === "normal" ? "کیبورد معمولی" : "کیبورد شیشه‌ای"}</p></div><div class="actions">${btn("ویرایش", "edit-template", "edit", "small", `data-id="${esc(t.id)}"`)}<button class="icon-btn" data-action="delete-template" data-id="${esc(t.id)}" aria-label="حذف قالب">${icon("trash")}</button></div></div><div class="card-body"><div class="preview">${esc(t.text)}</div>${keypadPreview(t.keypad)}<div class="form-actions">${btn("استفاده در پیام", "use-template", "send", "small soft", `data-id="${esc(t.id)}"`)}</div></div></article>`).join("")}</div>${!rows.length ? `<section class="card">${empty("قالب تکرار کارها را کم می‌کند", "متن و دکمه‌های دلخواه را یک‌بار بسازید و در پیام‌ها استفاده کنید.", "template")}</section>` : ""}`;
}
export function keypadPreview(keypad) {
  return keypad?.rows?.length
    ? `<div class="keypad-preview">${keypad.rows.map((row) => `<div>${row.buttons.map((b) => `<span>${esc(b.button_text)}</span>`).join("")}</div>`).join("")}</div>`
    : "";
}
export function ticketsPage(s, ctx) {
  const rows = search(s.tickets, ctx.query, ["subject", "userId", "assignee"]);
  return `${pageHead("میز پشتیبانی", "تیکت‌ها، مسئول پیگیری و تاریخچهٔ پاسخ‌ها.", btn("ثبت تیکت", "add-ticket", "plus", "primary"))}${notice('کاربر می‌تواند در گفتگوی مجاز با دستور <b dir="ltr">/ticket متن درخواست</b> تیکت بسازد. پاسخ مدیر تنها با مجوز مقصد و تأیید API ارسال می‌شود.')}<section class="card">${
    rows.length
      ? table(
          ["موضوع", "درخواست‌کننده", "مسئول", "وضعیت", "آخرین تغییر", "عملیات"],
          rows.map((t) => [
            esc(t.subject),
            esc(t.userId || chatName(s, t.chatId, t.botId)),
            esc(t.assignee || "تعیین‌نشده"),
            pill(
              t.status === "closed"
                ? "بسته‌شده"
                : t.status === "pending"
                  ? "در انتظار"
                  : "باز",
              t.status === "closed" ? "success" : "warning",
            ),
            date(t.history.at(-1)?.at || t.createdAt),
            btn(
              "مشاهده و پاسخ",
              "open-ticket",
              "ticket",
              "small",
              `data-id="${esc(t.id)}"`,
            ),
          ]),
        )
      : empty(
          "همهٔ درخواست‌ها در یک جا",
          "تیکت‌های دریافتی یا درخواست‌های ثبت‌شده توسط مدیر را اینجا پیگیری کنید.",
          "ticket",
        )
  }</section>`;
}
export function usersPage(s, ctx) {
  const rows = search(s.users, ctx.query, ["userId"]);
  return `${pageHead("کاربران", "فقط کاربران مشاهده‌شده در رویدادهای گفتگوهای مجاز.")}${notice("فهرست مدیران گروه به‌صورت خودکار قابل تأیید نیست؛ شناسه‌های مدیران و استثناها را در تنظیمات هر گروه ثبت کنید. نقش‌های پنل و احراز هویت دومرحله‌ای به سرویس هویت نیاز دارند.", "warning")}<section class="card">${
    rows.length
      ? table(
          [
            "شناسهٔ کاربر",
            "ربات",
            "تعداد پیام",
            "عضویت اعلان",
            "آخرین فعالیت",
            "عملیات",
          ],
          rows.map((u) => [
            esc(u.userId),
            esc(botName(s, u.botId)),
            fa(u.messages),
            pill(
              u.subscribed ? "عضو داوطلب" : "عضو نیست",
              u.subscribed ? "success" : "",
            ),
            date(u.lastSeen),
            btn(
              "اقدام مدیریتی",
              "manage-user",
              "shield",
              "small",
              `data-id="${esc(u.id)}"`,
            ),
          ]),
        )
      : empty(
          "هنوز کاربری مشاهده نشده",
          "اطلاعات فقط از پیام‌های واقعی مقصدهای مجاز ثبت می‌شوند.",
          "users",
        )
  }</section>${notice('دستورهای <b dir="ltr">/subscribe</b> و <b dir="ltr">/unsubscribe</b> رضایت کاربر برای اعلان‌ها را ثبت و لغو می‌کنند. ارسال کمپین انبوه در این نسخه فعال نیست.')}`;
}
export function reportsPage(s, ctx) {
  let events = s.events,
    messages = s.messages,
    violations = s.violations;
  const within = (x) =>
    (!ctx.from || new Date(x.at) >= new Date(ctx.from + "T00:00:00+03:30")) &&
    (!ctx.to || new Date(x.at) <= new Date(ctx.to + "T23:59:59+03:30"));
  events = events.filter(within);
  messages = messages.filter(within);
  violations = violations.filter(within);
  const sent = messages.filter(
    (m) => m.direction === "out" && m.status === "sent",
  ).length;
  return `${pageHead("گزارش عملکرد", "گزارش‌ها بر پایهٔ دادهٔ واقعی و محدود به آرشیو همین مخزن.", `<div class="actions">${btn("CSV", "export-report", "download", "", 'data-format="csv"')}${btn("JSON", "export-report", "download", "", 'data-format="json"')}</div>`)}<div class="filter-row">${field("report-from", "از تاریخ (میلادی)", ctx.from || "", "date")}${field("report-to", "تا تاریخ (میلادی)", ctx.to || "", "date")}${btn("اعمال بازه", "filter-reports", "search", "soft")}</div><div class="stats">${[
    ["message", "پیام دریافتی", events.length],
    [
      "users",
      "کاربر فعال",
      new Set(
        messages
          .filter((m) => m.direction === "in")
          .map((m) => m.botId + ":" + m.userId),
      ).size,
    ],
    ["send", "ارسال موفق", sent],
    ["shield", "تخلف", violations.length],
  ]
    .map(
      ([i, t, v]) =>
        `<div class="card stat"><div class="stat-top"><p>${t}</p><span class="stat-icon">${icon(i)}</span></div><div class="stat-value">${fa(v)}</div></div>`,
    )
    .join(
      "",
    )}</div><div class="dashboard-charts"><section class="card"><div class="card-head"><h2>روند ۳۰ روز اخیر در بازهٔ انتخابی</h2></div><div class="card-body">${activityChart(events, 30)}</div></section><section class="card"><div class="card-head"><h2>انتشار محتوا در کل آرشیو</h2></div><div class="card-body">${publishChart(s.posts)}</div></section></div><div class="grid-2"><section class="card"><div class="card-head"><h2>قانون‌های پرکاربرد · کل آرشیو</h2></div>${
    s.rules.length
      ? table(
          ["قانون", "دفعات اجرا"],
          [...s.rules]
            .sort((a, b) => (b.hits || 0) - (a.hits || 0))
            .slice(0, 10)
            .map((r) => [esc(r.name), fa(r.hits || 0)]),
        )
      : empty(
          "اجرای قانونی ثبت نشده",
          "پس از دریافت پیام مطابق قانون، تعداد اجرا ثبت می‌شود.",
          "bolt",
        )
  }</section><section class="card"><div class="card-head"><h2>نوع پیام‌های دریافتی</h2></div>${table(
    ["نوع", "تعداد"],
    [...new Set(events.map((e) => e.type))].map((t) => [
      esc(t),
      fa(events.filter((e) => e.type === t).length),
    ]),
  )}${!events.length ? empty("داده‌ای در این بازه نیست", "فیلتر تاریخ یا اتصال بات را بررسی کنید.", "chart") : ""}</section></div>${notice("خروجی CSV در Excel باز می‌شود. فایل بومی XLSX، مقایسهٔ دو بازه و آمار اعضای کامل گروه در این نسخه پیاده‌سازی نشده‌اند.", "warning")}`;
}
export function logsPage(s, ctx) {
  const rows = search(s.logs, ctx.query, ["action", "details", "level"]);
  return `${pageHead("سوابق فعالیت", "ردپای تغییرات، نتیجهٔ درخواست‌ها و خطاهای اتصال.", btn("خروجی CSV", "export-logs", "download"))}<section class="card">${
    rows.length
      ? table(
          ["رویداد", "جزئیات", "سطح", "زمان"],
          rows
            .slice(0, 200)
            .map((l) => [
              esc(l.action),
              `<div class="wrap">${esc(l.details)}</div>`,
              pill(
                l.level,
                l.level === "error"
                  ? "error"
                  : l.level === "warning"
                    ? "warning"
                    : "",
              ),
              date(l.at),
            ]),
        )
      : empty(
          "تاریخچه خالی است",
          "فعالیت‌های حساس و خطاها اینجا ثبت می‌شوند.",
          "history",
        )
  }</section>`;
}
export function featuresPage(features, ctx) {
  const rows = search(features, ctx.query, [
    "title",
    "id",
    "status",
    "module",
    "note",
  ]).filter((f) => !ctx.featureStatus || f.kind === ctx.featureStatus);
  return `${pageHead("وضعیت ۱۵۰ قابلیت", "گزارش صادقانهٔ کد قبلی، پیاده‌سازی جدید، وابستگی‌ها و تست‌ها.", btn("دریافت جدول CSV", "export-features", "download"))}<div class="filter-row">${select(
    "feature-filter",
    "وضعیت",
    [
      ["", "همهٔ موارد"],
      ["ready", "پیاده‌سازی محلی"],
      ["api", "وابسته به API / اتصال"],
      ["partial", "بخشی پیاده‌سازی شده"],
      ["server", "نیازمند سرویس اجرایی"],
      ["planned", "نیازمند توسعه"],
    ],
    ctx.featureStatus || "",
  )}<span class="feature-count">${fa(rows.length)} مورد از ۱۵۰ قابلیت</span></div>${notice("«تست محلی» به معنی آزمون با پاسخ شبیه‌سازی‌شده است. هیچ توکن واقعی برای آزمون اتصال ارائه نشده؛ موفقیت روی روبیکا ادعا نمی‌شود.")}<section class="card">${table(
    ["شناسه", "قابلیت", "وضعیت فعلی", "فایل / اولویت", "وابستگی و تست"],
    rows.map((f) => [
      fa(f.id),
      `${esc(f.title)}<div class="hint">پیش از تغییر: ${esc(f.before)}</div>`,
      pill(
        f.status,
        f.kind === "ready"
          ? "success"
          : f.kind === "partial"
            ? "primary"
            : "warning",
      ),
      `<code dir="ltr">${esc(f.module)}</code><div class="hint">اولویت ${fa(f.priority)}</div>`,
      `<div class="hint">${esc(f.note)}<br>${esc(f.test)}</div>`,
    ]),
    "feature-table",
  )}</section>`;
}
export function settingsPage(s, ctx) {
  const settings = s.settings;
  return `${pageHead("تنظیمات فضای کار", "مخزن، اتصال، امنیت و نصب برنامه.")}<div class="grid-2"><section class="card"><div class="card-head"><div><h2>تنظیمات عمومی و اتصال</h2><p>اطلاعات حساس این فرم نیز رمزگذاری می‌شوند.</p></div></div><div class="card-body"><form id="settings-form">${field("panelName", "نام فضای کار", settings.panelName, "text", "", 'required maxlength="60"')}${select(
    "idleMinutes",
    "قفل خودکار پس از بی‌فعالیتی",
    [
      [5, "۵ دقیقه"],
      [15, "۱۵ دقیقه"],
      [30, "۳۰ دقیقه"],
      [60, "۶۰ دقیقه"],
    ],
    settings.idleMinutes,
  )}${select(
    "transport",
    "روش اتصال",
    [
      ["direct", "اتصال مستقیم به API رسمی"],
      ["relay", "واسط شخصی JavaScript برای CORS"],
    ],
    settings.transport,
  )}${field("relayUrl", "نشانی HTTPS واسط شخصی", settings.relayUrl, "url", "فقط واسطی که خودتان مدیریت می‌کنید؛ توکن برای این سرویس ارسال خواهد شد.", 'dir="ltr" placeholder="https://your-worker.workers.dev/"')}${field("relayKey", "کلید دسترسی واسط", settings.relayKey, "password", "این کلید در کد عمومی قرار نمی‌گیرد.", 'autocomplete="off"')}${check("autoResume", "شروع پردازش خودکار پس از بازکردن مخزن", settings.autoResume)}${check("relayConsent", "تأیید می‌کنم واسط را خودم مدیریت می‌کنم و اجازهٔ ارسال توکن به آن را دارم.", settings.transport === "relay")}<div class="form-error" role="alert"></div><button class="btn primary" type="submit">ذخیرهٔ تنظیمات</button></form></div></section><div><section class="card"><div class="card-head"><div><h2>امنیت مخزن</h2><p>داده‌های شما، با کنترل شما</p></div>${icon("shield")}</div><div class="card-body"><div class="detail-row"><span>رمزگذاری</span><b dir="ltr">AES-256-GCM</b></div><div class="detail-row"><span>استخراج کلید</span><b dir="ltr">PBKDF2 · SHA-256</b></div><div class="detail-row"><span>دورهای استخراج</span><b>${fa(600000)}</b></div><div class="subsection"><div class="actions">${btn("تغییر رمز", "change-password", "key")}${btn("قفل‌کردن مخزن", "lock-vault", "lock")}</div></div><p class="hint">این مخزن شخصی جایگزین احراز هویت سازمانی، RBAC یا ورود دومرحله‌ای نیست. افزونهٔ مخرب یا دستگاه آلوده می‌تواند به دادهٔ مخزن باز دسترسی داشته باشد.</p></div></section><section class="card subsection"><div class="card-head"><div><h2>پشتیبان و بازیابی</h2><p>فایل پشتیبان شامل توکن‌هاست و رمزگذاری شده باقی می‌ماند.</p></div></div><div class="card-body"><div class="actions">${btn("پشتیبان رمزگذاری‌شده", "backup", "download", "soft")}${btn("بازیابی پشتیبان", "restore", "upload")}</div><p class="hint">برای انتقال به مرورگر یا دستگاه دیگر از پشتیبان و رمز همان مخزن استفاده کنید.</p></div></section><section class="card subsection"><div class="card-head"><h2>نصب و استفادهٔ آفلاین</h2></div><div class="card-body">${btn("نصب برنامه", "install", "download", "soft")}<p class="hint">پس از یک بار بارگذاری، رابط کاربری و فونت به‌صورت آفلاین باز می‌شوند. عملیات روبیکا به اینترنت نیاز دارد.</p></div></section></div></div>`;
}
export function pageFor(route, s, ctx, features) {
  return (
    {
      dashboard: () => dashboard(s, ctx),
      bots: () => botsPage(s, ctx),
      groups: () => chatsPage(s, ctx, "Group"),
      channels: () => chatsPage(s, ctx, "Channel"),
      messages: () => messagesPage(s, ctx),
      locks: () => locksPage(s, ctx),
      violations: () => violationsPage(s, ctx),
      automation: () => automationPage(s, ctx),
      schedule: () => schedulePage(s, ctx),
      templates: () => templatesPage(s, ctx),
      tickets: () => ticketsPage(s, ctx),
      users: () => usersPage(s, ctx),
      reports: () => reportsPage(s, ctx),
      logs: () => logsPage(s, ctx),
      features: () => featuresPage(features, ctx),
      settings: () => settingsPage(s, ctx),
    }[route]?.() || dashboard(s, ctx)
  );
}
