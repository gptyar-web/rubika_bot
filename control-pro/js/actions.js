import {
  esc,
  uid,
  date,
  fa,
  audit,
  download,
  csv,
  renderTemplate,
  safePattern,
  localInputISO,
} from "./utils.js";
import {
  btn,
  pill,
  field,
  textarea,
  select,
  check,
  notice,
  formBody,
  openModal,
  closeModal,
  confirmModal,
  toast,
} from "./ui.js";
import { parseKeypadText } from "./keypad.js";
import { messagePayload } from "./api.js";
import { ruleMatches } from "./moderation.js";
import { keypadPreview } from "./pages.js";
const botOptions = (s) => s.bots.map((b) => [b.id, b.name]);
const chatOptions = (s) =>
  s.chats
    .filter((c) => c.consent)
    .map((c) => [
      c.id,
      c.name + " · " + (s.bots.find((b) => b.id === c.botId)?.name || ""),
    ]);
const splitLines = (s) =>
  String(s || "")
    .split("\n")
    .map((x) => x.trim())
    .filter(Boolean);
export class Actions {
  constructor(app) {
    this.app = app;
  }
  get s() {
    return this.app.vault.state;
  }
  async commit(action, details = "") {
    audit(this.s, action, details);
    await this.app.persist();
    this.app.render();
  }
  requireBot() {
    if (!this.s.bots.length) {
      toast("ابتدا یک ربات اضافه کنید.", "warning");
      return false;
    }
    return true;
  }
  addBot() {
    openModal(
      "افزودن ربات",
      formBody(
        `${field("name", "نام دلخواه ربات", "", "text", "", 'required maxlength="60"')}${field("token", "توکن BotFather", "", "password", "توکن فقط در مخزن رمزگذاری‌شده ذخیره می‌شود.", 'required autocomplete="off" spellcheck="false" dir="ltr" maxlength="512"')}${check("verify", "اعتبارسنجی آنلاین با API رسمی پیش از ذخیره", true)}${notice("اگر اتصال مستقیم با محدودیت CORS روبه‌رو شد، می‌توانید توکن را بدون تأیید آنلاین ذخیره و سپس واسط شخصی را تنظیم کنید.", "warning")}`,
        "ذخیرهٔ ربات",
      ),
      async (data) => {
        const token = data.get("token").trim(),
          name = data.get("name").trim();
        if (!name || !token || /[\s/?#]/.test(token))
          throw new Error("نام یا قالب توکن معتبر نیست.");
        if (this.s.bots.some((b) => b.token === token))
          throw new Error("این توکن قبلاً ذخیره شده است.");
        let info = null;
        if (data.has("verify")) {
          const result = await this.app.api.call(token, "getMe");
          info = result.bot || result;
          if (!info.bot_id)
            throw new Error("پاسخ getMe شامل شناسهٔ معتبر بات نیست.");
          if (this.s.bots.some((b) => b.botId === info.bot_id))
            throw new Error("این بات قبلاً ثبت شده است.");
        }
        this.s.bots.push({
          id: uid(),
          name,
          token,
          botId: info?.bot_id || "",
          username: info?.username || "",
          enabled: true,
          status: info ? "connected" : "unverified",
          verifiedAt: info ? new Date().toISOString() : null,
          createdAt: new Date().toISOString(),
        });
        await this.commit("افزودن ربات", name);
        closeModal();
        toast(
          info
            ? "ربات تأیید و رمزگذاری شد."
            : "توکن رمزگذاری شد؛ اتصال هنوز تأیید نشده است.",
        );
      },
    );
  }
  async testBot(id) {
    const b = this.s.bots.find((x) => x.id === id);
    if (!b) return;
    const start = Date.now();
    try {
      const result = await this.app.api.call(b.token, "getMe"),
        info = result.bot || result;
      if (!info.bot_id) throw new Error("شناسهٔ بات در پاسخ API موجود نیست.");
      b.botId = info.bot_id;
      b.username = info.username || "";
      b.status = "connected";
      b.verifiedAt = new Date().toISOString();
      b.latency = Date.now() - start;
      await this.commit("بررسی موفق اتصال", b.name);
      toast("اتصال توسط API تأیید شد.");
    } catch (error) {
      b.status = "error";
      await this.commit("خطای بررسی اتصال", b.name);
      throw error;
    }
  }
  botCommands(id) {
    const b = this.s.bots.find((x) => x.id === id);
    if (!b) return;
    openModal(
      "دستورهای " + b.name,
      formBody(
        `${textarea("commands", "هر خط: دستور | توضیح", (b.commands || []).map((c) => c.command + " | " + c.description).join("\n"), "این فهرست به setCommands ارسال می‌شود؛ پاسخ هر دستور را در اتوماسیون تعریف کنید.", "required")}`,
        "ثبت در روبیکا",
      ),
      async (data) => {
        const commands = splitLines(data.get("commands")).map((line) => {
          const [command, ...description] = line.split("|");
          if (!command?.trim() || !description.join("|").trim())
            throw new Error("هر دستور باید نام و توضیح داشته باشد.");
          return {
            command: command.trim(),
            description: description.join("|").trim(),
          };
        });
        if (commands.length > 30) throw new Error("حداکثر ۳۰ دستور وارد کنید.");
        await this.app.api.call(b.token, "setCommands", {
          bot_commands: commands,
        });
        b.commands = commands;
        await this.commit("به‌روزرسانی دستورهای بات", b.name);
        closeModal();
        toast("دستورها در API ثبت شدند.");
      },
    );
  }
  chatForm(type = "Group", id) {
    if (!this.requireBot()) return;
    const chat = id ? this.s.chats.find((c) => c.id === id) : null;
    if (id && !chat) return;
    type = chat?.type || type;
    const labels = { Group: "گروه", Channel: "کانال", User: "گفتگو" };
    openModal(
      (chat ? "تنظیمات " : "ثبت ") + labels[type],
      formBody(
        `${select("botId", "ربات", botOptions(this.s), chat?.botId)}${field("name", "نام نمایشی", chat?.name || "", "text", "", 'required maxlength="80"')}${field("chatId", "شناسهٔ مقصد", chat?.chatId || "", "text", "شناسهٔ واقعی chat_id، نه نام کاربری یا لینک دعوت.", 'required dir="ltr" maxlength="150" ' + (chat ? "readonly" : ""))}${check("consent", "برای مدیریت و ارسال در این مقصد مجوز دارم.", chat?.consent || false)}${chat ? "" : check("verify", "اطلاعات مقصد با getChat بررسی شود.", true)}${
          type === "Group"
            ? `<div class="subsection"><h3>قوانین و رفتار</h3>${textarea("rules", "قوانین گروه", chat?.rules || "", "با دستور /rules به کاربر پاسخ داده می‌شود.", 'maxlength="3000"')}${check("moderationEnabled", "پردازش قوانین این گروه فعال باشد.", chat?.moderationEnabled)}${select(
                "action",
                "واکنش به تخلف",
                [
                  ["log", "فقط ثبت تخلف"],
                  ["warn", "ارسال اخطار"],
                  ["delete", "حذف پیام با مجوز بات"],
                ],
                chat?.action || "log",
              )}${textarea("adminIds", "شناسه‌های مدیران معتبر", (chat?.adminIds || []).join("\n"), "هر خط یک شناسه؛ این افراد از همهٔ قفل‌ها مستثنا هستند. این فهرست با API تأیید نمی‌شود.")}${textarea("exemptIds", "سایر استثناها", (chat?.exemptIds || []).join("\n"), "هر خط یک شناسه")}</div><div class="subsection"><h3>فیلتر و ضداسپم</h3>${textarea("words", "کلمات ممنوع", (chat?.words || []).join("\n"), "هر خط یک واژه")}${textarea("patterns", "الگوهای ممنوع امن", (chat?.patterns || []).join("\n"), "بدون گروه‌بندی، تکرار و escape؛ برای نمونه: ^تبلیغ|فروش")}${textarea("allowedDomains", "دامنه‌های مجاز", (chat?.allowedDomains || []).join("\n"), "فقط دامنه، بدون https؛ مانند example.com")}${field("floodLimit", "سقف پیام در بازه", chat?.floodLimit || 0, "number", "صفر یعنی غیرفعال.", 'min="0" max="100"')}${field("floodSeconds", "طول بازه (ثانیه)", chat?.floodSeconds || 10, "number", "", 'min="1" max="300"')}${check("preventDuplicates", "تشخیص متن تکراری در همین بازه", chat?.preventDuplicates)}<div class="form-grid">${field("quietStart", "شروع سکوت به وقت تهران", chat?.quietHours?.start || "", "time")}${field("quietEnd", "پایان سکوت", chat?.quietHours?.end || "", "time")}</div></div>`
            : ""
        }`,
        "ذخیرهٔ مقصد",
      ),
      async (data) => {
        const botId = data.get("botId"),
          bot = this.s.bots.find((b) => b.id === botId),
          chatId = data.get("chatId").trim(),
          name = data.get("name").trim();
        if (!bot || !chatId || !name)
          throw new Error("ربات، نام و شناسهٔ معتبر لازم است.");
        if (!chat && !data.has("consent"))
          throw new Error("برای ثبت مقصد باید مجوز داشته باشید.");
        if (chat && botId !== chat.botId)
          throw new Error("ربات مقصد را نمی‌توان تغییر داد؛ مقصد جدید بسازید.");
        if (
          !chat &&
          this.s.chats.some((c) => c.botId === botId && c.chatId === chatId)
        )
          throw new Error("این مقصد قبلاً برای همین بات ثبت شده است.");
        let info = null;
        if (data.has("verify")) {
          const r = await this.app.api.call(bot.token, "getChat", {
            chat_id: chatId,
          });
          info = r.chat;
          if (!info || info.chat_id !== chatId)
            throw new Error("API این مقصد را تأیید نکرد.");
          if (info.chat_type && info.chat_type !== type)
            throw new Error("نوع مقصد با پاسخ API همخوان نیست.");
        }
        const patterns = splitLines(data.get("patterns"));
        patterns.forEach(safePattern);
        const value = {
          ...(chat || {
            id: uid(),
            locks: {},
            createdAt: new Date().toISOString(),
          }),
          botId,
          chatId,
          name,
          type,
          consent: data.has("consent"),
          verified: Boolean(info || chat?.verified),
        };
        if (type === "Group") {
          const adminIds = splitLines(data.get("adminIds"));
          if (
            data.has("moderationEnabled") &&
            data.get("action") !== "log" &&
            !adminIds.length
          )
            throw new Error(
              "پیش از فعال‌کردن اخطار یا حذف، شناسهٔ مدیران معتبر را برای استثنا ثبت کنید.",
            );
          Object.assign(value, {
            rules: data.get("rules").trim(),
            moderationEnabled: data.has("moderationEnabled"),
            action: data.get("action"),
            adminIds,
            exemptIds: splitLines(data.get("exemptIds")),
            words: splitLines(data.get("words")),
            patterns,
            allowedDomains: splitLines(data.get("allowedDomains")).map((d) => {
              if (!/^[\p{L}\p{N}.-]+$/u.test(d) || !d.includes("."))
                throw new Error("دامنهٔ مجاز معتبر نیست.");
              return d.toLowerCase();
            }),
            floodLimit: Number(data.get("floodLimit")),
            floodSeconds: Number(data.get("floodSeconds")),
            preventDuplicates: data.has("preventDuplicates"),
            quietHours: {
              start: data.get("quietStart"),
              end: data.get("quietEnd"),
            },
          });
        }
        if (chat) Object.assign(chat, value);
        else this.s.chats.push(value);
        await this.commit(chat ? "تغییر تنظیمات مقصد" : "افزودن مقصد", name);
        closeModal();
        toast("تنظیمات مقصد ذخیره شد.");
      },
    );
  }
  async testChat(id) {
    const c = this.s.chats.find((x) => x.id === id),
      b = this.s.bots.find((x) => x.id === c?.botId);
    if (!b) return;
    const r = await this.app.api.call(b.token, "getChat", {
      chat_id: c.chatId,
    });
    if (!r.chat?.chat_id) throw new Error("اطلاعات مقصد معتبر نیست.");
    c.verified = true;
    await this.commit("بررسی مقصد", c.name);
    toast("اطلاعات مقصد از API دریافت شد.");
  }
  compose({ reply, template } = {}) {
    if (!this.requireBot()) return;
    if (!chatOptions(this.s).length) {
      toast("ابتدا یک مقصد دارای مجوز ثبت کنید.", "warning");
      this.chatForm("User");
      return;
    }
    const selected = reply
      ? this.s.chats.find(
          (c) => c.botId === reply.botId && c.chatId === reply.chatId,
        )
      : null;
    openModal(
      "نوشتن پیام",
      formBody(
        `${select("destination", "مقصد مجاز", chatOptions(this.s), selected?.id)}${select(
          "type",
          "نوع پیام",
          [
            ["text", "متن و کیبورد"],
            ["file", "فایل با شناسهٔ روبیکا"],
            ["poll", "نظرسنجی"],
            ["location", "موقعیت"],
            ["contact", "مخاطب"],
          ],
          "text",
        )}<div id="compose-fields">${this.messageFields("text", template?.text || "")}</div>${field("replyId", "شناسهٔ پیام برای پاسخ", reply?.messageId || "", "text", "", 'dir="ltr"')}${template?.keypad ? `<input type="hidden" name="templateId" value="${esc(template.id)}">${keypadPreview(template.keypad)}` : ""}${notice("فقط پس از دریافت پاسخ موفق API، پیام در آرشیو ارسالی ثبت می‌شود. برای جلوگیری از ارسال تکراری، ارسال نامشخص خودکار تکرار نمی‌شود.")}<div id="message-preview" class="preview">${esc(template?.text || "پیش‌نمایش متن پیام…")}</div>`,
        "ارسال پیام",
      ),
      async (data) => {
        const c = this.s.chats.find(
            (x) => x.id === data.get("destination") && x.consent,
          ),
          b = this.s.bots.find((x) => x.id === c?.botId);
        if (!c || !b || !b.enabled) throw new Error("ربات یا مقصد فعال نیست.");
        const fields = Object.fromEntries(data),
          variables = {
            name: c.name,
            chat: c.name,
            date: date(new Date(), false),
            user_id: c.type === "User" ? c.chatId : "",
          };
        fields.chatId = c.chatId;
        fields.text = renderTemplate(fields.text || "", variables);
        const t = this.s.templates.find((t) => t.id === data.get("templateId"));
        if (t) {
          fields.keypad = t.keypad;
          fields.keypadType = t.keypadType;
        }
        const { method, payload } = messagePayload(data.get("type"), fields);
        const result = await this.app.api.call(b.token, method, payload);
        if (!result.message_id)
          throw new Error(
            "API شناسهٔ پیام را برنگرداند؛ پیش از تکرار، مقصد را بررسی کنید.",
          );
        this.s.messages.push({
          id: uid(),
          botId: b.id,
          chatId: c.chatId,
          messageId: result.message_id,
          text:
            payload.text || payload.question || "[" + data.get("type") + "]",
          direction: "out",
          type: data.get("type"),
          status: "sent",
          at: new Date().toISOString(),
        });
        this.s.messages = this.s.messages.slice(-5000);
        await this.commit("ارسال موفق پیام", c.name);
        closeModal();
        toast("پیام با تأیید API ارسال شد.");
      },
    );
  }
  messageFields(type, text = "") {
    if (type === "text")
      return textarea(
        "text",
        "متن پیام",
        text,
        "حداکثر ۴۰۹۶ نویسه.",
        'required maxlength="4096"',
      );
    if (type === "file")
      return `${field("fileId", "شناسهٔ فایل روبیکا", "", "text", "file_id فایلِ قبلاً آپلودشده را وارد کنید. ارسال رسانه با کپشن در این نسخه تأیید نشده است.", 'required dir="ltr"')}${notice("آپلود از دستگاه و ارسال تصویر، ویدئو، صدا یا GIF با کپشن هنوز پیاده‌سازی نشده‌اند.", "warning")}`;
    if (type === "poll")
      return `${field("question", "سؤال", "", "text", "", 'required maxlength="300"')}${textarea("options", "گزینه‌ها", "", "هر خط یک گزینه؛ بین ۲ تا ۱۰ گزینه.", "required")}`;
    if (type === "location")
      return `<div class="form-grid">${field("latitude", "عرض جغرافیایی", "", "number", "", 'required min="-90" max="90" step="any" dir="ltr"')}${field("longitude", "طول جغرافیایی", "", "number", "", 'required min="-180" max="180" step="any" dir="ltr"')}</div>`;
    if (type === "contact")
      return `${field("firstName", "نام", "", "text", "", 'required maxlength="80"')}${field("lastName", "نام خانوادگی", "", "text", "", 'maxlength="80"')}${field("phone", "شمارهٔ مجاز مخاطب", "", "tel", "فقط اطلاعاتی را ارسال کنید که مجوز اشتراک‌گذاری آن را دارید.", 'required dir="ltr"')}`;
  }
  editMessage(id) {
    const m = this.s.messages.find((x) => x.id === id),
      b = this.s.bots.find((x) => x.id === m?.botId);
    if (!m || !b) return;
    openModal(
      "ویرایش پیام",
      formBody(
        textarea("text", "متن جدید", m.text, "", 'required maxlength="4096"'),
        "ذخیره در روبیکا",
      ),
      async (data) => {
        if (
          !this.s.chats.some(
            (c) => c.botId === b.id && c.chatId === m.chatId && c.consent,
          )
        )
          throw new Error("مجوز مقصد لغو شده است.");
        await this.app.api.call(b.token, "editMessageText", {
          chat_id: m.chatId,
          message_id: m.messageId,
          text: data.get("text"),
        });
        m.text = data.get("text");
        await this.commit("ویرایش پیام", m.messageId);
        closeModal();
        toast("ویرایش توسط API تأیید شد.");
      },
    );
  }
  deleteMessage(id) {
    const m = this.s.messages.find((x) => x.id === id),
      b = this.s.bots.find((x) => x.id === m?.botId);
    if (!m || !b) return;
    confirmModal(
      "حذف پیام از روبیکا",
      "این اقدام پیام را در صورت داشتن مجوز از گفتگوی روبیکا حذف می‌کند.",
      async () => {
        if (
          !this.s.chats.some(
            (c) => c.botId === b.id && c.chatId === m.chatId && c.consent,
          )
        )
          throw new Error("مجوز مقصد لغو شده است.");
        await this.app.api.call(b.token, "deleteMessage", {
          chat_id: m.chatId,
          message_id: m.messageId,
        });
        m.status = "deleted";
        await this.commit("حذف پیام", m.messageId);
        toast("API حذف پیام را تأیید کرد.");
      },
      "حذف پیام",
    );
  }
  forwardMessage(id) {
    const m = this.s.messages.find((x) => x.id === id),
      b = this.s.bots.find((x) => x.id === m?.botId);
    if (!m || !b) return;
    openModal(
      "فوروارد پیام",
      formBody(
        select(
          "destination",
          "مقصد مجاز",
          this.s.chats
            .filter((c) => c.botId === b.id && c.consent)
            .map((c) => [c.id, c.name]),
        ),
        "فوروارد",
      ),
      async (data) => {
        const c = this.s.chats.find(
          (x) => x.id === data.get("destination") && x.consent,
        );
        if (
          !c ||
          !this.s.chats.some(
            (c) => c.botId === b.id && c.chatId === m.chatId && c.consent,
          )
        )
          throw new Error("مجوز مبدأ یا مقصد موجود نیست.");
        const result = await this.app.api.call(b.token, "forwardMessage", {
          from_chat_id: m.chatId,
          message_id: m.messageId,
          to_chat_id: c.chatId,
        });
        if (!result.new_message_id)
          throw new Error("API شناسهٔ پیام فورواردشده را برنگرداند.");
        this.s.messages.push({
          id: uid(),
          botId: b.id,
          chatId: c.chatId,
          messageId: result.new_message_id,
          text: m.text,
          direction: "out",
          status: "sent",
          type: "فوروارد",
          at: new Date().toISOString(),
        });
        await this.commit("فوروارد پیام", c.name);
        closeModal();
        toast("پیام فوروارد شد.");
      },
    );
  }
  ruleForm(id) {
    if (!this.requireBot()) return;
    const r = this.s.rules.find((x) => x.id === id);
    openModal(
      r ? "ویرایش قانون" : "قانون پاسخ خودکار",
      formBody(
        `${field("name", "نام قانون", r?.name || "", "text", "", 'required maxlength="80"')}${select("botId", "ربات", botOptions(this.s), r?.botId)}${select("chatId", "محدودهٔ پاسخ", [["", "همهٔ گفتگوهای مجاز این بات"], ...this.s.chats.map((c) => [c.botId + "::" + c.chatId, c.name])], r?.chatId ? r.botId + "::" + r.chatId : "")}${select(
          "type",
          "نوع محرک",
          [
            ["keyword", "شامل کلمهٔ کلیدی"],
            ["exact", "تطبیق کامل"],
            ["regex", "الگوی امن"],
            ["command", "دستور سفارشی"],
            ["faq", "پرسش پرتکرار"],
            ["flow", "فرم چندمرحله‌ای"],
          ],
          r?.type || "keyword",
        )}${field("trigger", "محرک", r?.trigger || "", "text", "", 'required maxlength="160"')}${textarea("response", "پاسخ / پیام پایانی فرم", r?.response || "", "متغیرهای {{name}}، {{user_id}}، {{chat}} و {{date}} قابل استفاده‌اند.", 'required maxlength="4096"')}${textarea("steps", "سؤال‌های فرم چندمرحله‌ای", (r?.steps || []).join("\n"), "برای نوع «فرم چندمرحله‌ای»، هر خط یک سؤال. نشست ۳۰ دقیقه معتبر می‌ماند.")}<div class="form-grid">${field("hoursStart", "شروع ساعت پاسخگویی تهران", r?.hours?.start || "", "time")}${field("hoursEnd", "پایان ساعت پاسخگویی", r?.hours?.end || "", "time")}</div>${check("enabled", "قانون فعال باشد.", r?.enabled ?? true)}`,
        "ذخیرهٔ قانون",
      ),
      async (data) => {
        const value = {
          id: r?.id || uid(),
          name: data.get("name").trim(),
          botId: data.get("botId"),
          chatId: "",
          type: data.get("type"),
          trigger: data.get("trigger").trim(),
          response: data.get("response").trim(),
          steps: splitLines(data.get("steps")),
          hours: { start: data.get("hoursStart"), end: data.get("hoursEnd") },
          enabled: data.has("enabled"),
          hits: r?.hits || 0,
        };
        if (!value.name || !value.trigger || !value.response)
          throw new Error("نام، محرک و پاسخ لازم است.");
        if (data.get("chatId")) {
          const [bid, cid] = data.get("chatId").split("::");
          if (bid !== value.botId)
            throw new Error("مقصد باید متعلق به بات انتخاب‌شده باشد.");
          value.chatId = cid;
        }
        if (value.type === "regex") safePattern(value.trigger);
        if (
          value.type === "flow" &&
          (!value.steps.length || value.steps.length > 10)
        )
          throw new Error("فرم باید ۱ تا ۱۰ سؤال داشته باشد.");
        if (r) Object.assign(r, value);
        else this.s.rules.push(value);
        await this.commit("ذخیرهٔ قانون خودکار", value.name);
        closeModal();
        toast("قانون ذخیره شد.");
      },
    );
  }
  testRule(id) {
    const r = this.s.rules.find((x) => x.id === id);
    if (!r) return;
    openModal(
      "آزمایش محلی قانون",
      formBody(
        `${textarea("text", "متن آزمایشی", "", "این آزمایش هیچ پیامی به روبیکا نمی‌فرستد.", "required")}<div id="test-result"></div>`,
        "بررسی تطبیق",
      ),
      async (data) => {
        document.querySelector("#test-result").innerHTML = notice(
          ruleMatches(r, data.get("text"))
            ? "این متن در وضعیت فعال و ساعت تعریف‌شده با قانون مطابقت دارد."
            : "این متن با قانون مطابقت ندارد یا قانون اکنون فعال نیست.",
          ruleMatches(r, data.get("text")) ? "success" : "warning",
        );
      },
    );
  }
  templateForm(id) {
    const t = this.s.templates.find((x) => x.id === id);
    openModal(
      t ? "ویرایش قالب" : "ساخت قالب و کیبورد",
      formBody(
        `${field("name", "نام قالب", t?.name || "", "text", "", 'required maxlength="80"')}${textarea("text", "متن قالب", t?.text || "", "متغیرها: {{name}}، {{chat}}، {{date}}، {{user_id}}", 'required maxlength="4096"')}${select(
          "keypadType",
          "نوع کیبورد",
          [
            ["inline", "شیشه‌ای (Inline)"],
            ["normal", "معمولی (Chat)"],
          ],
          t?.keypadType || "inline",
        )}${textarea("buttons", "ردیف‌های دکمه", t?.buttons || "", "هر خط یک ردیف؛ دکمه‌ها با | جدا شوند. نمونه: help:راهنما | contact:تماس")}${btn("نمایش کیبورد", "preview-keypad", "eye", "small")}<div id="keypad-preview"></div>`,
        "ذخیرهٔ قالب",
      ),
      async (data) => {
        const value = {
          id: t?.id || uid(),
          name: data.get("name").trim(),
          text: data.get("text").trim(),
          keypadType: data.get("keypadType"),
          buttons: data.get("buttons"),
          keypad: parseKeypadText(data.get("buttons")),
        };
        if (!value.name || !value.text) throw new Error("نام و متن لازم است.");
        if (t) Object.assign(t, value);
        else this.s.templates.push(value);
        await this.commit("ذخیرهٔ قالب", value.name);
        closeModal();
        toast("قالب ذخیره شد.");
      },
    );
  }
  postForm(id) {
    if (!this.requireBot()) return;
    const p = this.s.posts.find((x) => x.id === id);
    const chats = this.s.chats.filter((c) => c.consent && c.type !== "User");
    if (!chats.length) {
      toast("ابتدا یک کانال یا گروه مجاز اضافه کنید.", "warning");
      return;
    }
    openModal(
      p ? "ویرایش پیش‌نویس" : "پست جدید",
      formBody(
        `${field("title", "عنوان داخلی", p?.title || "", "text", "", 'required maxlength="100"')}${select("botId", "ربات ناشر", botOptions(this.s), p?.botId)}${textarea("text", "متن پست", p?.text || "", "", 'required maxlength="4096"')}<div class="field"><label>مقصدهای مجاز این بات</label>${chats.map((c) => check("destination", esc(c.name) + ' <span class="muted">· ' + esc(this.s.bots.find((b) => b.id === c.botId)?.name) + "</span>", p?.chatIds.includes(c.chatId) && p.botId === c.botId).replace('name="destination"', `name="destinations" value="${esc(c.id)}"`)).join("")}</div>${field("category", "دسته‌بندی", p?.category || "", "text", "", 'maxlength="60"')}${field("repeatHours", "تکرار پس از انتشار موفق (ساعت)", p?.repeatHours || 0, "number", "صفر یعنی بدون تکرار؛ تکرار فقط در صفحهٔ باز و مقصدهای مجاز انجام می‌شود.", 'min="0" max="8760"')}${check("allowDuplicate", "این محتوا تکراری است و انتشار دوبارهٔ آن را آگاهانه می‌خواهم.", false)}${notice("پست ابتدا پیش‌نویس می‌شود؛ پس از پیش‌نمایش و تأیید مدیر وارد صف خواهد شد.")}`,
        "ذخیرهٔ پیش‌نویس",
      ),
      async (data) => {
        const botId = data.get("botId"),
          chatIds = data.getAll("destinations").map((id) => {
            const c = this.s.chats.find((c) => c.id === id && c.consent);
            if (!c || c.botId !== botId)
              throw new Error(
                "تمام مقصدها باید متعلق به بات انتخاب‌شده باشند.",
              );
            return c.chatId;
          });
        if (!chatIds.length) throw new Error("دست‌کم یک مقصد انتخاب کنید.");
        const text = data.get("text").trim(),
          title = data.get("title").trim();
        if (!text || !title) throw new Error("عنوان و متن لازم است.");
        if (
          !data.has("allowDuplicate") &&
          this.s.posts.some(
            (x) =>
              x.id !== id &&
              x.botId === botId &&
              x.text === text &&
              x.chatIds.some((c) => chatIds.includes(c)) &&
              x.status !== "cancelled",
          )
        )
          throw new Error(
            "محتوای یکسان برای این مقصد در آرشیو یا صف موجود است. برای تکرار آگاهانه، گزینهٔ مربوط را انتخاب کنید.",
          );
        const value = {
          id: p?.id || uid(),
          botId,
          chatIds,
          title,
          text,
          category: data.get("category").trim(),
          repeatHours: Number(data.get("repeatHours")),
          status: "draft",
          deliveries: {},
          createdAt: p?.createdAt || new Date().toISOString(),
        };
        if (p) Object.assign(p, value);
        else this.s.posts.unshift(value);
        await this.commit("ذخیرهٔ پیش‌نویس", title);
        closeModal();
        toast("پیش‌نویس آمادهٔ بازبینی است.");
      },
    );
  }
  previewPost(id) {
    const p = this.s.posts.find((x) => x.id === id);
    if (!p) return;
    openModal(
      "پیش‌نمایش " + p.title,
      `<div class="preview">${esc(p.text)}</div><p class="hint">${esc(p.chatIds.map((id) => this.s.chats.find((c) => c.chatId === id && c.botId === p.botId)?.name || id).join("، "))}</p><p class="hint">${p.scheduledAt ? date(p.scheduledAt) : "هنوز زمان‌بندی نشده"}</p>${Object.entries(
        p.deliveries || {},
      )
        .map(
          ([id, d]) =>
            `<p class="hint">${esc(id)}: ${esc(d.status)} ${esc(d.error || "")}</p>`,
        )
        .join(
          "",
        )}<div class="form-actions">${btn("بستن", "close-modal")}${["draft", "pending", "missed"].includes(p.status) ? btn("تأیید و زمان‌بندی", "approve-post", "calendar", "primary", `data-id="${esc(p.id)}"`) : ""}</div>`,
    );
  }
  approvePost(id) {
    const p = this.s.posts.find((x) => x.id === id);
    if (!p || !["draft", "pending", "missed"].includes(p.status)) return;
    openModal(
      "تأیید و زمان‌بندی پست",
      formBody(
        `<div class="preview">${esc(p.text)}</div>${field("scheduledAt", "تاریخ میلادی و ساعت به وقت تهران", "", "datetime-local", "پس از انتخاب، تاریخ شمسی در فهرست نمایش داده می‌شود.", "required")}${check("approved", "متن و مقصدها را بازبینی کرده‌ام و انتشار را تأیید می‌کنم.", false)}${notice("این تأیید در مخزن شخصی ثبت می‌شود؛ تأیید چندمدیری با نقش‌های مستقل به سرور نیاز دارد.", "warning")}`,
        "تأیید و افزودن به صف",
      ),
      async (data) => {
        if (!data.has("approved"))
          throw new Error("بازبینی و تأیید انتشار لازم است.");
        const scheduledAt = localInputISO(data.get("scheduledAt"));
        if (new Date(scheduledAt) <= new Date())
          throw new Error("زمان آینده انتخاب کنید.");
        if (
          !p.chatIds.every((id) =>
            this.s.chats.some(
              (c) => c.chatId === id && c.botId === p.botId && c.consent,
            ),
          )
        )
          throw new Error("مجوز یکی از مقصدها موجود نیست.");
        p.status = "scheduled";
        p.scheduledAt = scheduledAt;
        p.approvedAt = new Date().toISOString();
        p.deliveries = {};
        await this.commit("تأیید زمان‌بندی", p.title);
        closeModal();
        toast("پست وارد صف شد؛ برای ارسال، پردازش باید فعال باشد.");
      },
    );
  }
  retryPost(id) {
    const p = this.s.posts.find((x) => x.id === id);
    if (!p) return;
    openModal(
      "بازبینی ارسال ناموفق",
      formBody(
        `${notice("اگر ارتباط هنگام ارسال قطع شده باشد، ممکن است پیام به مقصد رسیده باشد. ابتدا مقصدهای نامشخص را در روبیکا بررسی کنید. مقصدهای موفق دوباره ارسال نمی‌شوند.", "warning")}${Object.entries(
          p.deliveries || {},
        )
          .map(([id, d]) => `<p class="hint">${esc(id)}: ${esc(d.status)}</p>`)
          .join(
            "",
          )}${check("checked", "مقصدهای نامشخص را بررسی کرده‌ام و مسئولیت ارسال دوباره را می‌پذیرم.", false)}${field("scheduledAt", "زمان بررسی و ارسال دوباره به وقت تهران", "", "datetime-local", "", "required")}`,
        "ثبت زمان جدید",
      ),
      async (data) => {
        if (!data.has("checked")) throw new Error("بررسی مقصدها لازم است.");
        const at = localInputISO(data.get("scheduledAt"));
        if (new Date(at) <= new Date())
          throw new Error("زمان آینده انتخاب کنید.");
        p.scheduledAt = at;
        p.status = "scheduled";
        await this.commit("زمان‌بندی دوباره پس از بازبینی", p.title);
        closeModal();
        toast("فقط مقصدهای ناموفق یا تأییدنشده دوباره بررسی می‌شوند.");
      },
    );
  }
  addTicket() {
    if (!this.requireBot() || !chatOptions(this.s).length) {
      toast("ابتدا یک بات و مقصد مجاز ثبت کنید.", "warning");
      return;
    }
    openModal(
      "ثبت تیکت پشتیبانی",
      formBody(
        `${select("destination", "گفتگوی مجاز", chatOptions(this.s))}${field("subject", "موضوع", "", "text", "", 'required maxlength="150"')}${textarea("text", "شرح درخواست", "", "", 'required maxlength="4000"')}${field("assignee", "مسئول پیگیری (برچسب داخلی)", "", "text", "", 'maxlength="80"')}`,
        "ثبت تیکت",
      ),
      async (data) => {
        const chat = this.s.chats.find(
          (c) => c.id === data.get("destination") && c.consent,
        );
        if (!chat) throw new Error("مجوز مقصد موجود نیست.");
        this.s.tickets.unshift({
          id: uid(),
          botId: chat.botId,
          chatId: chat.chatId,
          subject: data.get("subject").trim(),
          assignee: data.get("assignee").trim(),
          status: "open",
          history: [
            {
              at: new Date().toISOString(),
              text: data.get("text").trim(),
              by: "مدیر",
            },
          ],
          createdAt: new Date().toISOString(),
        });
        await this.commit("ثبت تیکت", data.get("subject"));
        closeModal();
        toast("تیکت ثبت شد؛ پیامی ارسال نشد.");
      },
    );
  }
  openTicket(id) {
    const t = this.s.tickets.find((x) => x.id === id);
    if (!t) return;
    openModal(
      t.subject,
      formBody(
        `<div class="ticket-history">${t.history.map((h) => `<div class="ticket-message">${esc(h.text)}<small>${esc(h.by)} · ${date(h.at)} ${h.sent ? "· ارسال‌شده" : ""}</small></div>`).join("")}</div>${select(
          "status",
          "وضعیت",
          [
            ["open", "باز"],
            ["pending", "در انتظار"],
            ["closed", "بسته‌شده"],
          ],
          t.status,
        )}${field("assignee", "مسئول پیگیری", t.assignee || "", "text", "", 'maxlength="80"')}${select("canned", "پاسخ آماده", [["", "انتخاب پاسخ آماده"], ...this.s.templates.map((t) => [t.id, t.name])])}${textarea("reply", "پاسخ یا یادداشت", "", "", 'maxlength="4096"')}${check("send", "پاسخ به گفتگوی روبیکا هم ارسال شود.", false)}`,
        "ذخیره / ارسال پاسخ",
      ),
      async (data) => {
        const text = data.get("reply").trim();
        if (data.has("send") && !text) throw new Error("متن پاسخ لازم است.");
        if (data.has("send")) {
          const b = this.s.bots.find((x) => x.id === t.botId && x.enabled),
            c = this.s.chats.find(
              (x) => x.botId === t.botId && x.chatId === t.chatId && x.consent,
            );
          if (!b || !c) throw new Error("بات یا مقصد مجاز فعال نیست.");
          const result = await this.app.api.call(b.token, "sendMessage", {
            chat_id: t.chatId,
            text,
          });
          if (!result.message_id)
            throw new Error("API شناسهٔ پیام را برنگرداند.");
          this.s.messages.push({
            id: uid(),
            botId: b.id,
            chatId: c.chatId,
            messageId: result.message_id,
            text,
            direction: "out",
            type: "پاسخ پشتیبانی",
            status: "sent",
            at: new Date().toISOString(),
          });
        }
        if (text)
          t.history.push({
            text,
            at: new Date().toISOString(),
            by: "مدیر",
            sent: data.has("send"),
          });
        t.status = data.get("status");
        t.assignee = data.get("assignee").trim();
        await this.commit("به‌روزرسانی تیکت", t.subject);
        closeModal();
        toast(
          data.has("send")
            ? "پاسخ با تأیید API ارسال شد."
            : "تیکت به‌روزرسانی شد.",
        );
      },
    );
  }
  manageUser(id) {
    const u = this.s.users.find((x) => x.id === id);
    if (!u) return;
    const chats = this.s.chats.filter(
      (c) => c.botId === u.botId && c.consent && c.type !== "User",
    );
    openModal(
      "اقدام مدیریتی کاربر",
      formBody(
        `${notice("مسدودسازی و رفع مسدودی تنها با مجوز واقعی بات در گروه یا کانال انجام می‌شود. نتیجهٔ موفق باید از API دریافت شود.", "warning")}<p class="mono" dir="ltr">${esc(u.userId)}</p>${select(
          "chat",
          "گروه / کانال",
          chats.map((c) => [c.id, c.name]),
        )}${select("operation", "عملیات", [
          ["banChatMember", "مسدودسازی"],
          ["unbanChatMember", "رفع مسدودی"],
        ])}${check("confirmed", "شناسه، مقصد و مجوز را بررسی کرده‌ام و این اقدام را تأیید می‌کنم.", false)}`,
        "انجام اقدام مدیریتی",
        true,
      ),
      async (data) => {
        if (!data.has("confirmed")) throw new Error("تأیید اقدام لازم است.");
        const c = this.s.chats.find(
            (x) => x.id === data.get("chat") && x.consent,
          ),
          b = this.s.bots.find((x) => x.id === u.botId && x.enabled);
        if (!c || !b) throw new Error("بات یا مقصد در دسترس نیست.");
        if (c.adminIds?.includes(u.userId))
          throw new Error("این کاربر در فهرست مدیران مستثنا است.");
        await this.app.api.call(b.token, data.get("operation"), {
          chat_id: c.chatId,
          user_id: u.userId,
        });
        await this.commit(
          data.get("operation") === "banChatMember"
            ? "مسدودسازی کاربر"
            : "رفع مسدودی کاربر",
          u.userId + " · " + c.name,
        );
        closeModal();
        toast("API اقدام را تأیید کرد.");
      },
    );
  }
  reviewViolation(id) {
    const v = this.s.violations.find((x) => x.id === id);
    if (!v) return;
    openModal(
      "بازبینی تخلف",
      formBody(
        `<p>${esc(v.reasons.join("، "))}</p>${textarea("review", "نتیجهٔ بررسی مدیر", v.review || "", "", 'required maxlength="2000"')}`,
        "ثبت بازبینی",
      ),
      async (data) => {
        v.review = data.get("review").trim();
        v.reviewedAt = new Date().toISOString();
        await this.commit("بازبینی تخلف", v.userId);
        closeModal();
        toast("نتیجهٔ بازبینی ذخیره شد.");
      },
    );
  }
  async backup() {
    const envelope = await this.app.vault.backup();
    download(
      "rubika-control-pro-encrypted-backup.json",
      JSON.stringify(envelope, null, 2),
    );
    toast("پشتیبان رمزگذاری‌شده آماده شد.");
  }
  restore() {
    openModal(
      "بازیابی مخزن رمزگذاری‌شده",
      formBody(
        `${notice("بازیابی، داده‌های فعلی این مرورگر را جایگزین می‌کند. ابتدا از مخزن فعلی پشتیبان بگیرید. رمز فایل پشتیبان لازم است.", "warning")}${field("backup", "فایل پشتیبان", "", "file", "", 'required accept="application/json,.json"')}${field("password", "رمز مخزن فایل پشتیبان", "", "password", "", 'required autocomplete="off"')}${check("replace", "جایگزینی مخزن فعلی را تأیید می‌کنم.", false)}`,
        "بازیابی مخزن",
        true,
      ),
      async (data) => {
        if (!data.has("replace")) throw new Error("تأیید جایگزینی لازم است.");
        const file = data.get("backup");
        if (!file?.size || file.size > 128 * 1024 * 1024)
          throw new Error("فایل معتبر تا سقف ۱۲۸ مگابایت انتخاب کنید.");
        if (!(await this.app.claimSession()))
          throw new Error(
            "مخزن در زبانهٔ دیگری باز است. ابتدا آن را قفل کنید.",
          );
        await this.app.stopRuntime();
        await this.app.vault.restore(await file.text(), data.get("password"));
        await this.app.afterUnlock();
        closeModal();
        toast("مخزن از پشتیبان رمزگذاری‌شده بازیابی شد.");
      },
    );
  }
  changePassword() {
    openModal(
      "تغییر رمز مخزن",
      formBody(
        `${field("old", "رمز فعلی", "", "password", "", 'required autocomplete="current-password"')}${field("new", "رمز جدید", "", "password", "", 'required minlength="12" autocomplete="new-password"')}${field("confirm", "تکرار رمز جدید", "", "password", "", 'required minlength="12" autocomplete="new-password"')}${notice("فایل‌های پشتیبان قبلی همچنان با رمز قبلی باز می‌شوند. پس از تغییر رمز، پشتیبان تازه بگیرید.", "warning")}`,
        "تغییر رمز",
      ),
      async (data) => {
        if (data.get("new") !== data.get("confirm"))
          throw new Error("تکرار رمز مطابقت ندارد.");
        await this.app.vault.changePassword(data.get("old"), data.get("new"));
        await this.commit("تغییر رمز مخزن");
        closeModal();
        toast("رمز مخزن تغییر کرد. پشتیبان تازه بگیرید.");
      },
    );
  }
  exportReport(format) {
    const within = (x) =>
      (!this.app.ctx.from ||
        new Date(x.at) >= new Date(this.app.ctx.from + "T00:00:00+03:30")) &&
      (!this.app.ctx.to ||
        new Date(x.at) <= new Date(this.app.ctx.to + "T23:59:59+03:30"));
    const rows = this.s.events
      .filter(within)
      .map((e) => ({
        time: e.at,
        bot: this.s.bots.find((b) => b.id === e.botId)?.name || "",
        chat: e.chatId,
        type: e.type,
      }));
    download(
      "rubika-report." + format,
      format === "csv"
        ? csv(rows)
        : JSON.stringify(
            {
              generatedAt: new Date().toISOString(),
              timeZone: "Asia/Tehran",
              from: this.app.ctx.from || null,
              to: this.app.ctx.to || null,
              records: rows,
            },
            null,
            2,
          ),
      format === "csv" ? "text/csv;charset=utf-8" : "application/json",
    );
    toast("گزارش آماده شد.");
  }
  async settings(data) {
    const transport = data.get("transport"),
      relayUrl = data.get("relayUrl").trim();
    if (transport === "relay") {
      let url;
      try {
        url = new URL(relayUrl);
      } catch {
        throw new Error("نشانی واسط معتبر نیست.");
      }
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !data.get("relayKey").trim()
      )
        throw new Error(
          "واسط به نشانی HTTPS بدون پارامتر و کلید دسترسی نیاز دارد.",
        );
      if (!data.has("relayConsent"))
        throw new Error("مالکیت و اجازهٔ ارسال توکن به واسط را تأیید کنید.");
    }
    Object.assign(this.s.settings, {
      panelName: data.get("panelName").trim(),
      idleMinutes: Number(data.get("idleMinutes")),
      transport,
      relayUrl,
      relayKey: data.get("relayKey").trim(),
      autoResume: data.has("autoResume"),
    });
    await this.commit("تغییر تنظیمات فضای کار");
    toast("تنظیمات ذخیره شد.");
  }
}
