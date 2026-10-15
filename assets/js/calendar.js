// All calendar arithmetic uses date-only values at UTC noon. A host timezone
// therefore cannot change a selected day or the Persian/Gregorian conversion.
const DAY = 86_400_000;
const persianFormatter = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
  timeZone: 'UTC', year: 'numeric', month: 'numeric', day: 'numeric',
});
const labelFormatter = new Intl.DateTimeFormat('fa-IR-u-ca-persian', {
  timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
});
const numberFormatter = new Intl.NumberFormat('fa-IR', { useGrouping: false });
const MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
const WEEKDAYS = ['شنبه', 'یکشنبه', 'دوشنبه', 'سه‌شنبه', 'چهارشنبه', 'پنجشنبه', 'جمعه'];

export const PERSIAN_SUPPORTED_RANGE = Object.freeze({ minYear: 1, maxYear: 3000 });

function parseDate(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T12:00:00.000Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
      throw new RangeError('تاریخ میلادی معتبر نیست.');
    }
    return date;
  }
  if (typeof value === 'string' && !/T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(value)) {
    throw new TypeError('تاریخ باید YYYY-MM-DD یا زمان ISO با منطقهٔ زمانی مشخص باشد.');
  }
  if (!(value instanceof Date) && typeof value !== 'string' && typeof value !== 'number') {
    throw new TypeError('تاریخ معتبر لازم است.');
  }
  const date = new Date(value instanceof Date ? value.getTime() : value);
  if (!Number.isFinite(date.getTime())) throw new RangeError('تاریخ معتبر نیست.');
  return date;
}

function partsFor(date) {
  const parts = persianFormatter.formatToParts(date);
  const part = name => Number(parts.find(item => item.type === name)?.value);
  return { year: part('year'), month: part('month'), day: part('day') };
}

/** Convert a Gregorian YYYY-MM-DD, Date, epoch, or zoned ISO timestamp in UTC. */
export function persianParts(value) {
  return partsFor(parseDate(value));
}

function validatePersian(year, month, day) {
  if (![year, month, day].every(Number.isInteger)) throw new TypeError('سال، ماه و روز باید عدد صحیح باشند.');
  if (year < PERSIAN_SUPPORTED_RANGE.minYear || year > PERSIAN_SUPPORTED_RANGE.maxYear) {
    throw new RangeError('سال شمسی باید بین ۱ و ۳۰۰۰ باشد.');
  }
  if (month < 1 || month > 12 || day < 1 || day > (month <= 6 ? 31 : 30)) {
    throw new RangeError('تاریخ شمسی معتبر نیست.');
  }
}

function compare(a, b) {
  return a.year - b.year || a.month - b.month || a.day - b.day;
}

/**
 * Convert and round-trip validate a Persian date, including Esfand leap days.
 * Supported Persian years: 1–3000. Uses the platform's Intl Persian calendar.
 */
export function persianToGregorianISO(year, month, day) {
  validatePersian(year, month, day);
  const target = { year, month, day };
  const gregorianYear = year + 621;
  const start = parseDate(`${String(gregorianYear).padStart(4, '0')}-01-01`).getTime();
  const finish = parseDate(`${String(gregorianYear + 1).padStart(4, '0')}-12-31`).getTime();
  let low = 0;
  let high = Math.round((finish - start) / DAY);
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (compare(partsFor(new Date(start + middle * DAY)), target) < 0) low = middle + 1;
    else high = middle;
  }
  const result = new Date(start + low * DAY);
  if (compare(partsFor(result), target) !== 0) throw new RangeError('تاریخ شمسی معتبر نیست؛ روز کبیسه را بررسی کنید.');
  return result.toISOString().slice(0, 10);
}

/**
 * Return 42 consecutive cells in six Saturday-first weeks. weekday is 0–6
 * (Saturday–Friday); gregorian is YYYY-MM-DD; outside marks an adjacent month.
 * At the supported range's edges, outside cells can belong to year 0 or 3001.
 */
export function persianMonthGrid(year, month) {
  const first = parseDate(persianToGregorianISO(year, month, 1));
  const offset = (first.getUTCDay() + 1) % 7;
  const start = first.getTime() - offset * DAY;
  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(start + index * DAY);
    const parts = partsFor(date);
    return {
      ...parts,
      gregorian: date.toISOString().slice(0, 10),
      weekday: index % 7,
      outside: parts.year !== year || parts.month !== month,
    };
  });
}

function shiftedMonth(year, month, delta) {
  const ordinal = year * 12 + month - 1 + delta;
  return { year: Math.floor(ordinal / 12), month: ((ordinal % 12) + 12) % 12 + 1 };
}

function inRange(year) {
  return year >= PERSIAN_SUPPORTED_RANGE.minYear && year <= PERSIAN_SUPPORTED_RANGE.maxYear;
}

/**
 * Mount an accessible, RTL Persian date picker. value/onSelect use Gregorian
 * YYYY-MM-DD. onSelect also receives Persian {year, month, day} as argument 2.
 * Returns {setValue(value), destroy(), get value()}; importing needs no DOM.
 */
export function mountPersianCalendar(container, { value = '', onSelect } = {}) {
  if (!container?.ownerDocument || typeof container.append !== 'function') {
    throw new TypeError('عنصر میزبان تقویم لازم است.');
  }
  const doc = container.ownerDocument;
  const todayParts=Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Tehran',year:'numeric',month:'2-digit',day:'2-digit'}).formatToParts(new Date()).map(part=>[part.type,part.value]));
  const today = `${todayParts.year}-${todayParts.month}-${todayParts.day}`;
  let selected = '';
  let view = persianParts(value || today);
  if (!inRange(view.year)) throw new RangeError('این تاریخ خارج از محدودهٔ تقویم است.');
  if (value) selected = parseDate(value).toISOString().slice(0, 10);
  let focusDate = selected || persianToGregorianISO(view.year, view.month, 1);
  let destroyed = false;
  const element = (tag, className, text) => {
    const result = doc.createElement(tag);
    if (className) result.className = className;
    if (text) result.textContent = text;
    return result;
  };
  const root = element('div', 'persian-calendar');
  root.dir = 'rtl';
  const navigation = element('div', 'persian-calendar-nav');
  const previous = element('button', 'btn', 'ماه قبل');
  const next = element('button', 'btn', 'ماه بعد');
  previous.type = next.type = 'button';
  previous.setAttribute('aria-label', 'نمایش ماه قبل');
  next.setAttribute('aria-label', 'نمایش ماه بعد');
  const title = element('strong', 'persian-calendar-title');
  title.setAttribute('aria-live', 'polite');
  title.setAttribute('aria-atomic', 'true');
  navigation.append(previous, title, next);
  const grid = element('div', 'persian-calendar-grid');
  grid.setAttribute('role', 'grid');
  root.append(navigation, grid);
  container.append(root);

  function render() {
    title.textContent = `${MONTHS[view.month - 1]} ${numberFormatter.format(view.year)}`;
    grid.setAttribute('aria-label', `انتخاب تاریخ، ${title.textContent}`);
    previous.disabled = view.year === PERSIAN_SUPPORTED_RANGE.minYear && view.month === 1;
    next.disabled = view.year === PERSIAN_SUPPORTED_RANGE.maxYear && view.month === 12;
    grid.replaceChildren();
    const headings = element('div', 'persian-calendar-row');
    headings.setAttribute('role', 'row');
    // display:contents lets the parent grid keep seven columns without a
    // required global stylesheet rule for the semantic row wrappers.
    headings.style.display = 'contents';
    WEEKDAYS.forEach(weekday => {
      const heading = element('span', 'persian-calendar-weekday', weekday);
      heading.setAttribute('role', 'columnheader');
      headings.append(heading);
    });
    grid.append(headings);
    const cells = persianMonthGrid(view.year, view.month);
    if (!cells.some(cell => cell.gregorian === focusDate && !cell.outside)) {
      focusDate = cells.find(cell => !cell.outside)?.gregorian;
    }
    let row;
    cells.forEach((cell, index) => {
      if (index % 7 === 0) {
        row = element('div', 'persian-calendar-row');
        row.style.display = 'contents';
        row.setAttribute('role', 'row');
        grid.append(row);
      }
      const button = element('button', 'persian-calendar-day', numberFormatter.format(cell.day));
      button.type = 'button';
      button.dataset.date = cell.gregorian;
      button.setAttribute('role', 'gridcell');
      button.setAttribute('aria-label', `${labelFormatter.format(parseDate(cell.gregorian))}، ${cell.gregorian}`);
      button.setAttribute('aria-selected', String(cell.gregorian === selected));
      button.tabIndex = cell.gregorian === focusDate ? 0 : -1;
      button.disabled = !inRange(cell.year);
      if (cell.outside) button.classList.add('outside');
      if (cell.gregorian === selected) button.classList.add('selected');
      if (cell.gregorian === today) {
        button.classList.add('today');
        button.setAttribute('aria-current', 'date');
      }
      button.addEventListener('click', () => {
        selected = focusDate = cell.gregorian;
        view = { year: cell.year, month: cell.month };
        render();
        grid.querySelector(`[data-date="${focusDate}"]`)?.focus();
        onSelect?.(selected, { year: cell.year, month: cell.month, day: cell.day });
      });
      row.append(button);
    });
  }

  function moveMonth(delta) {
    const target = shiftedMonth(view.year, view.month, delta);
    if (!inRange(target.year)) return;
    view = target;
    focusDate = persianToGregorianISO(view.year, view.month, 1);
    render();
  }
  previous.addEventListener('click', () => moveMonth(-1));
  next.addEventListener('click', () => moveMonth(1));
  grid.addEventListener('keydown', event => {
    const button = event.target.closest?.('[data-date]');
    if (!button || !grid.contains(button)) return;
    const delta = { ArrowLeft: 1, ArrowRight: -1, ArrowUp: -7, ArrowDown: 7 }[event.key];
    let target;
    if (delta !== undefined) {
      target = new Date(parseDate(button.dataset.date).getTime() + delta * DAY).toISOString().slice(0, 10);
    } else if (event.key === 'Home' || event.key === 'End') {
      const date = parseDate(button.dataset.date);
      const weekday = (date.getUTCDay() + 1) % 7;
      target = new Date(date.getTime() + (event.key === 'Home' ? -weekday : 6 - weekday) * DAY).toISOString().slice(0, 10);
    } else if (event.key === 'PageUp' || event.key === 'PageDown') {
      const current = persianParts(button.dataset.date);
      const month = shiftedMonth(current.year, current.month, event.key === 'PageUp' ? -1 : 1);
      if (!inRange(month.year)) return;
      const days = persianMonthGrid(month.year, month.month).filter(cell => !cell.outside);
      target = days[Math.min(current.day, days.length) - 1].gregorian;
    } else return;
    event.preventDefault();
    const parts = persianParts(target);
    if (!inRange(parts.year)) return;
    view = { year: parts.year, month: parts.month };
    focusDate = target;
    render();
    grid.querySelector(`[data-date="${focusDate}"]`)?.focus();
  });
  render();
  return {
    get value() { return selected; },
    setValue(newValue = '') {
      if (destroyed) return;
      const nextValue = newValue ? parseDate(newValue).toISOString().slice(0, 10) : '';
      const parts = persianParts(nextValue || today);
      if (!inRange(parts.year)) throw new RangeError('این تاریخ خارج از محدودهٔ تقویم است.');
      selected = nextValue;
      view = { year: parts.year, month: parts.month };
      focusDate = nextValue || persianToGregorianISO(parts.year, parts.month, 1);
      render();
    },
    destroy() { destroyed = true; root.remove(); },
  };
}
