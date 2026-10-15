import { fa, esc } from "./utils.js";
const dayKey = (d) =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
export function activityChart(events, days = 7) {
  const series = Array.from({ length: days }, (_, i) => {
    const d = new Date(Date.now() - (days - 1 - i) * 86400000);
    return {
      key: dayKey(d),
      label: new Intl.DateTimeFormat("fa-IR", {
        timeZone: "Asia/Tehran",
        ...(days === 7
          ? { weekday: "short" }
          : { month: "short", day: "numeric" }),
      }).format(d),
      value: 0,
    };
  });
  const counts = new Map();
  for (const event of events) {
    const key = dayKey(new Date(event.at));
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const s of series) s.value = counts.get(s.key) || 0;
  const max = Math.max(4, ...series.map((s) => s.value)),
    w = 560,
    h = 180,
    left = 35,
    bottom = 155,
    top = 15;
  const points = series.map((s, i) => [
    left + (i * (w - left - 10)) / (days - 1),
    bottom - (s.value / max) * (bottom - top),
  ]);
  const line = points.map((p) => p.join(",")).join(" "),
    area = `${left},${bottom} ${line} ${w - 10},${bottom}`;
  return `<svg class="chart" viewBox="0 0 560 190" role="img" aria-label="فعالیت ${fa(days)} روز اخیر؛ مجموع ${fa(series.reduce((a, b) => a + b.value, 0))} پیام"><defs><linearGradient id="activityFill" x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stop-color="#5B5BF7" stop-opacity=".16"/><stop offset="100%" stop-color="#5B5BF7" stop-opacity="0"/></linearGradient></defs>${[
    0, 1, 2, 3, 4,
  ]
    .map((i) => {
      const y = bottom - (i / 4) * (bottom - top);
      return `<path class="chart-grid" d="M${left} ${y}H${w - 10}"/><text x="20" y="${y + 4}" text-anchor="middle">${fa(Math.round((max * i) / 4))}</text>`;
    })
    .join(
      "",
    )}<polygon points="${area}" fill="url(#activityFill)"/><polyline class="chart-line" points="${line}"/>${series.map((s, i) => `${s.value ? `<circle cx="${points[i][0]}" cy="${points[i][1]}" r="3" fill="var(--primary)"><title>${esc(s.label)}: ${fa(s.value)} پیام</title></circle>` : ""}${days === 7 || i % 5 === 0 ? `<text x="${points[i][0]}" y="178" text-anchor="middle">${esc(s.label)}</text>` : ""}`).join("")}</svg><div class="legend"><span><i></i>پیام‌های واقعی دریافت‌شده</span></div>`;
}
export function publishChart(posts) {
  const sent = posts.filter((p) => p.status === "sent").length,
    failed = posts.filter((p) =>
      ["failed", "missed", "interrupted"].includes(p.status),
    ).length,
    pending = posts.length - sent - failed,
    total = posts.length;
  const colors = ["#5b5bf7", "#14b8a6", "#f59e0b"],
    values = [sent, pending, failed];
  let offset = 0;
  return `<div class="donut-wrap"><svg class="donut" viewBox="0 0 140 140" role="img" aria-label="${fa(sent)} منتشرشده، ${fa(pending)} در انتظار و ${fa(failed)} نیازمند بررسی"><circle cx="70" cy="70" r="53" fill="none" stroke="var(--surface-alt)" stroke-width="13"/>${values
    .map((value, i) => {
      const dash = total ? (value / total) * 333 : 0,
        part = `<circle cx="70" cy="70" r="53" fill="none" stroke="${colors[i]}" stroke-width="13" stroke-dasharray="${dash} 333" stroke-dashoffset="${-offset}" transform="rotate(-90 70 70)"/>`;
      offset += dash;
      return part;
    })
    .join(
      "",
    )}<text class="donut-total" x="70" y="69">${fa(total)}</text><text class="donut-label" x="70" y="90">کل پست‌ها</text></svg></div><div class="publish-legend">${["منتشرشده", "در انتظار", "نیازمند بررسی"].map((label, i) => `<div><span class="pill ${i === 0 ? "primary" : i === 1 ? "success" : "warning"}">${label}</span><strong>${fa(values[i])}</strong></div>`).join("")}</div>`;
}
