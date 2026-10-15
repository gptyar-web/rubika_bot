import { Vault } from "./vault.js";
import { RubikaAPI } from "./api.js";
import { Runtime } from "./runtime.js";
import { Actions } from "./actions.js";
import { authView, shellView, NAV } from "./layout.js";
import { pageFor, keypadPreview } from "./pages.js";
import { toast, notice, confirmModal, openModal, closeModal } from "./ui.js";
import { audit, csv, download, esc } from "./utils.js";
import { parseKeypadText } from "./keypad.js";
function preference(key, fallback) {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}
function setPreference(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch {}
}
const initialTheme = preference(
  "rcp-theme",
  matchMedia("(prefers-color-scheme:dark)").matches ? "dark" : "light",
);
document.documentElement.dataset.theme = initialTheme;
const app = {
  vault: new Vault(),
  ctx: {
    days: 7,
    query: "",
    groupId: "",
    collapsed: preference("rcp-sidebar", "") === "collapsed",
    mobileOpen: false,
    running: false,
  },
  features: [],
  exists: false,
  lastActivity: Date.now(),
  releaseSession: null,
  sessionOwned: false,
  locking: false,
  tasks: 0,
};
app.api = new RubikaAPI({ settings: () => app.vault.state?.settings || {} });
app.persist = async () => {
  try {
    await app.vault.save();
  } catch (error) {
    app.engine.stop();
    toast(error.message, "error");
    queueMicrotask(() => app.lock(true));
    throw error;
  }
};
app.engine = new Runtime({
  state: () => app.vault.state,
  persist: app.persist,
  api: app.api,
  changed: () => {
    app.ctx.running = app.engine.running;
    app.refreshRuntime();
  },
});
app.actions = new Actions(app);
app.route = () => {
  const value = location.hash.replace(/^#\/?/, "");
  return NAV.some(([id]) => id === value) ? value : "dashboard";
};
app.refreshRuntime = () => {
  const el = document.querySelector("#connection-text");
  if (el) {
    el.textContent = app.engine.running
      ? "پردازش در این صفحه فعال است"
      : "پردازش متوقف است";
    el.parentElement.classList.toggle("live", app.engine.running);
  }
  if (
    app.vault.state &&
    [
      "dashboard",
      "bots",
      "messages",
      "schedule",
      "logs",
      "users",
      "tickets",
      "violations",
      "reports",
    ].includes(app.route()) &&
    !document.querySelector("#modal").open &&
    !app.tasks &&
    !document.querySelector("main input:focus,main textarea:focus")
  ) {
    const page = document.querySelector("#page-content");
    if (page)
      page.innerHTML = pageFor(
        app.route(),
        app.vault.state,
        app.ctx,
        app.features,
      );
  }
};
app.render = () => {
  const root = document.querySelector("#app");
  if (app.vault.state)
    root.innerHTML = shellView(
      app.vault.state,
      app.route(),
      pageFor(app.route(), app.vault.state, app.ctx, app.features),
      app.ctx,
    );
  else root.innerHTML = authView(app.exists);
  document.title =
    (app.vault.state
      ? NAV.find(([id]) => id === app.route())?.[1] || "داشبورد"
      : "ورود امن") + " | Rubika Control Pro";
};
app.claimSession = async () => {
  if (app.sessionOwned) return true;
  if (!navigator.locks) {
    app.sessionOwned = true;
    return true;
  }
  return new Promise((resolve, reject) =>
    navigator.locks
      .request(
        "rubika-control-pro-vault",
        { ifAvailable: true },
        async (lock) => {
          if (!lock) {
            resolve(false);
            return;
          }
          app.sessionOwned = true;
          resolve(true);
          await new Promise((done) => (app.releaseSession = done));
          app.sessionOwned = false;
        },
      )
      .catch(reject),
  );
};
app.release = () => {
  app.releaseSession?.();
  app.releaseSession = null;
  app.sessionOwned = false;
};
app.stopRuntime = async () => {
  app.engine.stop();
  while (app.engine.busy) await new Promise((r) => setTimeout(r, 100));
};
app.afterUnlock = async () => {
  app.exists = true;
  app.lastActivity = Date.now();
  for (const b of app.vault.state.bots) b.status = "unverified";
  for (const p of app.vault.state.posts.filter((p) => p.status === "sending")) {
    p.status = "interrupted";
    for (const d of Object.values(p.deliveries || {}))
      if (d.status === "sending") d.status = "unknown";
    audit(app.vault.state, "ارسال ناتمام نیازمند بررسی", p.title, "warning");
  }
  audit(app.vault.state, "بازکردن مخزن");
  await app.persist();
  app.render();
  if (
    app.vault.state.settings.autoResume &&
    app.vault.state.bots.some((b) => b.enabled)
  )
    await app.engine.start();
};
app.lock = async (force = false) => {
  if (app.locking) return;
  if (
    !force &&
    (app.tasks > 0 || document.querySelector("button[type=submit]:disabled"))
  ) {
    toast("پس از پایان عملیات جاری مخزن را قفل کنید.", "warning");
    return;
  }
  app.locking = true;
  try {
    await app.stopRuntime();
    closeModal();
    await app.vault.lock();
    app.release();
    app.exists = Boolean(await app.vault.read());
    app.render();
  } finally {
    app.locking = false;
  }
};
const dispatch = async (button) => {
  const action = button.dataset.action,
    id = button.dataset.id,
    s = app.vault.state,
    a = app.actions;
  if (action === "close-modal") {
    closeModal();
    return;
  }
  if (action === "theme") {
    const theme =
      document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    setPreference("rcp-theme", theme);
    return;
  }
  if (action === "restore") {
    a.restore();
    return;
  }
  if (!s) return;
  if (action.startsWith("go-")) {
    location.hash = "#/" + action.slice(3);
    return;
  }
  const find = (list) => s[list].find((x) => x.id === id);
  switch (action) {
    case "menu":
      app.ctx.mobileOpen = !app.ctx.mobileOpen;
      app.render();
      break;
    case "collapse":
      app.ctx.collapsed = !app.ctx.collapsed;
      setPreference(
        "rcp-sidebar",
        app.ctx.collapsed ? "collapsed" : "expanded",
      );
      app.render();
      break;
    case "lock-vault":
      await app.lock();
      break;
    case "notifications":
      openModal(
        "آخرین اعلان‌ها",
        s.logs.filter((l) => l.level !== "info").length
          ? s.logs
              .filter((l) => l.level !== "info")
              .slice(0, 10)
              .map((l) =>
                notice(
                  esc(l.action) + "<br>" + esc(l.details),
                  l.level === "error" ? "warning" : "info",
                ),
              )
              .join("")
          : notice("اعلان خطا یا هشداری ثبت نشده است.", "success"),
      );
      break;
    case "chart-range":
      app.ctx.days = Number(button.dataset.days);
      app.render();
      break;
    case "runtime":
      if (app.engine.running) {
        await app.stopRuntime();
        app.render();
      } else {
        if (!s.bots.some((b) => b.enabled))
          throw new Error("ابتدا یک بات فعال ثبت کنید.");
        await app.engine.start();
        app.render();
        toast("پردازش در این صفحه آغاز شد.");
      }
      break;
    case "add-bot":
      a.addBot();
      break;
    case "test-bot":
      await a.testBot(id);
      break;
    case "toggle-bot": {
      const b = find("bots");
      b.enabled = !b.enabled;
      await a.commit(
        b.enabled ? "فعال‌کردن ربات" : "غیرفعال‌کردن ربات",
        b.name,
      );
      break;
    }
    case "delete-bot": {
      const b = find("bots");
      confirmModal(
        "حذف ربات از مخزن",
        `توکن «${esc(b.name)}» و تنظیمات وابسته از این مخزن حذف می‌شوند. این کار بات را در روبیکا حذف نمی‌کند.`,
        async () => {
          await app.stopRuntime();
          s.bots = s.bots.filter((x) => x.id !== id);
          for (const key of [
            "chats",
            "rules",
            "posts",
            "users",
            "messages",
            "events",
            "tickets",
            "violations",
          ])
            s[key] = s[key].filter((x) => x.botId !== id);
          s.seen = s.seen.filter((k) => !k.startsWith(id + ":"));
          for (const key of Object.keys(s.sessions))
            if (key.startsWith(id + ":")) delete s.sessions[key];
          await a.commit("حذف ربات از مخزن", b.name);
          toast("ربات از مخزن حذف شد.");
        },
        "حذف ربات",
      );
      break;
    }
    case "bot-commands":
      a.botCommands(id);
      break;
    case "add-chat":
      a.chatForm(button.dataset.type || "Group");
      break;
    case "edit-chat":
      a.chatForm("Group", id);
      break;
    case "test-chat":
      await a.testChat(id);
      break;
    case "delete-chat": {
      const c = find("chats");
      confirmModal(
        "حذف مقصد",
        `مجوز مقصد «${esc(c.name)}» از پنل حذف می‌شود. بات از گروه یا کانال خارج نمی‌شود.`,
        async () => {
          s.chats = s.chats.filter((x) => x.id !== id);
          await a.commit("حذف مقصد", c.name);
          toast("مقصد حذف شد.");
        },
        "حذف مقصد",
      );
      break;
    }
    case "compose":
      a.compose();
      break;
    case "reply-message":
      a.compose({ reply: find("messages") });
      break;
    case "edit-message":
      a.editMessage(id);
      break;
    case "delete-message":
      a.deleteMessage(id);
      break;
    case "forward-message":
      a.forwardMessage(id);
      break;
    case "toggle-lock": {
      const c = s.chats.find((x) => x.id === button.dataset.chat);
      c.locks ??= {};
      c.locks[button.dataset.lock] = !c.locks[button.dataset.lock];
      await a.commit("تغییر قفل گروه", c.name + " · " + button.dataset.lock);
      break;
    }
    case "review-violation":
      a.reviewViolation(id);
      break;
    case "add-rule":
      a.ruleForm();
      break;
    case "edit-rule":
      a.ruleForm(id);
      break;
    case "toggle-rule": {
      const r = find("rules");
      r.enabled = !r.enabled;
      await a.commit("تغییر وضعیت اتوماسیون", r.name);
      break;
    }
    case "delete-rule": {
      const r = find("rules");
      confirmModal("حذف قانون", `قانون «${esc(r.name)}» حذف شود؟`, async () => {
        s.rules = s.rules.filter((x) => x.id !== id);
        await a.commit("حذف قانون", r.name);
      });
      break;
    }
    case "test-rule":
      a.testRule(id);
      break;
    case "add-template":
      a.templateForm();
      break;
    case "edit-template":
      a.templateForm(id);
      break;
    case "delete-template":
      confirmModal("حذف قالب", "این قالب از مخزن حذف شود؟", async () => {
        s.templates = s.templates.filter((x) => x.id !== id);
        await a.commit("حذف قالب");
      });
      break;
    case "use-template":
      a.compose({ template: find("templates") });
      break;
    case "preview-keypad":
      document.querySelector("#keypad-preview").innerHTML =
        keypadPreview(
          parseKeypadText(document.querySelector("[name=buttons]").value),
        ) || notice("دکمه‌ای تعریف نشده است.");
      break;
    case "add-post":
      a.postForm();
      break;
    case "edit-post":
      a.postForm(id);
      break;
    case "preview-post":
      a.previewPost(id);
      break;
    case "approve-post":
      a.approvePost(id);
      break;
    case "retry-post":
      a.retryPost(id);
      break;
    case "cancel-post": {
      const p = find("posts");
      p.status = "cancelled";
      await a.commit("لغو انتشار", p.title);
      toast("انتشار زمان‌بندی‌شده لغو شد.");
      break;
    }
    case "add-ticket":
      a.addTicket();
      break;
    case "open-ticket":
      a.openTicket(id);
      break;
    case "manage-user":
      a.manageUser(id);
      break;
    case "backup":
      await a.backup();
      break;
    case "change-password":
      a.changePassword();
      break;
    case "export-report":
      a.exportReport(button.dataset.format);
      break;
    case "export-logs":
      download(
        "rubika-logs.csv",
        csv(
          s.logs.map(({ at, action, details, level }) => ({
            at,
            action,
            details,
            level,
          })),
        ),
        "text/csv;charset=utf-8",
      );
      break;
    case "export-violations":
      download(
        "rubika-violations.csv",
        csv(
          s.violations.map((v) => ({
            time: v.at,
            user: v.userId,
            chat: v.chatId,
            reasons: v.reasons.join("، "),
            action: v.action,
            result: v.status,
            review: v.review,
          })),
        ),
        "text/csv;charset=utf-8",
      );
      break;
    case "export-features":
      download(
        "rubika-150-features.csv",
        csv(
          app.features.map((f) => ({
            id: f.id,
            title: f.title,
            before: f.before,
            status: f.status,
            module: f.module,
            priority: f.priority,
            dependency: f.note,
            test: f.test,
          })),
        ),
        "text/csv;charset=utf-8",
      );
      break;
    case "filter-reports": {
      const from = document.querySelector("[name=report-from]").value,
        to = document.querySelector("[name=report-to]").value;
      if (from && to && from > to)
        throw new Error("ابتدای بازه باید پیش از پایان آن باشد.");
      Object.assign(app.ctx, { from, to });
      app.render();
      break;
    }
    case "install":
      if (app.installPrompt) {
        await app.installPrompt.prompt();
        app.installPrompt = null;
      } else
        toast(
          "در منوی مرورگر «نصب برنامه» یا «افزودن به صفحهٔ اصلی» را انتخاب کنید. نصب باید روی HTTPS انجام شود.",
          "warning",
        );
      break;
  }
};
document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-action]");
  if (!button || button.disabled) return;
  const action = button.dataset.action;
  const lockAction = action === "lock-vault";
  if (!lockAction) app.tasks++;
  button.disabled = true;
  try {
    await dispatch(button);
  } catch (error) {
    toast(error.message, "error");
  } finally {
    if (!lockAction) app.tasks--;
    if (button.isConnected) button.disabled = false;
  }
});
document.addEventListener("submit", async (event) => {
  if (event.target.id === "auth-form") {
    event.preventDefault();
    const form = event.target,
      data = new FormData(form),
      submit = form.querySelector("[type=submit]"),
      error = form.querySelector(".form-error");
    if (submit.disabled) return;
    submit.disabled = true;
    error.textContent = "";
    try {
      if (!app.exists && data.get("password") !== data.get("confirm"))
        throw new Error("تکرار رمز مطابقت ندارد.");
      if (!(await app.claimSession()))
        throw new Error(
          "این مخزن در زبانهٔ دیگری باز است. ابتدا آن را قفل کنید.",
        );
      if (app.exists) await app.vault.unlock(data.get("password"));
      else await app.vault.create(data.get("password"));
      await app.afterUnlock();
    } catch (e) {
      if (!app.vault.state) app.release();
      error.textContent = e.message;
      submit.disabled = false;
    }
  }
  if (event.target.id === "settings-form") {
    event.preventDefault();
    const form = event.target,
      submit = form.querySelector("[type=submit]");
    if (submit.disabled) return;
    submit.disabled = true;
    app.tasks++;
    try {
      await app.actions.settings(new FormData(form));
    } catch (error) {
      form.querySelector(".form-error").textContent = error.message;
    } finally {
      app.tasks--;
      if (submit.isConnected) submit.disabled = false;
    }
  }
});
let searchTimer;
document.addEventListener("input", (event) => {
  if (event.target.id === "global-search") {
    app.ctx.query = event.target.value;
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      const page = document.querySelector("#page-content");
      if (page && app.vault.state)
        page.innerHTML = pageFor(
          app.route(),
          app.vault.state,
          app.ctx,
          app.features,
        );
    }, 180);
  }
  if (
    event.target.name === "text" &&
    document.querySelector("#message-preview")
  )
    document.querySelector("#message-preview").textContent =
      event.target.value || "پیش‌نمایش متن پیام…";
});
document.addEventListener("change", (event) => {
  const t = event.target;
  if (t.name === "group-filter") {
    app.ctx.groupId = t.value;
    app.render();
  }
  if (t.name === "post-filter") {
    app.ctx.postStatus = t.value;
    app.render();
  }
  if (t.name === "feature-filter") {
    app.ctx.featureStatus = t.value;
    app.render();
  }
  if (t.name === "type" && document.querySelector("#compose-fields"))
    document.querySelector("#compose-fields").innerHTML =
      app.actions.messageFields(t.value);
  if (t.name === "canned" && t.value) {
    const template = app.vault.state.templates.find((x) => x.id === t.value);
    const field = document.querySelector("[name=reply]");
    if (template && field) field.value = template.text;
  }
});
window.addEventListener("hashchange", () => {
  app.ctx.mobileOpen = false;
  app.ctx.query = "";
  app.render();
  document.querySelector("#main-content")?.focus();
  window.scrollTo(0, 0);
});
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  app.installPrompt = event;
});
window.addEventListener("offline", () => {
  app.engine.stop();
  toast(
    "اینترنت قطع شد. پردازش متوقف است؛ پس از اتصال دوباره آن را آغاز کنید.",
    "warning",
  );
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    document.querySelector("#global-search")?.focus();
  }
});
for (const eventName of ["pointerdown", "keydown", "input", "scroll"])
  document.addEventListener(eventName, () => (app.lastActivity = Date.now()), {
    passive: true,
    capture: true,
  });
setInterval(() => {
  if (
    app.vault.state &&
    !app.tasks &&
    !app.locking &&
    !document.querySelector("button[type=submit]:disabled") &&
    Date.now() - app.lastActivity > app.vault.state.settings.idleMinutes * 60000
  )
    app.lock();
}, 15000);
async function boot() {
  try {
    if (!globalThis.crypto?.subtle || !globalThis.indexedDB)
      throw new Error(
        "مرورگر به Web Crypto و IndexedDB نیاز دارد. پنل را روی HTTPS یا localhost باز کنید.",
      );
    const [envelope, features] = await Promise.all([
      app.vault.read(),
      fetch("./docs/features.json", { cache: "no-cache" }).then((r) => {
        if (!r.ok) throw new Error("جدول قابلیت‌ها بارگذاری نشد.");
        return r.json();
      }),
    ]);
    app.exists = Boolean(envelope);
    app.features = features;
    app.render();
    if ("serviceWorker" in navigator)
      navigator.serviceWorker
        .register("./sw.js", { scope: "./" })
        .catch(() =>
          toast(
            "حالت آفلاین فعال نشد؛ اجرای آنلاین همچنان در دسترس است.",
            "warning",
          ),
        );
  } catch (error) {
    document.querySelector("#app").innerHTML =
      `<main class="boot"><h1>پنل آماده نشد</h1><p>${esc(error.message)}</p><p>اتصال، مجوز ذخیره‌سازی و نشانی HTTPS را بررسی کرده و صفحه را دوباره بارگذاری کنید.</p></main>`;
  }
}
boot();
