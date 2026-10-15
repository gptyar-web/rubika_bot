// All API operations use explicit intercepted fixtures. No live Rubika calls.
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { buildMessage } from '../server/supabase/functions/rubika-panel/lib/adapter.js';
import { validateInteractionResource } from '../server/supabase/functions/rubika-panel/lib/interactions.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/rubika-tools/node_modules/playwright/index.mjs');
const base = new URL(process.env.BASE_URL || 'http://127.0.0.1:4173/rubika_bot/');
if (!['127.0.0.1', 'localhost'].includes(base.hostname)) throw new Error('Fixture browser tests require the local development server.');
const artifacts = process.env.TEST_ARTIFACTS || '/tmp/rubika-nextvalidation';
await mkdir(artifacts, { recursive: true });
const execute = promisify(execFile);
let passed = 0;
const pass = label => { passed++; console.log(`PASS ${label}`); };
const TOKEN = 'test-only-next-token-' + 'n'.repeat(48);
const CAPABILITIES = { collections: true, messaging: true, polling: true, engine: true, automation_execution: true, moderation: true, scheduling: true, reporting: true, reports: true, background: false, webhook: false, rbac: false };
const bot = { id: 'next-bot', bot_id: 'next-bot', name: 'ربات مرورگر', username: 'next_fixture' };
let groups = [{ chat_id: 'g_next', title: 'گروه مرورگر', type: 'group', settings: { active: false, rules: 'قوانین' } }];
const collections = new Map([['templates', [{ id: 'template-fixture', data: { title: 'قالب آزمون', text: 'سلام {name}؛ {{user_id}} در {chat_title} {token} <img src=x onerror="window.__template_xss=1">' }, updated_at: '2026-10-15T00:00:00Z' }]]]);
const requests = []; const errors = []; const fixtureErrors = [];
let workerRunning = false;
let emptyReport = false;
const report = {
  from: '2026-10-08T00:00:00.000Z', to: '2026-10-15T00:00:00.000Z', timezone: 'Asia/Tehran',
  summary: { received: 5, processed: 4, active_users: 2, warnings: 1, violations: 2, api_errors: 1, average_response_ms: 35, schedule_success: 1, schedule_failed: 0, schedule_unknown: 0 },
  daily: [{ date: '2026-10-14', received: 5, processed: 4, warnings: 1, violations: 2, errors: 1 }],
  by_type: [{ type: 'NewMessage', count: 5 }], by_command: [{ command: '/rules', count: 2 }],
  previous: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-08T00:00:00.000Z', summary: { received: 0, processed: 0, active_users: 0, warnings: 0, violations: 0, api_errors: 0, average_response_ms: 0, schedule_success: 0, schedule_failed: 0, schedule_unknown: 0 }, daily: [], by_type: [], by_command: [] },
  source: { events: 5, audit: 1, schedules: 0, truncated: false },
};
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, timezoneId: 'America/Los_Angeles', serviceWorkers: 'block', acceptDownloads: true });
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.message));
page.on('dialog', dialog => dialog.accept());
await context.route('**/functions/v1/rubika-panel', async route => {
  if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' } });
  const body = route.request().postDataJSON(); requests.push(body);
  const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(data) });
  try {
    assert.equal(route.request().url().includes(TOKEN), false);
    if (body.action === 'health') return reply({ ok: true, configured: true, capabilities: CAPABILITIES });
    assert.equal(body.token, TOKEN);
    switch (body.action) {
      case 'login': return reply({ ok: true, bot, capabilities: CAPABILITIES });
      case 'list': return reply({ ok: true, groups, capabilities: CAPABILITIES });
      case 'save': { const group = { chat_id: body.chat_id, title: body.title, type: body.type || 'group', settings: body.settings }; groups = [...groups.filter(value => value.chat_id !== group.chat_id), group]; return reply({ ok: true, group }); }
      case 'collection_list': return reply({ ok: true, items: collections.get(body.collection) || [] });
      case 'collection_save': {
        validateInteractionResource(body.collection, body.data);
        const item = { id: body.id || `next-${requests.length}`, data: body.data, updated_at: '2026-10-15T00:00:00Z' };
        collections.set(body.collection, [...(collections.get(body.collection) || []).filter(value => value.id !== item.id), item]); return reply({ ok: true, item });
      }
      case 'collection_delete': collections.set(body.collection, (collections.get(body.collection) || []).filter(value => value.id !== body.id)); return reply({ ok: true });
      case 'message': assert.equal(body.authorized, true); buildMessage(body.method, body.params); return reply({ ok: true, result: { message_id: 'next-sent-fixture' } });
      case 'engine_status': return reply({ ok: true, capabilities: CAPABILITIES, worker_running: workerRunning, runtime: { last_heartbeat_at: workerRunning ? new Date().toISOString() : null, last_error_code: null }, warning_counts: { g_next: 1 } });
      case 'engine_run': assert.equal(body.authorized, true); return reply({ ok: true, received: 2, processed: 1, duplicates: 1, failed: 0 });
      case 'schedule_run': assert.equal(body.authorized, true); return reply({ ok: true, executed: 1, results: [{ id: 'schedule-fixture', status: 'success' }] });
      case 'reports': case 'report': {
        const measured = { ...report, from: body.from, to: body.to };
        if (body.compare === false) delete measured.previous;
        if (emptyReport) { measured.summary = Object.fromEntries(Object.keys(report.summary).map(key => [key, 0])); measured.daily = []; measured.by_type = []; measured.by_command = []; }
        return reply({ ok: true, report: measured, truncated: false });
      }
      case 'logs': return reply({ ok: true, logs: [] });
      default: throw new Error(`Unhandled fixture operation: ${body.action}`);
    }
  } catch (error) { fixtureErrors.push(error.message); return reply({ ok: false, code: 'TEST_FIXTURE_REJECTED', error: error.message }, 400); }
});
const nav = async route => {
  if (await page.locator('#menuButton').isVisible() && !(await page.locator('#sidebar').getAttribute('class')).split(/\s+/).includes('open')) await page.locator('#menuButton').click();
  await page.locator(`#navigation [data-route="${route}"]`).click();
};
const tab = async name => { await page.locator(`[data-tab="${name}"]`).click(); await page.locator('#collectionSearch').waitFor(); };
const saved = collection => requests.filter(value => value.action === 'collection_save' && value.collection === collection);
const saveCollection = async collection => {
  const response = page.waitForResponse(response => response.request().postDataJSON()?.action === 'collection_save' && response.request().postDataJSON()?.collection === collection);
  await page.locator('#saveCollection').click(); await response; await page.locator('#modal').waitFor({ state: 'hidden' }); await page.locator('#collectionSearch').waitFor();
  return saved(collection).at(-1).data;
};
const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Page must fit its viewport.');
try {
  await page.goto(base.href); await nav('bots'); await page.locator('#token').fill(TOKEN); await page.locator('#loginBtn').click(); await page.locator('[data-select-bot="next-bot"]').waitFor(); await nav('bots');
  assert.equal(await page.locator('#token').inputValue(), '');
  await page.locator('#engineStatus').click(); await page.locator('#engineRuntime').filter({ hasText: 'تأیید نشده' }).waitFor();
  assert.doesNotMatch(await page.locator('#engineRuntime').textContent(), /ضربان اخیر تأیید شد/);
  workerRunning = true; await page.locator('#engineStatus').click(); await page.locator('#engineRuntime').filter({ hasText: 'ضربان اخیر تأیید شد' }).waitFor();
  pass('worker status follows actual heartbeat fixture instead of login or engine capability');

  const beforeEngine = requests.filter(value => value.action === 'engine_run').length;
  await page.locator('#engineRun').click(); await page.locator('#cancelConfirm').click(); assert.equal(requests.filter(value => value.action === 'engine_run').length, beforeEngine);
  await page.locator('#engineRun').click(); const engineResponse = page.waitForResponse(response => response.request().postDataJSON()?.action === 'engine_run'); await page.locator('#confirmAction').click(); await engineResponse; await page.locator('#modal').waitFor({ state: 'hidden' });
  assert.equal(requests.filter(value => value.action === 'engine_run').at(-1).authorized, true);
  pass('manual engine run requires a concrete confirmation and carries authorization');

  await nav('messages'); await page.locator('#messageTemplate').selectOption('template-fixture');
  await page.locator('#templateName').fill('مینا'); await page.locator('#templateUser').fill('u_browser'); await page.locator('#previewMessage').click();
  assert.match(await page.locator('#messagePreview').textContent(), /سلام مینا؛ u_browser در گروه مرورگر \{token\}/);
  assert.equal(await page.locator('#messagePreview img').count(), 0); assert.equal(await page.evaluate(() => window.__template_xss), undefined);
  await page.locator('#keypadType').selectOption('normal'); await page.locator('#kp_0_0_text').fill('ورود <img onerror=alert(1)>'); await page.locator('#kp_0_0_id').fill('unique_one');
  await page.locator('[data-keypad-add="0"]').click(); await page.locator('#kp_0_1_text').fill('دوم'); await page.locator('#kp_0_1_id').fill('unique_one');
  await page.locator('#messageConsent').check(); await page.locator('#sendMessage').click(); await page.locator('#messageError').filter({ hasText: 'یکتا' }).waitFor(); assert.equal(requests.filter(value => value.action === 'message').length, 0);
  await page.locator('#kp_0_1_id').fill('unique_two');
  const messageResponse = page.waitForResponse(response => response.request().postDataJSON()?.action === 'message'); await page.locator('#sendMessage').click(); await messageResponse; await page.locator('#messageResult').filter({ hasText: 'next-sent-fixture' }).waitFor();
  const outbound = requests.filter(value => value.action === 'message').at(-1);
  assert.equal(outbound.params.chat_keypad_type, 'New'); assert.equal(outbound.params.chat_id, 'g_next'); assert.deepEqual(outbound.params.chat_keypad.rows[0].buttons.map(button => button.id), ['unique_one', 'unique_two']);
  assert.equal(outbound.params.inline_keypad, undefined); assert.match(outbound.params.text, /سلام مینا/);
  pass('template substitution is allowlisted text; duplicate keypad IDs block sends and valid payload uses New');

  await nav('automation'); await page.locator('#collectionSearch').waitFor(); await page.locator('#addCollectionItem').click();
  await page.locator('#col_title').fill('قاعده مرورگر'); await page.locator('#col_trigger').fill('سلام'); await page.locator('#col_response').fill('پاسخ {user_id}');
  await page.locator('[data-rule-chat="g_next"]').check(); await page.locator('#ruleHours').check(); await page.locator('#ruleStart').fill('22:00'); await page.locator('#ruleEnd').fill('06:00'); await page.locator('#col_enabled').check();
  await page.locator('#saveCollection').click(); await page.locator('#collectionError').filter({ hasText: 'مجوز' }).waitFor(); assert.equal(saved('automations').length, 0);
  await page.locator('#col_authorized').check(); await page.locator('#saveCollection').click(); await page.locator('#collectionError').filter({ hasText: 'پیش‌نمایش' }).waitFor(); assert.equal(saved('automations').length, 0);
  await page.locator('#previewCollection').click(); await page.locator('#col_response').fill('پاسخ ویرایش‌شده'); await page.locator('#saveCollection').click(); await page.locator('#collectionError').filter({ hasText: 'پیش‌نمایش' }).waitFor();
  await page.locator('#previewCollection').click(); const automation = await saveCollection('automations');
  assert.equal(automation.status, 'approved'); assert.equal(automation.enabled, true); assert.equal(automation.authorized, true); assert.deepEqual(automation.allowed_chat_ids, ['g_next']); assert.equal(automation.work_hours.start, '22:00'); assert.equal(automation.work_hours.end, '06:00');
  await page.locator('[data-edit-item]').click(); assert.equal(await page.locator('#col_authorized').isChecked(), false); await page.locator('#col_enabled').uncheck(); const draft = await saveCollection('automations'); assert.equal(draft.status, 'draft'); assert.equal(draft.authorized, false); assert.equal(draft.enabled, false);
  pass('automation approval requires authorization and a current preview; edits can save safely as drafts');

  await tab('flows'); await page.locator('#addCollectionItem').click(); await page.locator('#col_title').fill('فرم مرورگر'); await page.locator('#col_command').fill('/browser_form'); await page.locator('[data-rule-chat="g_next"]').check();
  await page.locator('#addFlowStep').click(); await page.locator('#flow_0_key').fill('age'); await page.locator('#flow_0_prompt').fill('سن را وارد کنید'); await page.locator('#flow_0_validation').selectOption('number');
  await page.locator('#addFlowStep').click(); await page.locator('#flow_1_key').fill('selection'); await page.locator('#flow_1_prompt').fill('گزینه را انتخاب کنید'); await page.locator('#flow_1_validation').selectOption('choice'); await page.locator('#flow_1_options').fill('الف\nب');
  assert.equal(await page.locator('#col_session_ttl_minutes').getAttribute('max'), '15');
  const createdFlow = await saveCollection('flows'); assert.equal(createdFlow.steps.length, 2); assert.equal(createdFlow.steps[0].validation, 'number'); assert.deepEqual(createdFlow.steps[1].options, ['الف', 'ب']); assert.equal(createdFlow.status, 'draft');
  pass('visual flow builder saves valid numbered and choice steps with a fifteen-minute maximum');

  await tab('menus'); await page.locator('#addCollectionItem').click(); await page.locator('#col_title').fill('منوی مرورگر'); await page.locator('#col_command').fill('/browser_menu'); await page.locator('[data-rule-chat="g_next"]').check();
  await page.locator('#addMenuItem').click(); await page.locator('[data-menu-path="0"][data-menu-prop="text"]').fill('شاخه'); await page.locator('[data-menu-path="0"][data-menu-prop="id"]').fill('parent'); await page.locator('[data-menu-add-child="0"]').click();
  await page.locator('[data-menu-path="0.0"][data-menu-prop="text"]').fill('فرزند'); await page.locator('[data-menu-path="0.0"][data-menu-prop="id"]').fill('parent'); await page.locator('[data-menu-path="0.0"][data-menu-prop="response"]').fill('پاسخ فرزند');
  await page.locator('#saveCollection').click(); await page.locator('#collectionError').filter({ hasText: 'یکتا' }).waitFor(); assert.equal(saved('menus').length, 0);
  await page.locator('[data-menu-path="0.0"][data-menu-prop="id"]').fill('child'); const createdMenu = await saveCollection('menus'); assert.equal(createdMenu.items[0].children[0].id, 'child');
  await tab('subscribers'); assert.equal(await page.locator('#addCollectionItem').count(), 0); assert.equal(await page.locator('[data-edit-item]').count(), 0);
  pass('nested menu IDs stay unique and subscription records remain read-only');

  await nav('schedules'); await page.locator('#collectionSearch').waitFor(); await page.locator('#addCollectionItem').click();
  await page.locator('#col_title').fill('زمان‌بندی مرورگر'); await page.locator('#col_chat_id').selectOption('g_next'); await page.locator('#col_text').fill('پیام برنامه'); await page.locator('#col_scheduled_at').fill('2025-03-20T09:00'); await page.locator('#col_scheduled_at').dispatchEvent('change');
  assert.match(await page.locator('#scheduleCalendar .persian-calendar-title').textContent(), /اسفند ۱۴۰۳/); assert.equal(await page.locator('#scheduleCalendar [data-date="2025-03-20"]').getAttribute('aria-selected'), 'true');
  await page.locator('#scheduleCalendar [data-date="2025-03-20"]').click(); assert.equal(await page.locator('#col_scheduled_at').inputValue(), '2025-03-20T09:00');
  await page.locator('#scheduleRepeat').check(); await page.locator('#repeatMinutes').fill('1440'); await page.locator('#repeatCount').fill('3');
  await page.locator('#col_enabled').check(); await page.locator('#col_authorized').check(); await page.locator('#previewCollection').click(); const createdSchedule = await saveCollection('schedules');
  assert.equal(createdSchedule.scheduled_at, '2025-03-20T05:30:00.000Z'); assert.equal(createdSchedule.recurrence.max_occurrences, 3); assert.equal(createdSchedule.status, 'approved');
  const beforeSchedule = requests.filter(value => value.action === 'schedule_run').length; await page.locator('#runSchedules').click(); await page.locator('#cancelConfirm').click(); assert.equal(requests.filter(value => value.action === 'schedule_run').length, beforeSchedule);
  await page.locator('#runSchedules').click(); const scheduleResponse = page.waitForResponse(response => response.request().postDataJSON()?.action === 'schedule_run'); await page.locator('#confirmAction').click(); await scheduleResponse; await page.locator('#modal').waitFor({ state: 'hidden' });
  assert.equal(requests.filter(value => value.action === 'schedule_run').at(-1).authorized, true); await page.locator('#scheduleRunResult').filter({ hasText: 'success' }).waitFor();
  pass('Persian leap-day selection saves Tehran time correctly and manual schedule execution requires confirmation');

  // Use the exported calendar independently to check keyboard behavior, cleanup and XML parsability in a real DOM.
  const calendarChecks = await page.evaluate(async () => {
    const { mountPersianCalendar } = await import('./assets/js/calendar.js');
    const host = document.createElement('section'); document.body.append(host); const selected = [];
    const calendar = mountPersianCalendar(host, { value: '2025-03-20', onSelect: (iso, persian) => selected.push({ iso, persian }) });
    const current = host.querySelector('[data-date="2025-03-20"]'); current.focus(); current.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    const focusAfterArrow = document.activeElement.dataset.date;
    document.activeElement.click(); const newValue = calendar.value;
    calendar.setValue('2026-10-15'); const title = host.querySelector('.persian-calendar-title').textContent;
    calendar.setValue(''); const selectedCells = host.querySelectorAll('[aria-selected="true"]').length;
    calendar.destroy(); const childrenAfterDestroy = host.children.length; host.remove();
    return { focusAfterArrow, newValue, selected, title, selectedCells, childrenAfterDestroy };
  });
  assert.equal(calendarChecks.focusAfterArrow, '2025-03-21'); assert.equal(calendarChecks.newValue, '2025-03-21'); assert.deepEqual(calendarChecks.selected[0].persian, { year: 1404, month: 1, day: 1 }); assert.match(calendarChecks.title, /مهر ۱۴۰۵/); assert.equal(calendarChecks.selectedCells, 0); assert.equal(calendarChecks.childrenAfterDestroy, 0);
  pass('accessible Persian calendar keyboard moves across Nowruz, updates state and cleans up');

  const xmlCheck = await page.evaluate(async () => {
    const { createXLSX } = await import('./assets/js/exporters.js'); const bytes = createXLSX([['نام', 'پیام'], ['علی & مینا', '=1+1']]);
    const view = new DataView(bytes.buffer); const decoder = new TextDecoder(); const files = []; let offset = 0;
    while (view.getUint32(offset, true) === 0x04034b50) {
      const size = view.getUint32(offset + 18, true); const nameLength = view.getUint16(offset + 26, true); const begin = offset + 30 + nameLength + view.getUint16(offset + 28, true);
      const name = decoder.decode(bytes.slice(offset + 30, offset + 30 + nameLength)); const source = decoder.decode(bytes.slice(begin, begin + size)); const document = new DOMParser().parseFromString(source, 'application/xml');
      files.push({ name, invalid: document.querySelector('parsererror') !== null, formulaCount: document.getElementsByTagName('f').length, text: document.documentElement.textContent }); offset = begin + size;
    }
    return files;
  });
  assert.equal(xmlCheck.length, 5); assert(xmlCheck.every(file => !file.invalid)); assert.equal(xmlCheck.at(-1).formulaCount, 0); assert.match(xmlCheck.at(-1).text, /علی & مینا=1\+1/);
  pass('real browser DOMParser validates all OOXML parts and confirms literal formula-looking cells');

  await nav('reports');
  await page.locator('#reportStats .stat-value').first().waitFor();
  assert.deepEqual(await page.locator('#reportStats .stat-value').allTextContents(), ['۵', '۴', '۲', '۲', '۱', '۳۵', '۱', '۱']);
  assert.equal(await page.locator('#reportStats .comparison').count(), 8); assert.match(await page.locator('#reportStats .comparison').first().textContent(), /۰/);
  assert.match(await page.locator('#reportBreakdown').textContent(), /NewMessage/); assert.match(await page.locator('#reportBreakdown').textContent(), /\/rules/);
  await page.locator('#reportStart').fill('2026-10-14'); await page.locator('#reportEnd').fill('2026-10-14');
  const filteredReport = page.waitForResponse(response => response.request().postDataJSON()?.action === 'reports'); await page.locator('#loadMetrics').click(); await filteredReport;
  const filterRequest = requests.filter(value => value.action === 'reports').at(-1); assert.equal(filterRequest.from, '2026-10-13T20:30:00.000Z'); assert.equal(filterRequest.to, '2026-10-14T20:30:00.000Z'); assert.equal(filterRequest.compare, true);
  const jsonPromise = page.waitForEvent('download'); await page.locator('#exportJSON').click(); const jsonDownload = await jsonPromise; const jsonPath = path.join(artifacts, jsonDownload.suggestedFilename()); await jsonDownload.saveAs(jsonPath); const downloadedReport = JSON.parse(await readFile(jsonPath, 'utf8')); assert.equal(downloadedReport.summary.received, 5); assert.equal(downloadedReport.previous.summary.received, 0); assert.equal(downloadedReport.from, filterRequest.from);
  pass('measured report values, zero comparison period, Tehran date filtering and JSON export agree');
  const downloadPromise = page.waitForEvent('download'); await page.locator('#exportXLSX').click(); const download = await downloadPromise; const downloadPath = path.join(artifacts, download.suggestedFilename()); await download.saveAs(downloadPath);
  const archive = await readFile(downloadPath); assert.equal(archive.readUInt32LE(0), 0x04034b50);
  try { const output = await execute('unzip', ['-t', downloadPath]); assert.match(output.stdout, /No errors detected/); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  assert(requests.some(value => ['reports', 'report'].includes(value.action)), 'Reports must request measured server data.');
  pass('report uses server measurements and downloads a complete valid XLSX archive');

  emptyReport = true; await page.locator('#reportCompare').uncheck(); const emptyResponse = page.waitForResponse(response => response.request().postDataJSON()?.action === 'reports'); await page.locator('#loadMetrics').click(); await emptyResponse; await page.locator('#reportChart').filter({ hasText: 'داده‌ای در این بازه ثبت نشده' }).waitFor();
  assert.equal(await page.locator('#reportChart .chart-col').count(), 0); assert((await page.locator('#reportStats .stat-value').allTextContents()).every(value => value === '۰')); assert.equal(await page.locator('#reportStats .comparison').count(), 0);
  assert.equal(requests.filter(value => value.action === 'reports').at(-1).compare, false);
  await page.locator('#reportEnd').fill('2026-10-14'); await page.locator('#reportPreset').selectOption('30'); assert.equal(await page.locator('#reportStart').inputValue(), '2026-09-15');
  pass('empty server reports render zero values without invented chart bars and report presets span thirty days');

  await page.setViewportSize({ width: 390, height: 844 }); await noOverflow(); await page.screenshot({ path: path.join(artifacts, 'reports-mobile.png'), fullPage: true });
  await nav('schedules'); await page.locator('#collectionSearch').waitFor(); await page.locator('#addCollectionItem').click(); await noOverflow(); await page.screenshot({ path: path.join(artifacts, 'calendar-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(token => [localStorage, sessionStorage].some(storage => Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index))).some(value => value?.includes(token))), TOKEN), false);
  assert.deepEqual(errors, []); assert.deepEqual(fixtureErrors, []);
  pass('mobile reports and calendar fit the viewport; no page exceptions, fixture schema errors or stored tokens');
  console.log(`${passed} additional browser checks passed; artifacts: ${artifacts}`);
} catch (error) {
  await page.screenshot({ path: path.join(artifacts, 'failure.png'), fullPage: true }).catch(() => {});
  console.error('Fixture errors:', fixtureErrors); console.error('Browser errors:', errors); throw error;
} finally { await browser.close(); }
