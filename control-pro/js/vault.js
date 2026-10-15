import { initialState, validateState } from "./utils.js";
const enc = new TextEncoder(),
  dec = new TextDecoder();
export const ITERATIONS = 600000;
const MAX_BACKUP_BYTES = 128 * 1024 * 1024;
const b64 = (bytes) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
export async function deriveKey(password, salt, iterations = ITERATIONS) {
  const material = await crypto.subtle.importKey(
    "raw",
    enc.encode(password),
    "PBKDF2",
    false,
    ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}
export async function seal(state, key, salt, revision = 0) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = enc.encode("rubika-control-pro:v1");
  const data = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad },
    key,
    enc.encode(JSON.stringify(state)),
  );
  return {
    format: "rubika-control-pro",
    version: 1,
    iterations: ITERATIONS,
    salt: b64(salt),
    iv: b64(iv),
    data: b64(new Uint8Array(data)),
    revision,
  };
}
export function validateEnvelope(e) {
  if (
    !e ||
    e.format !== "rubika-control-pro" ||
    e.version !== 1 ||
    e.iterations !== ITERATIONS ||
    typeof e.data !== "string" ||
    e.data.length > MAX_BACKUP_BYTES ||
    typeof e.salt !== "string" ||
    e.salt.length !== 24 ||
    typeof e.iv !== "string" ||
    e.iv.length !== 16 ||
    !Number.isSafeInteger(e.revision) ||
    e.revision < 0
  )
    throw new Error("فایل مخزن معتبر نیست.");
  if (unb64(e.salt).length !== 16 || unb64(e.iv).length !== 12)
    throw new Error("فایل مخزن معتبر نیست.");
  return e;
}
export async function openEnvelope(envelope, password) {
  validateEnvelope(envelope);
  const salt = unb64(envelope.salt),
    key = await deriveKey(password, salt, envelope.iterations);
  try {
    const plain = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: unb64(envelope.iv),
        additionalData: enc.encode("rubika-control-pro:v1"),
      },
      key,
      unb64(envelope.data),
    );
    return { state: validateState(JSON.parse(dec.decode(plain))), key, salt };
  } catch {
    throw new Error("رمز مخزن درست نیست یا فایل آسیب دیده است.");
  }
}
function openDB() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open("rubika-control-pro", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("vault");
    r.onsuccess = () => resolve(r.result);
    r.onerror = () =>
      reject(new Error("مرورگر اجازهٔ ذخیره‌سازی مخزن را نمی‌دهد."));
  });
}
export class Vault {
  constructor() {
    this.key = null;
    this.state = null;
    this.revision = 0;
    this.pending = Promise.resolve();
  }
  async read() {
    const db = await openDB();
    try {
      return await new Promise((resolve, reject) => {
        const r = db.transaction("vault").objectStore("vault").get("main");
        r.onsuccess = () => resolve(r.result);
        r.onerror = () => reject(r.error);
      });
    } finally {
      db.close();
    }
  }
  async write(envelope, expectedRevision = null) {
    const db = await openDB();
    try {
      await new Promise((resolve, reject) => {
        const tx = db.transaction("vault", "readwrite"),
          store = tx.objectStore("vault"),
          r = store.get("main");
        let conflict = false;
        r.onsuccess = () => {
          if (
            expectedRevision !== null &&
            (r.result?.revision ?? -1) !== expectedRevision
          ) {
            conflict = true;
            tx.abort();
            return;
          }
          store.put(envelope, "main");
        };
        tx.oncomplete = () => resolve();
        tx.onabort = () =>
          reject(
            new Error(
              conflict
                ? "مخزن در زبانهٔ دیگری تغییر کرده است؛ برای جلوگیری از تداخل دوباره بازش کنید."
                : "ذخیره‌سازی انجام نشد. فضای مرورگر را بررسی کنید.",
            ),
          );
        tx.onerror = () => reject(new Error("ذخیره‌سازی انجام نشد."));
      });
    } finally {
      db.close();
    }
  }
  async create(password) {
    if (password.length < 12)
      throw new Error("رمز مخزن باید دست‌کم ۱۲ نویسه داشته باشد.");
    if (await this.read()) throw new Error("مخزن موجود است؛ آن را باز کنید.");
    const salt = crypto.getRandomValues(new Uint8Array(16)),
      key = await deriveKey(password, salt),
      state = initialState();
    await this.write(await seal(state, key, salt, 0), -1);
    Object.assign(this, { salt, key, state, revision: 0 });
    return state;
  }
  async unlock(password) {
    const e = await this.read();
    if (!e) throw new Error("مخزنی وجود ندارد.");
    Object.assign(this, await openEnvelope(e, password));
    this.revision = e.revision;
    return this.state;
  }
  save() {
    const task = async () => {
      if (!this.key || !this.state) throw new Error("مخزن قفل است.");
      const e = await seal(this.state, this.key, this.salt, this.revision + 1);
      await this.write(e, this.revision);
      this.revision = e.revision;
    };
    const result = this.pending.then(task);
    this.pending = result.catch(() => {});
    return result;
  }
  async backup() {
    await this.pending;
    return this.read();
  }
  async restore(text, password) {
    if (text.length > MAX_BACKUP_BYTES)
      throw new Error("فایل بیش از حد بزرگ است.");
    const e = validateEnvelope(JSON.parse(text));
    const opened = await openEnvelope(e, password);
    const old = await this.read();
    const revision = (old?.revision ?? -1) + 1;
    await this.write({ ...e, revision }, old?.revision ?? -1);
    Object.assign(this, opened, { revision });
    return this.state;
  }
  async changePassword(oldPassword, newPassword) {
    if (newPassword.length < 12)
      throw new Error("رمز جدید باید دست‌کم ۱۲ نویسه داشته باشد.");
    await this.pending;
    await openEnvelope(await this.read(), oldPassword);
    const salt = crypto.getRandomValues(new Uint8Array(16)),
      key = await deriveKey(newPassword, salt),
      e = await seal(this.state, key, salt, this.revision + 1);
    await this.write(e, this.revision);
    Object.assign(this, { salt, key, revision: e.revision });
  }
  async lock() {
    await this.pending;
    this.key = null;
    this.state = null;
    this.salt = null;
  }
}
