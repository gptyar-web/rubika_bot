import { esc, date, fa } from "./utils.js";
import { icon } from "./icons.js";
import { btn, field, notice } from "./ui.js";
export const NAV = [
  ["dashboard", "داشبورد", "dashboard"],
  ["bots", "ربات‌ها", "bot"],
  ["groups", "گروه‌ها", "users"],
  ["channels", "کانال‌ها", "channel"],
  ["messages", "پیام‌ها", "message"],
  ["locks", "قفل‌ها", "lock"],
  ["violations", "مدیریت تخلفات", "shield"],
  ["automation", "اتوماسیون", "bolt"],
  ["schedule", "زمان‌بندی و انتشار", "calendar"],
  ["templates", "قالب‌ها و دکمه‌ها", "template"],
  ["tickets", "پشتیبانی", "ticket"],
  ["users", "کاربران", "users"],
  ["reports", "گزارش‌ها", "chart"],
  ["logs", "سوابق فعالیت", "history"],
  ["features", "وضعیت ۱۵۰ قابلیت", "list"],
  ["settings", "تنظیمات", "settings"],
];
export function authView(exists) {
  return `<main class="auth" id="main-content"><section class="auth-story"><div class="brand"><img src="./assets/icons/icon.svg" alt="" width="43" height="43"><div class="brand-name" dir="ltr">Rubika Control <small>PRO WORKSPACE</small></div></div><div class="auth-story-content"><div class="eyebrow">یک فضای کار. همهٔ ربات‌های شما.</div><h1>مدیریت هوشمند،<br>با <em>خیالی آسوده.</em></h1><p>مرکز فرمان فارسی برای ربات‌ها، گفتگوها و محتوای شما؛ با کنترل دقیق، طراحی ساده و یک مخزن امن.</p><div class="auth-illustration"><img src="./assets/icons/icon.svg" alt="نشان اختصاصی ربات و سپر امنیتی" width="180" height="180"></div></div><div class="auth-features"><span>${icon("shield")}مخزن رمزگذاری‌شده</span><span>${icon("globe")}آماده برای GitHub Pages</span><span>${icon("bot")}چندرباتی</span></div></section><section class="auth-main"><div class="auth-top">${btn("تغییر پوسته", "theme", "moon", "small")}</div><div class="auth-form"><div class="bot-logo">${icon(exists ? "lock" : "shield")}</div><div class="eyebrow">RUBIKA CONTROL PRO</div><h2>${exists ? "به فضای کارتان برگردید" : "فضای کار امن خود را بسازید"}</h2><p>${exists ? "رمز مخزن را وارد کنید. توکن‌های ذخیره‌شده پس از بازکردن مخزن در دسترس هستند." : "یک رمز قوی انتخاب کنید. توکن‌ها و اطلاعات شما به‌صورت رمزگذاری‌شده در همین مرورگر نگهداری می‌شوند."}</p><form id="auth-form">${field("password", exists ? "رمز مخزن" : "یک رمز برای مخزن", "", "password", exists ? "" : "دست‌کم ۱۲ نویسه؛ بهتر است یک عبارت طولانی باشد.", `required minlength="${exists ? 1 : 12}" autocomplete="${exists ? "current-password" : "new-password"}"`)}${exists ? "" : field("confirm", "تکرار رمز", "", "password", "", 'required minlength="12" autocomplete="new-password"')}<div class="form-error auth-error" role="alert"></div><button class="btn primary" type="submit">${icon(exists ? "key" : "plus")}${exists ? "بازکردن فضای کار" : "ساخت مخزن امن"}</button></form><div class="auth-links">${btn("بازیابی از فایل پشتیبان", "restore", "upload", "text small")}</div><div class="secure-note">${icon("shield")}<span>رمز شما ذخیره نمی‌شود. اگر آن را فراموش کنید، امکان بازیابی توکن از این مخزن وجود ندارد. پیش از پاک‌کردن داده‌های مرورگر، پشتیبان بگیرید.</span></div></div></section></main>`;
}
export function shellView(
  s,
  route,
  body,
  { running, collapsed, mobileOpen, query },
) {
  const nav = NAV.map(
    ([id, label, ico], i) =>
      `${i === 5 ? '<div class="nav-label">مدیریت و عملیات</div>' : i === 12 ? '<div class="nav-label">فضای کار</div>' : ""}<a href="#/${id}" class="${route === id ? "active" : ""}" ${route === id ? 'aria-current="page"' : ""} title="${label}">${icon(ico)}<span class="nav-text">${label}</span>${id === "bots" && s.bots.length ? `<span class="nav-badge">${fa(s.bots.length)}</span>` : ""}</a>`,
  ).join("");
  return `<div class="shell ${collapsed ? "collapsed" : ""} ${mobileOpen ? "mobile-open" : ""}"><button class="mobile-backdrop" aria-label="بستن منو" data-action="menu"></button><aside class="sidebar" aria-label="منوی اصلی"><a class="brand" href="#/dashboard"><img src="./assets/icons/icon.svg" width="42" height="42" alt=""><div class="brand-name" dir="ltr">Rubika Control<small>PRO WORKSPACE</small></div></a><div class="nav-label">نمای کلی</div><nav class="nav">${nav}</nav><div class="sidebar-footer"><div class="storage-badge">${icon("shield")}<div>مخزن امن شما<small>رمزگذاری‌شده در این مرورگر</small></div></div><button class="collapse-btn" data-action="collapse">${icon("chevron")}<span>جمع‌کردن منو</span></button></div></aside><header class="topbar"><button class="icon-btn mobile-menu" data-action="menu" aria-label="بازکردن منو" aria-expanded="${Boolean(mobileOpen)}">${icon("menu")}</button><label class="search-box">${icon("search")}<span class="sr-only">جستجو در صفحه</span><input id="global-search" type="search" value="${esc(query)}" placeholder="جستجو در فضای کار…" autocomplete="off"><kbd class="kbd">Ctrl K</kbd></label><div class="top-actions"><span class="connection ${running ? "live" : ""}"><span class="status-dot"></span><span id="connection-text">${running ? "پردازش در این صفحه فعال است" : "پردازش متوقف است"}</span></span><button class="icon-btn theme-toggle" data-action="theme" aria-label="تغییر پوسته">${icon(document.documentElement.dataset.theme === "dark" ? "sun" : "moon")}</button><button class="icon-btn" data-action="notifications" aria-label="اعلان‌ها">${icon("bell")}</button><button class="profile" data-action="lock-vault" aria-label="قفل‌کردن مخزن"><span class="avatar">م</span><p>مدیر فضای کار<small>${esc(s.settings.panelName)}</small></p>${icon("chevronDown")}</button></div></header><main class="content" id="main-content" tabindex="-1"><div class="page-enter" id="page-content">${body}</div><footer class="footer"><span><b dir="ltr">Rubika Control Pro</b> · نسخهٔ ۱.۰</span><span>اطلاعات واقعی فضای کار · ${date(new Date(), false)} · منطقهٔ زمانی تهران</span></footer></main></div>`;
}
