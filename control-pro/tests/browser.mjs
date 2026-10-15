import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
const out = "test-results";
await mkdir(out, { recursive: true });
const server = spawn(process.execPath, ["scripts/serve.mjs", "dist"], {
  env: { ...process.env, PORT: "4180" },
  stdio: ["ignore", "pipe", "pipe"],
});
await new Promise((resolve, reject) => {
  server.stdout.once("data", resolve);
  server.once("error", reject);
  server.once(
    "exit",
    (code) => code && reject(new Error("Preview server failed.")),
  );
});
const browser = await chromium.launch({
  headless: true,
  ...(process.env.BROWSER_EXECUTABLE
    ? { executablePath: process.env.BROWSER_EXECUTABLE }
    : {}),
  args: ["--no-sandbox"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
  colorScheme: "light",
  serviceWorkers: "block",
  acceptDownloads: true,
});
const errors = [],
  requests = [];
let msgCount = 0,
  updatesUsed = false,
  rejectSend = false;
await context.route("https://botapi.rubika.ir/v3/**", async (route) => {
  const req = route.request();
  if (req.method() === "OPTIONS") {
    await route.fulfill({
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "content-type",
        "Access-Control-Allow-Methods": "POST",
      },
    });
    return;
  }
  const method = new URL(req.url()).pathname.split("/").at(-1),
    payload = req.postDataJSON();
  requests.push({ method, payload });
  let data = {};
  if (method === "getMe")
    data = {
      bot: {
        bot_id: "testbot",
        username: "test_bot",
        bot_title: "بات آزمایشی",
      },
    };
  if (method === "getChat")
    data = {
      chat: {
        chat_id: payload.chat_id,
        chat_type: payload.chat_id === "group-test" ? "Group" : "Channel",
        title: "مقصد آزمایشی",
      },
    };
  if (
    method === "sendMessage" ||
    method === "sendPoll" ||
    method === "sendFile" ||
    method === "sendLocation" ||
    method === "sendContact"
  )
    data = { message_id: "out-" + ++msgCount };
  if (method === "forwardMessage")
    data = { new_message_id: "forward-" + ++msgCount };
  if (method === "getUpdates") {
    data = {
      updates: updatesUsed
        ? []
        : [
            {
              type: "NewMessage",
              chat_id: "group-test",
              new_message: {
                message_id: "in-1",
                sender_id: "user-test",
                sender_type: "User",
                text: "سلام",
              },
            },
            {
              type: "NewMessage",
              chat_id: "group-test",
              new_message: {
                message_id: "in-2",
                sender_id: "user-test",
                sender_type: "User",
                text: "https://evil.test",
              },
            },
            {
              type: "NewMessage",
              chat_id: "group-test",
              new_message: {
                message_id: "in-3",
                sender_id: "user-test",
                sender_type: "User",
                text: "/ticket نیاز به کمک",
              },
            },
          ],
      next_offset_id: "next",
    };
    updatesUsed = true;
  }
  await route.fulfill({
    status: 200,
    contentType: "application/json",
    headers: { "Access-Control-Allow-Origin": "*" },
    body: JSON.stringify({
      status: rejectSend && method === "sendMessage" ? "ERROR" : "OK",
      data,
    }),
  });
});
const page = await context.newPage();
page.on("pageerror", (e) => errors.push(e.message));
page.on("requestfailed", r=>console.error("REQUEST_FAILED "+new URL(r.url()).origin+" "+r.failure()?.errorText));
page.on("console", m=>{if(m.type()==="error")console.error("BROWSER_CONSOLE "+m.text().replaceAll("SYNTHETIC_TEST_TOKEN_ONLY","[TEST]"));});
const base = "http://localhost:4180/rubika_bot/";
const nav = async (route) => {
  await page.locator(`nav a[href="#/${route}"]`).click();
  await page.locator(`nav a[href="#/${route}"].active`).waitFor();
};
const modal = () => page.locator("#modal");
const fill = async (name, value) =>
  modal().locator(`[name="${name}"]`).fill(value);
const submit = async () => {
  await modal().locator("[type=submit]").click();
};
const closed = async () => modal().waitFor({ state: "hidden" });
const checks = [];
const ok = (name) => {
  checks.push(name);
  console.log("PASS " + name);
};
try {
  await page.goto(base);
  await page
    .getByRole("heading", { name: "فضای کار امن خود را بسازید" })
    .waitFor();
  await page.screenshot({ path: out + "/auth-desktop.png", fullPage: true });
  await page.locator("[name=password]").fill("test vault passphrase 2026");
  await page.locator("[name=confirm]").fill("not the same passphrase");
  await page.getByRole("button", { name: "ساخت مخزن امن" }).click();
  await page.getByRole("alert").getByText("تکرار رمز مطابقت ندارد.").waitFor();
  await page.locator("[name=confirm]").fill("test vault passphrase 2026");
  await page.getByRole("button", { name: "ساخت مخزن امن" }).click();
  await page.getByRole("heading", { name: "داشبورد", exact: true }).waitFor();
  ok("vault creation and confirmation validation");
  await page.screenshot({ path: out + "/dashboard-empty.png", fullPage: true });
  assert(
    !(await page
      .locator("body")
      .innerText()
      .then((t) => t.includes("۱۲٬۴۵۰"))),
  );
  await nav("bots");
  await page.locator('.page-header').getByRole("button", { name: "افزودن ربات", exact: true }).click();
  await fill("name", "بات آزمایشی");
  await fill("token", "SYNTHETIC_TEST_TOKEN_ONLY");
  await submit();
  await closed();
  await page
    .getByRole("heading", { name: "بات آزمایشی", exact: true })
    .waitFor();
  ok("bot getMe validation and encrypted save");
  await page.locator('.page-header').getByRole("button", { name: "افزودن ربات", exact: true }).click();
  await fill("name", "تکراری");
  await fill("token", "SYNTHETIC_TEST_TOKEN_ONLY");
  await submit();
  await modal().getByText("این توکن قبلاً ذخیره شده است.").waitFor();
  await modal().getByRole("button", { name: "انصراف", exact: true }).click();
  ok("duplicate bot rejection");
  await nav("groups");
  await page.getByRole("button", { name: "افزودن گروه", exact: true }).click();
  await fill("name", "گروه تیم");
  await fill("chatId", "group-test");
  await modal().locator("[name=consent]").check();
  await modal().locator("[name=moderationEnabled]").check();
  await fill("adminIds", "admin-test");
  await submit();
  await closed();
  ok("authorized group creation");
  await nav("channels");
  await page.getByRole("button", { name: "افزودن کانال", exact: true }).click();
  await fill("name", "کانال تیم");
  await fill("chatId", "channel-test");
  await modal().locator("[name=consent]").check();
  await submit();
  await closed();
  ok("authorized channel creation");
  await nav("locks");
  await page.getByRole("switch", { name: "لینک", exact: true }).click();
  await page
    .getByRole("switch", { name: "لینک", exact: true, checked: true })
    .waitFor();
  assert.equal(
    await page.getByRole("switch", { name: "تصویر", exact: true }).isDisabled(),
    true,
  );
  ok("group lock persistence and honest unsupported state");
  await nav("automation");
  await page.getByRole("button", { name: "قانون جدید", exact: true }).click();
  await fill("name", "پاسخ سلام");
  await fill("trigger", "سلام");
  await fill("response", "درود {{user_id}}");
  await submit();
  await closed();
  ok("automation rule creation");
  await nav("templates");
  await page.getByRole("button", { name: "قالب جدید", exact: true }).click();
  await fill("name", "قالب تیم");
  await fill("text", "سلام {{chat}}");
  await fill("buttons", "help:راهنما | contact:تماس");
  await modal().getByRole("button", { name: "نمایش کیبورد" }).click();
  assert.equal(await modal().locator(".keypad-preview span").count(), 2);
  await submit();
  await closed();
  ok("keypad preview and template save");
  await nav("messages");
  await page.getByRole("button", { name: "پیام جدید", exact: true }).click();
  await fill("text", "یک پیام آزمایشی");
  await submit();
  await closed();
  await page.locator("table").getByText("یک پیام آزمایشی", { exact: false }).first().waitFor();
  ok("sendMessage requires valid API message ID");
  await page.locator("[data-action=edit-message]").first().click();
  await fill("text", "پیام ویرایش‌شده");
  await submit();
  await closed();
  assert(requests.some((r) => r.method === "editMessageText"));
  ok("editMessageText integration");
  await page.getByRole("button", { name: "پیام جدید", exact: true }).click();
  await modal().locator("[name=type]").selectOption("poll");
  await fill("question", "کدام؟");
  await fill("options", "اول\nدوم");
  await submit();
  await closed();
  assert(
    requests.some(
      (r) => r.method === "sendPoll" && r.payload.options.length === 2,
    ),
  );
  ok("poll payload and send");
  rejectSend = true;
  await page.getByRole("button", { name: "پیام جدید", exact: true }).click();
  await fill("text", "این ارسال باید رد شود");
  await submit();
  await modal()
    .locator(".form-error")
    .getByText("API عملیات را تأیید نکرد.", { exact: false })
    .waitFor();
  await modal().getByRole("button", { name: "انصراف", exact: true }).click();
  assert.equal(
    await page.locator("table").getByText("این ارسال باید رد شود").count(),
    0,
  );
  rejectSend = false;
  ok("failed API write never appears sent");
  await nav("schedule");
  await page.getByRole("button", { name: "ساخت پست", exact: true }).click();
  await fill("title", "اطلاعیهٔ تیم");
  await fill("text", "متن انتشار زمان‌بندی‌شده");
  await modal().locator("[name=destinations]").last().check();
  await submit();
  await closed();
  await page.locator("[data-action=approve-post]").click();
  const future = new Date(Date.now() + 5 * 60000);
  const tehran = new Date(future.getTime() + 210 * 60000)
    .toISOString()
    .slice(0, 16);
  await fill("scheduledAt", tehran);
  await modal().locator("[name=approved]").check();
  await submit();
  await closed();
  await page.locator(".pill").filter({hasText:"زمان‌بندی‌شده"}).first().waitFor();
  ok("draft approval and Tehran schedule");
  await nav("bots");
  await page.getByRole("button", { name: "شروع پردازش", exact: true }).click();
  await page.waitForFunction(() =>
    document
      .querySelector("#connection-text")
      ?.textContent.includes("فعال است"),
  );
  await nav("messages");
  await page.locator("table").getByText("درود user-test", { exact: false }).first().waitFor();
  await nav("violations");
  await page.getByText("لینک غیرمجاز", { exact: true }).waitFor();
  await nav("tickets");
  await page
    .getByRole("button", { name: "مشاهده و پاسخ", exact: true })
    .waitFor();
  ok("polling auto-response, moderation and ticket ingestion");
  await nav("users");
  await page.getByText("user-test", { exact: true }).waitFor();
  ok("only observed authorized users recorded");
  await nav("reports");
  const downloadPromise = page.waitForEvent("download");
  await page.locator("[data-action=export-report][data-format=csv]").click();
  const d = await downloadPromise;
  const exported = await readFile(await d.path(), "utf8");
  assert(!exported.includes("SYNTHETIC_TEST_TOKEN_ONLY"));
  ok("CSV report excludes secrets");
  await nav("features");
  assert.equal(await page.locator("tbody tr").count(), 150);
  await page.locator("[name=feature-filter]").selectOption("server");
  assert((await page.locator("tbody tr").count()) > 0);
  ok("150-feature matrix and filtering");
  await nav("bots");
  await page.getByRole("button", { name: "توقف پردازش", exact: true }).click();
  await nav("settings");
  const backupPromise = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "پشتیبان رمزگذاری‌شده", exact: true })
    .click();
  const backupDownload = await backupPromise;
  const backupText = await readFile(await backupDownload.path(), "utf8");
  assert.equal(JSON.parse(backupText).format, "rubika-control-pro");
  assert(!backupText.includes("SYNTHETIC_TEST_TOKEN_ONLY"));
  ok("encrypted backup has no plaintext token");
  const persistent = await page.evaluate(async () => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("rubika-control-pro", 1);
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    const envelope = await new Promise((resolve) => {
      const r = db.transaction("vault").objectStore("vault").get("main");
      r.onsuccess = () => resolve(r.result);
    });
    db.close();
    return { envelope, local: { ...localStorage } };
  });
  assert(!JSON.stringify(persistent).includes("SYNTHETIC_TEST_TOKEN_ONLY"));
  ok("IndexedDB and Local Storage contain no plaintext credentials");
  await nav("dashboard");
  await page.screenshot({
    path: out + "/dashboard-desktop.png",
    fullPage: true,
  });
  const theme = await page.locator("html").getAttribute("data-theme");
  await page.locator("[data-action=theme]").first().click();
  assert.notEqual(await page.locator("html").getAttribute("data-theme"), theme);
  await page.screenshot({ path: out + "/dashboard-dark.png", fullPage: true });
  await page.locator("[data-action=theme]").first().click();
  ok("light/dark theme persistence");
  // All route layouts must fit the viewport; tables may scroll inside their own wrapper.
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const route of [
      "dashboard",
      "bots",
      "groups",
      "channels",
      "messages",
      "locks",
      "automation",
      "schedule",
      "templates",
      "tickets",
      "users",
      "reports",
      "logs",
      "features",
      "settings",
    ]) {
      await page.evaluate((r) => {
        location.hash = "#/" + r;
      }, route);
      await page.getByRole("heading", { level: 1 }).waitFor();
      await page.waitForTimeout(40);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth > innerWidth + 2,
      );
      assert(!overflow, `Horizontal page overflow: ${route} at ${width}`);
    }
    ok(`all 15 layouts at ${width}px`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => {
    location.hash = "#/dashboard";
  });
  await page.getByRole("button", { name: "بازکردن منو" }).click();
  await page.locator(".shell.mobile-open").waitFor();
  await page.locator(".mobile-backdrop").click({ position: { x: 10, y: 10 } });
  await page.screenshot({
    path: out + "/dashboard-mobile.png",
    fullPage: true,
  });
  ok("mobile sidebar open and close");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => {
    location.hash = "#/settings";
  });
  await page
    .getByRole("button", { name: "قفل‌کردن مخزن", exact: true })
    .last()
    .click();
  await page.getByRole("heading", { name: "به فضای کارتان برگردید" }).waitFor();
  await page.reload();
  await page.getByRole("heading", { name: "به فضای کارتان برگردید" }).waitFor();
  await page.locator("[name=password]").fill("bad password");
  await page.getByRole("button", { name: "بازکردن فضای کار" }).click();
  await page
    .getByRole("alert")
    .getByText("رمز مخزن درست نیست", { exact: false })
    .waitFor();
  await page.locator("[name=password]").fill("test vault passphrase 2026");
  await page.getByRole("button", { name: "بازکردن فضای کار" }).click();
  await page
    .getByRole("heading", { name: "تنظیمات فضای کار", exact: true })
    .waitFor();
  await nav("bots");
  await page
    .getByRole("heading", { name: "بات آزمایشی", exact: true })
    .waitFor();
  ok("token survives reload; only vault passphrase is re-entered");
  const second = await context.newPage();
  await second.goto(base);
  await second.locator("[name=password]").fill("test vault passphrase 2026");
  await second.getByRole("button", { name: "بازکردن فضای کار" }).click();
  await second
    .getByRole("alert")
    .getByText("این مخزن در زبانهٔ دیگری باز است.", { exact: false })
    .waitFor();
  await second.close();
  ok("second tab cannot concurrently unlock the vault");
  assert.deepEqual(errors, []);
  ok("no uncaught browser errors");
  console.log(
    JSON.stringify({
      passed: checks.length,
      apiRequests: requests.length,
      screenshots: out,
    }),
  );
} catch (error) {
  await page.screenshot({ path: out + "/failure.png", fullPage: true });
  console.error("BROWSER_FAILURE " + error.message);
  console.error((await page.locator("body").innerText()).slice(-5000));
  throw error;
} finally {
  await browser.close();
  server.kill();
}
