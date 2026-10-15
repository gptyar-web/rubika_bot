import { uid, audit, renderTemplate } from "./utils.js";
import { violationsFor, ruleMatches } from "./moderation.js";
export function eventKey(botId, update) {
  const m = update.new_message || update.updated_message;
  if (m?.message_id)
    return `${botId}:${update.chat_id}:${update.type || "NewMessage"}:${m.message_id}:${update.type === "UpdatedMessage" ? m.text || "" : ""}`;
  if (update.removed_message_id)
    return `${botId}:${update.chat_id}:removed:${update.removed_message_id}`;
  return null; // Never invent an unstable key for events without a documented ID.
}
export class Runtime {
  constructor({ state, persist, api, changed = () => {} }) {
    Object.assign(this, { state, persist, api, changed });
    this.running = false;
    this.timer = null;
    this.busy = false;
    this.epoch = 0;
    this.nextPoll = new Map();
    this.failures = new Map();
  }
  async start() {
    if (this.running) return;
    this.running = true;
    this.epoch++;
    this.changed();
    this.tick();
  }
  stop() {
    this.running = false;
    this.epoch++;
    clearTimeout(this.timer);
    this.changed();
  }
  async tick() {
    if (!this.running || this.busy) return;
    this.busy = true;
    const epoch = this.epoch;
    try {
      const s = this.state();
      if (!s) {
        this.stop();
        return;
      }
      for (const bot of s.bots.filter((b) => b.enabled)) {
        if (!this.running || epoch !== this.epoch) break;
        if ((this.nextPoll.get(bot.id) || 0) > Date.now()) continue;
        try {
          const started = Date.now();
          const data = await this.api.call(bot.token, "getUpdates", {
            limit: 50,
            ...(bot.offset ? { offset_id: bot.offset } : {}),
          });
          if (!this.running || epoch !== this.epoch || this.state() !== s)
            break;
          if (!Array.isArray(data.updates))
            throw new Error("ساختار رویدادهای API معتبر نیست.");
          for (const update of data.updates) {
            if (!this.running || epoch !== this.epoch) break;
            await this.processUpdate(bot, update);
          }
          if (!this.running || epoch !== this.epoch) break;
          bot.offset = data.next_offset_id || bot.offset;
          bot.lastReceived = new Date().toISOString();
          bot.status = "connected";
          bot.latency = Date.now() - started;
          this.failures.delete(bot.id);
          await this.persist();
        } catch (error) {
          if (!this.state() || this.state() !== s) break;
          bot.status = "error";
          const count = (this.failures.get(bot.id) || 0) + 1;
          this.failures.set(bot.id, count);
          this.nextPoll.set(
            bot.id,
            Date.now() + Math.min(120000, 5000 * 2 ** Math.min(count, 5)),
          );
          if (count === 1)
            audit(s, "خطای اتصال", bot.name + " — " + error.message, "error");
          await this.persist();
        }
      }
      if (this.running && epoch === this.epoch) await this.runQueue();
    } catch (error) {
      if (this.state()) {
        audit(this.state(), "توقف پردازش", error.message, "error");
        this.stop();
      }
    } finally {
      this.busy = false;
      this.changed();
      if (this.running) this.timer = setTimeout(() => this.tick(), 5000);
    }
  }
  async processUpdate(bot, update) {
    const s = this.state(),
      key = eventKey(bot.id, update);
    if (!s || !key || s.seen.includes(key)) return;
    const chat = s.chats.find(
      (c) => c.botId === bot.id && c.chatId === update.chat_id && c.consent,
    );
    if (!chat) return;
    const m = update.new_message;
    // Reserve the event durably before any outgoing effect. Failed effects are recorded, never blindly replayed.
    s.seen.push(key);
    s.seen = s.seen.slice(-10000);
    await this.persist();
    if (
      !this.running ||
      this.state() !== s ||
      !m?.message_id ||
      m.sender_type === "Bot" ||
      !m.sender_id
    )
      return;
    const at = new Date().toISOString();
    const existing = s.users.find(
      (u) => u.botId === bot.id && u.userId === m.sender_id,
    );
    if (existing) {
      existing.lastSeen = at;
      existing.messages++;
    } else if (m.sender_id)
      s.users.push({
        id: uid(),
        botId: bot.id,
        userId: m.sender_id,
        lastSeen: at,
        messages: 1,
        subscribed: false,
      });
    const user = m.sender_id
      ? existing ||
        s.users.find((u) => u.botId === bot.id && u.userId === m.sender_id)
      : null;
    if (m.text === "/subscribe" && user) user.subscribed = true;
    if (m.text === "/unsubscribe" && user) user.subscribed = false;
    const type = m.file
      ? "فایل"
      : m.location
        ? "موقعیت"
        : m.poll
          ? "نظرسنجی"
          : m.sticker
            ? "استیکر"
            : m.contact_message
              ? "مخاطب"
              : "متن";
    const rec = {
      id: uid(),
      botId: bot.id,
      chatId: chat.chatId,
      messageId: m.message_id,
      userId: m.sender_id || "",
      text: (m.text || "").slice(0, 4096),
      at,
      type,
      direction: "in",
      status: "received",
    };
    const reasons = violationsFor(m, chat, s.messages, new Date(at));
    s.messages.push(rec);
    s.messages = s.messages.slice(-5000);
    s.events.push({ at, botId: bot.id, chatId: chat.chatId, type });
    s.events = s.events.slice(-10000);
    if (m.aux_data?.button_id) {
      const k = bot.id + ":" + m.aux_data.button_id;
      s.clicks[k] = (s.clicks[k] || 0) + 1;
    }
    try {
      if (reasons.length) {
        const violation = {
          id: uid(),
          botId: bot.id,
          chatId: chat.chatId,
          userId: m.sender_id,
          messageId: m.message_id,
          reasons,
          at,
          action: chat.action || "log",
          status: "recorded",
          review: "",
        };
        s.violations.unshift(violation);
        s.violations = s.violations.slice(0, 2000);
        await this.persist();
        if (chat.action === "delete") {
          await this.api.call(bot.token, "deleteMessage", {
            chat_id: chat.chatId,
            message_id: m.message_id,
          });
          violation.status = "deleted";
        }
        if (chat.action === "warn") {
          const count = s.violations.filter(
            (v) =>
              v.botId === bot.id &&
              v.chatId === chat.chatId &&
              v.userId === m.sender_id,
          ).length;
          await this.send(
            bot,
            chat,
            `اخطار ${count}: ${reasons.join("، ")}\n${chat.rules || ""}`,
            m.message_id,
          );
          violation.status = "warned";
        }
        audit(s, "ثبت تخلف", `${chat.name}: ${reasons.join("، ")}`, "warning");
        await this.persist();
        return;
      }
      if (m.text?.startsWith("/ticket ")) {
        const ticket = {
          id: uid(),
          botId: bot.id,
          chatId: chat.chatId,
          userId: m.sender_id,
          subject: m.text.slice(8, 150),
          status: "open",
          assignee: "",
          history: [{ at, text: m.text.slice(8), by: "کاربر" }],
          createdAt: at,
        };
        s.tickets.unshift(ticket);
        await this.persist();
        await this.send(
          bot,
          chat,
          `تیکت شما ثبت شد. کد پیگیری: ${ticket.id.slice(0, 8)}`,
          m.message_id,
        );
        return;
      }
      if (m.text === "/rules" && chat.rules) {
        await this.send(bot, chat, chat.rules, m.message_id);
        return;
      }
      if (!m.text) return;
      const sessionKey = bot.id + ":" + chat.chatId + ":" + m.sender_id;
      const session = s.sessions[sessionKey];
      if (session && new Date(session.expires) > new Date()) {
        const rule = s.rules.find((r) => r.id === session.ruleId && r.enabled);
        if (rule?.steps?.length) {
          session.answers.push(m.text.slice(0, 500));
          session.index++;
          await this.persist();
          if (session.index < rule.steps.length)
            await this.send(bot, chat, rule.steps[session.index], m.message_id);
          else {
            delete s.sessions[sessionKey];
            await this.send(
              bot,
              chat,
              renderTemplate(rule.response, {
                name: m.sender_id,
                chat: chat.name,
                user_id: m.sender_id,
              }),
              m.message_id,
            );
            audit(s, "پایان فرم تعاملی", rule.name);
          }
          await this.persist();
          return;
        }
      } else if (session) delete s.sessions[sessionKey];
      const rule = s.rules.find(
        (r) =>
          r.botId === bot.id &&
          (!r.chatId || r.chatId === chat.chatId) &&
          ruleMatches(r, m.text),
      );
      if (rule) {
        rule.hits = (rule.hits || 0) + 1;
        const variables = {
          name: m.sender_id,
          user_id: m.sender_id,
          chat: chat.name,
          date: new Intl.DateTimeFormat("fa-IR", {
            timeZone: "Asia/Tehran",
          }).format(new Date()),
        };
        if (rule.type === "flow" && rule.steps?.length) {
          s.sessions[sessionKey] = {
            ruleId: rule.id,
            index: 0,
            answers: [],
            expires: new Date(Date.now() + 30 * 60000).toISOString(),
          };
          await this.persist();
          await this.send(bot, chat, rule.steps[0], m.message_id);
        } else
          await this.send(
            bot,
            chat,
            renderTemplate(rule.response, variables),
            m.message_id,
          );
      }
    } catch (error) {
      audit(s, "خطای پردازش رویداد", error.message, "error");
      rec.status = "action-error";
    }
    await this.persist();
  }
  async send(bot, chat, text, replyId) {
    if (!chat.consent || !bot.enabled || !this.state())
      throw new Error("بات یا مقصد فعال نیست.");
    const result = await this.api.call(bot.token, "sendMessage", {
      chat_id: chat.chatId,
      text,
      ...(replyId ? { reply_to_message_id: replyId } : {}),
    });
    if (!result.message_id) throw new Error("API شناسهٔ پیام را برنگرداند.");
    const s = this.state();
    if (!s) return result;
    s.messages.push({
      id: uid(),
      botId: bot.id,
      chatId: chat.chatId,
      messageId: result.message_id,
      text,
      direction: "out",
      type: "متن",
      at: new Date().toISOString(),
      status: "sent",
    });
    return result;
  }
  async runQueue() {
    const s = this.state();
    if (!s) return;
    // Stale jobs are never silently published after a long offline period.
    for (const post of s.posts.filter(
      (p) => p.status === "scheduled" && new Date(p.scheduledAt) <= new Date(),
    )) {
      if (!this.running || this.state() !== s) break;
      const bot = s.bots.find((b) => b.id === post.botId && b.enabled);
      if (!bot) continue;
      if (Date.now() - new Date(post.scheduledAt) > 10 * 60000) {
        post.status = "missed";
        audit(s, "زمان انتشار گذشته است", post.title, "warning");
        await this.persist();
        continue;
      }
      post.status = "sending";
      await this.persist();
      for (const chatId of post.chatIds) {
        if (!this.running || this.state() !== s) break;
        if (post.deliveries?.[chatId]?.status === "sent") continue;
        const chat = s.chats.find(
          (c) => c.botId === bot.id && c.chatId === chatId && c.consent,
        );
        post.deliveries ??= {};
        if (!chat) {
          post.deliveries[chatId] = {
            status: "failed",
            error: "مجوز مقصد موجود نیست.",
          };
          await this.persist();
          continue;
        }
        post.deliveries[chatId] = { status: "sending" };
        await this.persist();
        try {
          const result = await this.send(bot, chat, post.text);
          post.deliveries[chatId] = {
            status: "sent",
            messageId: result.message_id,
            at: new Date().toISOString(),
          };
        } catch (error) {
          post.deliveries[chatId] = { status: "unknown", error: error.message };
        }
        await this.persist();
      }
      const delivered = Object.values(post.deliveries || {});
      post.status =
        delivered.length === post.chatIds.length &&
        delivered.every((d) => d.status === "sent")
          ? "sent"
          : "failed";
      post.publishedAt = new Date().toISOString();
      audit(
        s,
        post.status === "sent" ? "انتشار موفق" : "انتشار نیازمند بررسی",
        post.title,
        post.status === "sent" ? "info" : "warning",
      );
      if (post.status === "sent" && post.repeatHours) {
        post.status = "scheduled";
        post.scheduledAt = new Date(
          Date.now() + post.repeatHours * 3600000,
        ).toISOString();
        post.deliveries = {};
      }
      await this.persist();
    }
  }
}
