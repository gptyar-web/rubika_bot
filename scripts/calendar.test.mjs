import test from 'node:test';
import assert from 'node:assert/strict';
import { persianParts, persianToGregorianISO, persianMonthGrid } from '../assets/js/calendar.js';

test('known Persian dates round trip across Nowruz and leap-year boundaries', () => {
  const fixtures = [
    [1399, 12, 30, '2021-03-20'], [1400, 1, 1, '2021-03-21'],
    [1402, 12, 29, '2024-03-19'], [1403, 1, 1, '2024-03-20'],
    [1403, 12, 30, '2025-03-20'], [1404, 1, 1, '2025-03-21'],
    [1405, 1, 1, '2026-03-21'], [1405, 7, 23, '2026-10-15'],
  ];
  for (const [year, month, day, iso] of fixtures) {
    assert.equal(persianToGregorianISO(year, month, day), iso);
    assert.deepEqual(persianParts(iso), { year, month, day });
  }
});

test('date-only UTC arithmetic rejects rolled dates, ambiguous times and invalid Esfand days', () => {
  for (const args of [[1402, 12, 30], [1404, 12, 30], [1405, 7, 31], [1405, 13, 1], [0, 1, 1], [3001, 1, 1], [1405, 1, 1.2]]) assert.throws(() => persianToGregorianISO(...args), undefined, args.join('/'));
  for (const value of ['2026-02-30', '2026-13-01', '2026-10-15T00:00:00', 'not a date', null]) assert.throws(() => persianParts(value), undefined, String(value));
  assert.deepEqual(persianParts('2026-10-15T00:30:00+03:30'), persianParts('2026-10-14'));
});

test('Saturday-first grids contain six complete contiguous weeks and all days of their month', () => {
  for (const [year, month, count] of [[1403, 12, 30], [1404, 12, 29], [1405, 1, 31], [1405, 7, 30]]) {
    const grid = persianMonthGrid(year, month);
    assert.equal(grid.length, 42); assert.equal(new Date(`${grid[0].gregorian}T12:00:00Z`).getUTCDay(), 6);
    assert.equal(grid.filter(day => !day.outside).length, count);
    assert.deepEqual(grid.filter(day => !day.outside).map(day => day.day), Array.from({ length: count }, (_, index) => index + 1));
    grid.forEach((day, index) => { assert.equal(day.weekday, index % 7); if (index) assert.equal(Date.parse(grid[index].gregorian) - Date.parse(grid[index - 1].gregorian), 86400000); });
  }
});

test('the documented year range supports conversions and outside cells at both boundaries', () => {
  for (const year of [1, 3000]) {
    const date = persianToGregorianISO(year, 1, 1); assert.deepEqual(persianParts(date), { year, month: 1, day: 1 });
    assert.equal(persianMonthGrid(year, 1).length, 42);
  }
});
