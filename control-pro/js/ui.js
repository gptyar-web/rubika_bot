import { esc } from "./utils.js";
import { icon } from "./icons.js";
export const btn = (label, action, ico = "", kind = "", extra = "") =>
  `<button class="btn ${kind}" type="button" data-action="${action}" ${extra}>${ico ? icon(ico) : ""}${label}</button>`;
export const pill = (text, kind = "") =>
  `<span class="pill ${kind}">${esc(text)}</span>`;
export const empty = (title, description, ico = "message", action = "") =>
  `<div class="empty"><div class="empty-symbol">${icon(ico)}</div><h3>${esc(title)}</h3><p>${esc(description)}</p>${action}</div>`;
export const notice = (text, kind = "info") =>
  `<div class="notice ${kind}">${icon(kind === "warning" ? "warning" : kind === "success" ? "shield" : "info")}<p>${text}</p></div>`;
export const field = (
  name,
  label,
  value = "",
  type = "text",
  help = "",
  extra = "",
) =>
  `<div class="field"><label for="f-${name}">${label}</label><input id="f-${name}" name="${name}" type="${type}" value="${esc(value)}" ${extra}>${help ? `<small>${help}</small>` : ""}</div>`;
export const textarea = (name, label, value = "", help = "", extra = "") =>
  `<div class="field"><label for="f-${name}">${label}</label><textarea id="f-${name}" name="${name}" ${extra}>${esc(value)}</textarea>${help ? `<small>${help}</small>` : ""}</div>`;
export const select = (name, label, options, value = "", help = "") =>
  `<div class="field"><label for="f-${name}">${label}</label><select id="f-${name}" name="${name}">${options.map(([v, l]) => `<option value="${esc(v)}" ${String(v) === String(value) ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>${help ? `<small>${help}</small>` : ""}</div>`;
export const check = (name, label, value = false) =>
  `<label class="check"><input name="${name}" type="checkbox" ${value ? "checked" : ""}> <span>${label}</span></label>`;
export const toggle = (label, action, on, extra = "") =>
  `<button class="toggle" role="switch" aria-label="${esc(label)}" aria-checked="${Boolean(on)}" data-action="${action}" ${extra}></button>`;
export const pageHead = (
  title,
  description,
  action = "",
  eyebrow = "فضای کار شما",
) =>
  `<div class="page-header"><div><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${description}</p></div>${action}</div>`;
export const table = (headers, rows, classes = "") =>
  `<div class="table-wrap"><table class="${classes}"><thead><tr>${headers.map((x) => `<th scope="col">${x}</th>`).join("")}</tr></thead><tbody>${rows.map((cells) => `<tr>${cells.map((x) => `<td>${x}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`;
export function toast(message, kind = "success") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = message;
  document.querySelector("#toasts").append(el);
  setTimeout(() => el.remove(), kind === "error" ? 10000 : 5000);
}
let previousFocus;
export function openModal(title, body, onSubmit) {
  const modal = document.querySelector("#modal");
  previousFocus = document.activeElement;
  modal.innerHTML = `<div class="modal-head"><h2 id="modal-title">${esc(title)}</h2><button class="icon-btn" type="button" data-action="close-modal" aria-label="بستن">${icon("close")}</button></div><div class="modal-body">${body}</div>`;
  const form = modal.querySelector("form");
  if (form)
    form.onsubmit = async (e) => {
      e.preventDefault();
      const submit = form.querySelector("[type=submit]");
      if (submit.disabled) return;
      const error = form.querySelector(".form-error");
      if (error) error.textContent = "";
      submit.disabled = true;
      const original = submit.textContent;
      submit.textContent = "در حال انجام…";
      try {
        await onSubmit(new FormData(form), form);
      } catch (e) {
        if (error) error.textContent = e.message;
        else toast(e.message, "error");
      } finally {
        if (submit.isConnected) {
          submit.disabled = false;
          submit.textContent = original;
        }
      }
    };
  if (!modal.open) modal.showModal();
  const focus = modal.querySelector(
    "input:not([type=checkbox]),select,textarea,button",
  );
  focus?.focus();
}
export function closeModal() {
  const modal = document.querySelector("#modal");
  modal.close();
  modal.innerHTML = "";
  previousFocus?.focus();
}
export function formBody(content, submit = "ذخیره", danger = false) {
  return `<form>${content}<div class="form-error" role="alert"></div><div class="form-actions">${btn("انصراف", "close-modal")}<button class="btn ${danger ? "danger" : "primary"}" type="submit">${submit}</button></div></form>`;
}
export function confirmModal(
  title,
  description,
  action,
  label = "تأیید و ادامه",
) {
  openModal(title, formBody(`<p>${description}</p>`, label, true), async () => {
    await action();
    closeModal();
  });
}
