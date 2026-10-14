// Browser regression checks use an intercepted API fixture. They never contact Rubika or send real messages.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { mkdir, readFile } from 'node:fs/promises';
import { validateEndpoint } from '../assets/js/api.js';
import { validateBackup, csv, tehranDateTimeInput, tehranInputToISO } from '../assets/js/model.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || '/tmp/rubika-tools/node_modules/playwright/index.mjs');
const base = new URL(process.env.BASE_URL || 'http://127.0.0.1:4173/rubika_bot/');
if (!['127.0.0.1', 'localhost'].includes(base.hostname)) throw new Error('Run fixture checks against the local development server.');
const artifacts = process.env.TEST_ARTIFACTS || '/tmp/rubika-validation';
await mkdir(artifacts, { recursive: true });
let passed = 0;
const pass = label => { passed++; console.log(`PASS ${label}`); };
for (const endpoint of ['http://unsafe.example/api', 'https://user:password@example.com/api', 'https://example.com/api?token=not-a-secret']) assert.throws(() => validateEndpoint(endpoint));
assert.equal(validateEndpoint('https://example.com/api/'), 'https://example.com/api');
const backupGroup = { chat_id: 'g_backup', title: 'آزمون', settings: { warn_limit: 3, quiet_start: '23:00', quiet_end: '07:00', locks: {} } };
assert.throws(() => validateBackup({ version: 1, groups: [{ ...backupGroup, settings: { ...backupGroup.settings, warn_limit: 0 } }] }));
assert.throws(() => validateBackup({ version: 1, groups: [backupGroup, backupGroup] }));
assert.throws(() => validateBackup({ version: 1, groups: [{ ...backupGroup, settings: { ...backupGroup.settings, quiet_start: '29:99' } }] }));
assert.equal(validateBackup({ version: 1, groups: [backupGroup] })[0].chat_id, 'g_backup');
assert.ok(csv([['=1+1', '+2', '@SUM(A1)', 'safe']]).includes('"\'=1+1"'));
assert.equal(tehranDateTimeInput('2026-10-14T08:30:00.000Z'), '2026-10-14T12:00');
assert.equal(tehranInputToISO('2026-10-14T12:00'), '2026-10-14T08:30:00.000Z');
assert.throws(() => tehranInputToISO('2026-02-30T12:00'));
const catalog = JSON.parse(await readFile(new URL('../docs/feature-status.json', import.meta.url), 'utf8'));
assert.equal(catalog.features.length, 150);
assert.equal(new Set(catalog.features.map(feature => feature.id)).size, 150);
pass('HTTPS endpoint restrictions, invalid backups, spreadsheet formula escaping, and 150 unique catalog entries');
const rawGet = route => new Promise((resolve, reject) => http.get({ hostname: base.hostname, port: base.port, path: route }, response => { response.resume(); response.on('end', () => resolve(response)); }).on('error', reject));
for (const route of ['/', '/rubika_bot/']) {
  const response = await rawGet(route);
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'], /text\/html/);
}
for (const route of ['/../etc/passwd', '/%2e%2e/etc/passwd', '/rubika_bot/..%2f..%2fetc/passwd', '/.git/config', '/rubika_bot/%2egit/config']) assert.equal((await rawGet(route)).statusCode, 403);
assert.equal((await rawGet('/missing-resource.js')).statusCode, 404);
assert.equal((await fetch(base, { method: 'POST' })).status, 405);
pass('static documents, missing resources, traversal, hidden files, and unsupported methods');

const TOKEN_A = 'test-only-token-a-' + 'a'.repeat(48);
const TOKEN_B = 'test-only-token-b-' + 'b'.repeat(48);
const CAPABILITIES = { collections: true, messaging: true, polling: true, background: false, webhook: false, moderation: false, scheduling: false, rbac: false };
const fixtures = new Map([
  [TOKEN_A, { bot: { id: 'bot-a', bot_id: 'bot-a', name: 'ربات آزمون اول', username: 'test_bot_a' }, groups: [{ chat_id: 'g_fixture_initial', title: 'گروه آزمون <img src=x onerror="window.__xss=1">', type: 'group', settings: { active: false, anti_spam: true, rules: 'قانون اولیه', warn_limit: 3, custom_preserved_field: 'retain-me', locks: { link: false, future_lock: true } } }], collections: new Map() }],
  [TOKEN_B, { bot: { id: 'bot-b', bot_id: 'bot-b', name: 'ربات آزمون دوم', username: 'test_bot_b' }, groups: [], collections: new Map() }],
]);
const requests = [];
let failMessage = false;
let failureOutcome = null;
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/Los_Angeles', serviceWorkers: 'block', acceptDownloads: true });
const page = await context.newPage();
const exceptions = [];
page.on('pageerror', error => exceptions.push(error.message));
page.on('dialog', dialog => dialog.accept());
await context.route('**/functions/v1/rubika-panel', async route => {
  const request = route.request();
  if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' } });
  const body = request.postDataJSON();
  assert.ok(!request.url().includes(TOKEN_A) && !request.url().includes(TOKEN_B), 'Tokens must never appear in request URLs.');
  requests.push(body);
  const reply = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(data) });
  if (body.action === 'health') return reply({ ok: true, service: 'rubika-panel-test-fixture', capabilities: CAPABILITIES });
  const fixture = fixtures.get(body.token);
  if (!fixture) return reply({ ok: false, error: 'توکن آزمون نامعتبر است.' }, 401);
  switch (body.action) {
    case 'login': return reply({ ok: true, bot: fixture.bot, capabilities: CAPABILITIES });
    case 'list': return reply({ ok: true, groups: fixture.groups, capabilities: CAPABILITIES });
    case 'save': {
      const group = { chat_id: body.chat_id, title: body.title, type: body.type || 'group', settings: body.settings };
      fixture.groups = [...fixture.groups.filter(item => item.chat_id !== body.chat_id), group];
      return reply({ ok: true, group });
    }
    case 'delete': fixture.groups = fixture.groups.filter(group => group.chat_id !== body.chat_id); return reply({ ok: true });
    case 'collection_list': return reply({ ok: true, items: fixture.collections.get(body.collection) || [] });
    case 'collection_save': {
      const item = { id: body.id || `fixture-${requests.length}`, data: body.data, created_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z' };
      fixture.collections.set(body.collection, [...(fixture.collections.get(body.collection) || []).filter(existing => existing.id !== item.id), item]);
      return reply({ ok: true, item });
    }
    case 'collection_delete': fixture.collections.set(body.collection, (fixture.collections.get(body.collection) || []).filter(item => item.id !== body.id)); return reply({ ok: true });
    case 'logs': return reply({ ok: true, logs: [] });
    case 'poll':
      assert.equal(body.authorized, true);
      return reply({ ok: true, updates: [{ type: 'NewMessage', new_message: { chat_id: 'g_fixture_initial', message_id: 'fixture-update', text: 'رویداد آزمون' } }], next_offset_id: 'fixture-next-offset', received_at: '2026-10-14T08:30:00Z' });
    case 'message':
      assert.equal(body.authorized, true, 'Message requests require explicit destination authorization.');
      assert.match(body.operation_id, /^[a-f\d-]{36}$/i, 'Message requests need an operation identifier.');
      if (failMessage) return reply({ ok: false, code: 'RUBIKA_REJECTED', outcome: 'rejected', error: 'ارسال آزمون به دلیل خطای سرویس انجام نشد.' }, 502);
      if (failureOutcome) return reply({ ok: false, code: failureOutcome === 'confirmed_unrecorded' ? 'OPERATION_RECORDING_INCOMPLETE' : 'RUBIKA_UNAVAILABLE', outcome: failureOutcome, operation_id: body.operation_id, error: 'نتیجه آزمون نامشخص است.' }, 502);
      return reply({ ok: true, result: { message_id: `fixture-message-${requests.length}` } });
    default: return reply({ ok: false, error: `Unhandled test-fixture action: ${body.action}` }, 400);
  }
});

const nav = async route => {
  const button = page.locator(`#navigation [data-route="${route}"]`);
  if (await page.locator('#menuButton').isVisible() && !(await page.locator('#sidebar').getAttribute('class')).split(/\s+/).includes('open')) await page.locator('#menuButton').click();
  await button.click();
};
const login = async token => {
  await nav('bots');
  await page.locator('#token').fill(token);
  await page.locator('#loginBtn').click();
};
const storageHasSecrets = () => page.evaluate(([a, b]) => [localStorage, sessionStorage].some(storage => Array.from({ length: storage.length }, (_, index) => storage.getItem(storage.key(index))).some(value => value?.includes(a) || value?.includes(b))), [TOKEN_A, TOKEN_B]);
const noOverflow = async () => assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'Page must fit the viewport.');
try {
  await page.goto(base.href);
  await page.locator('#navigation [data-route="bots"]').waitFor();
  await noOverflow();
  assert.equal(await page.locator('html').getAttribute('lang'), 'fa');
  assert.equal(await page.locator('html').getAttribute('dir'), 'rtl');
  await page.screenshot({ path: path.join(artifacts, 'dashboard-empty.png'), fullPage: true });
  pass('Persian RTL application starts without a bot connection');

  await login('invalid-test-token');
  await page.getByText('توکن آزمون نامعتبر است.', { exact: true }).waitFor();
  assert.equal(await page.locator('#token').inputValue(), '');
  assert.equal(await page.locator('[data-select-bot]').count(), 0);
  pass('rejected login clears the token field and creates no session');

  await page.locator('#testConnection').click();
  await page.locator('#connectionStatus').filter({ hasText: /موفق|دسترس|برقرار/ }).waitFor();
  assert.equal(requests.find(request => request.action === 'health').token, undefined);
  pass('connection check runs without an authentication token');

  await login(TOKEN_A);
  await page.locator('[data-select-bot="bot-a"]').waitFor();
  await nav('groups');
  await page.locator('[data-group="g_fixture_initial"]').waitFor();
  assert.equal(await page.evaluate(() => window.__xss), undefined);
  assert.equal(await storageHasSecrets(), false);
  pass('successful authenticated load escapes server titles and keeps credentials out of storage');

  await page.locator('[data-group="g_fixture_initial"]').click();
  await page.locator('#configForm [name="rules"]').fill('قانون ویرایش‌شده آزمون');
  await page.locator('#configForm [name="warn_limit"]').fill('5');
  const saving = page.waitForResponse(response => response.request().postDataJSON()?.action === 'save' && response.request().postDataJSON()?.chat_id === 'g_fixture_initial');
  await page.locator('#saveSettings').click();
  await saving;
  await page.waitForFunction(() => document.querySelector('#saveSettings') && !document.querySelector('#saveSettings').disabled);
  const saved = fixtures.get(TOKEN_A).groups.find(group => group.chat_id === 'g_fixture_initial');
  assert.equal(saved.settings.rules, 'قانون ویرایش‌شده آزمون');
  assert.equal(saved.settings.warn_limit, 5);
  assert.equal(saved.settings.custom_preserved_field, 'retain-me');
  assert.equal(saved.settings.locks.future_lock, true);
  pass('group settings save real edits while preserving server extensions');

  const savesBeforeInvalid = requests.filter(request => request.action === 'save').length;
  await page.locator('#configForm [name="warn_limit"]').fill('0');
  await page.locator('#saveSettings').click();
  assert.equal(await page.locator('#configForm [name="warn_limit"]').evaluate(input => input.validity.rangeUnderflow), true);
  assert.equal(requests.filter(request => request.action === 'save').length, savesBeforeInvalid);
  await page.locator('#configForm [name="warn_limit"]').fill('5');
  pass('out-of-range group limits cannot be submitted');

  await page.locator('#addDestination').click();
  await page.locator('#newChat').fill('g_fixture_created');
  await page.locator('#newTitle').fill('مقصد آزمون ایجاد و حذف');
  await page.locator('#addGroupBtn').click();
  assert.equal(requests.filter(request => request.action === 'save').length, savesBeforeInvalid);
  await page.locator('#consent').check();
  const adding = page.waitForResponse(response => response.request().postDataJSON()?.action === 'save' && response.request().postDataJSON()?.chat_id === 'g_fixture_created');
  await page.locator('#addGroupBtn').click();
  await adding;
  await page.locator('[data-group="g_fixture_created"]').waitFor();
  await page.locator('#modal').waitFor({ state: 'hidden' });
  assert.ok(fixtures.get(TOKEN_A).groups.some(group => group.chat_id === 'g_fixture_created'));
  pass('destination creation requires authorization and saves the selected destination');

  await page.locator('#removeGroup').click();
  await page.locator('#cancelConfirm').click();
  assert.equal(requests.filter(request => request.action === 'delete').length, 0);
  await page.locator('#removeGroup').click();
  const removing = page.waitForResponse(response => response.request().postDataJSON()?.action === 'delete');
  await page.locator('#confirmAction').click();
  await removing;
  await page.locator('#modal').waitFor({ state: 'hidden' });
  assert.ok(!fixtures.get(TOKEN_A).groups.some(group => group.chat_id === 'g_fixture_created'));
  pass('destination deletion can be canceled and only runs after confirmation');

  await login(TOKEN_B);
  await page.locator('#accountName').filter({ hasText: 'ربات آزمون دوم' }).waitFor();
  await nav('groups');
  assert.equal(await page.locator('[data-group]').count(), 0);
  await page.locator('#connectionBanner [data-select-bot="bot-a"]').click();
  await page.locator('[data-group="g_fixture_initial"]').waitFor();
  assert.equal(await page.locator('#configForm [name="rules"]').inputValue(), 'قانون ویرایش‌شده آزمون');
  pass('multiple bots retain separate destinations and settings');

  await nav('messages');
  await page.locator('#messageForm').waitFor();
  await page.locator('#msg_text').fill('پیام آزمون <img src=x onerror="window.__preview_xss=1">');
  await page.locator('#previewMessage').click();
  assert.equal(await page.locator('#messagePreview img').count(), 0);
  await page.locator('#sendMessage').click();
  assert.equal(requests.filter(request => request.action === 'message').length, 0);
  await page.locator('#messageConsent').check();
  const sending = page.waitForResponse(response => response.request().postDataJSON()?.action === 'message');
  await page.locator('#sendMessage').click();
  await sending;
  await page.locator('#messageResult').filter({ hasText: 'fixture-message-' }).waitFor();
  const sent = requests.find(request => request.action === 'message');
  assert.equal(sent.token, TOKEN_A);
  assert.equal(sent.params.chat_id, 'g_fixture_initial');
  assert.equal(sent.method, 'sendMessage');
  pass('message preview stays text and authorized sends use the selected bot and destination');

  failMessage = true;
  await page.locator('#msg_text').fill('این ارسال باید خطا بدهد');
  const failing = page.waitForResponse(response => response.request().postDataJSON()?.action === 'message');
  await page.locator('#sendMessage').click();
  await failing;
  await page.locator('#messageError').filter({ hasText: 'روبیکا درخواست را رد کرد.' }).waitFor();
  assert.equal(await page.locator('#messageResult').textContent(), '');
  failMessage = false;
  pass('a failed message displays the server error and removes the previous success result');

  for (const outcome of ['unknown', 'confirmed_unrecorded']) {
    failureOutcome = outcome;
    await page.locator('#msg_text').fill(`آزمون حفاظت از ارسال تکراری ${outcome}`);
    const attempting = page.waitForResponse(response => response.request().postDataJSON()?.action === 'message');
    await page.locator('#sendMessage').click();
    await attempting;
    const attempt = requests.at(-1);
    await page.locator('#messageResult').filter({ hasText: attempt.operation_id }).waitFor();
    const attemptsBeforeRepeat = requests.filter(request => request.action === 'message').length;
    await page.locator('#sendMessage').click();
    assert.equal(requests.filter(request => request.action === 'message').length, attemptsBeforeRepeat);
    assert.ok((await page.locator('#messageResult').textContent()).includes(attempt.operation_id));
    await page.locator('#messageResult button').click();
    await page.locator('#confirmAction').click();
    await page.locator('#modal').waitFor({ state: 'hidden' });
    assert.equal(requests.filter(request => request.action === 'message').length, attemptsBeforeRepeat);
    assert.equal(await page.locator('#messageResult').textContent(), '');
  }
  failureOutcome = null;
  pass('unknown and confirmed-but-unrecorded attempts block duplicate sends until an explicit destination check');

  await page.locator('#messageMethod').selectOption('deleteMessage');
  await page.locator('#msg_message_id').fill('fixture-message-delete');
  const messagesBeforeCancel = requests.filter(request => request.action === 'message').length;
  await page.locator('#sendMessage').click();
  await page.locator('#cancelConfirm').click();
  assert.equal(requests.filter(request => request.action === 'message').length, messagesBeforeCancel);
  await page.locator('#sendMessage').click();
  const deletingMessage = page.waitForResponse(response => response.request().postDataJSON()?.method === 'deleteMessage');
  await page.locator('#confirmAction').click();
  await deletingMessage;
  await page.locator('#modal').waitFor({ state: 'hidden' });
  assert.equal(requests.at(-1).params.message_id, 'fixture-message-delete');
  pass('destructive message operations require a second confirmation');

  assert.equal(requests.filter(request => request.action === 'poll').length, 0);
  const polling = page.waitForResponse(response => response.request().postDataJSON()?.action === 'poll');
  await page.locator('#pollUpdates').click();
  await polling;
  await page.locator('#pollResult').filter({ hasText: 'fixture-update' }).waitFor();
  const pollingAgain = page.waitForResponse(response => response.request().postDataJSON()?.action === 'poll');
  await page.locator('#pollUpdates').click();
  await pollingAgain;
  assert.equal(requests.at(-1).offset_id, 'fixture-next-offset');
  assert.equal(requests.filter(request => request.action === 'poll').length, 2);
  pass('polling runs only on request and advances the server-provided offset');

  await nav('schedules');
  await page.locator('#addCollectionItem').waitFor();
  await page.locator('#addCollectionItem').click();
  await page.locator('#col_title').fill('زمان‌بندی آزمون به وقت تهران');
  await page.locator('#col_chat_id').selectOption('g_fixture_initial');
  await page.locator('#col_text').fill('این فقط پیش‌نویس است');
  await page.locator('#col_scheduled_at').fill('2026-10-14T12:00');
  const scheduling = page.waitForResponse(response => response.request().postDataJSON()?.action === 'collection_save');
  await page.locator('#saveCollection').click();
  await scheduling;
  await page.locator('#modal').waitFor({ state: 'hidden' });
  const schedule = fixtures.get(TOKEN_A).collections.get('schedules')[0];
  assert.equal(schedule.data.scheduled_at, '2026-10-14T08:30:00.000Z');
  assert.equal(schedule.data.status, 'draft');
  await page.locator(`[data-edit-item="${schedule.id}"]`).waitFor();
  await page.locator(`[data-edit-item="${schedule.id}"]`).click();
  assert.equal(await page.locator('#col_scheduled_at').inputValue(), '2026-10-14T12:00');
  await page.locator('#closeModal').click();
  pass('schedule drafts preserve Tehran time on a device configured for Los Angeles');

  await nav('settings');
  assert.equal(await page.locator('#endpointInput').isDisabled(), true);
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#backupSettings').click();
  const download = await downloadEvent;
  const backupPath = path.join(artifacts, 'settings-backup.json');
  await download.saveAs(backupPath);
  const exported = await readFile(backupPath, 'utf8');
  assert.ok(!exported.includes(TOKEN_A) && !exported.includes(TOKEN_B));
  assert.equal(JSON.parse(exported).groups[0].settings.rules, 'قانون ویرایش‌شده آزمون');
  await page.locator('#restoreFile').setInputFiles({ name: 'invalid-backup.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ version: 1, groups: [backupGroup, backupGroup] })) });
  await page.locator('#restoreSettings').click();
  await page.locator('#backupStatus').filter({ hasText: 'شناسه تکراری' }).waitFor();
  assert.equal(requests.filter(request => request.action === 'save').length, savesBeforeInvalid + 1);
  pass('backup excludes credentials, malformed restore has no side effects, and endpoint changes are locked during sessions');

  await page.locator('#featureLink').click();
  await page.locator('[data-feature-id="150"]').waitFor();
  assert.equal(await page.locator('[data-feature-id]').count(), 150);
  await page.locator('#featureSearch').fill('unmatched-test-search-value');
  assert.equal(await page.locator('[data-feature-id]:visible').count(), 0);
  await page.locator('#featureSearch').fill('');
  assert.equal(await page.locator('[data-feature-id]:visible').count(), 150);
  pass('the 150-feature audit loads and filters without inventing live verification');

  await nav('dashboard');
  await noOverflow();
  await page.screenshot({ path: path.join(artifacts, 'dashboard-desktop.png'), fullPage: true });
  await page.locator('#themeButton').click();
  assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark');
  await page.screenshot({ path: path.join(artifacts, 'dashboard-dark.png'), fullPage: true });
  await page.locator('#themeButton').click();

  await page.setViewportSize({ width: 390, height: 844 });
  await noOverflow();
  await page.locator('#menuButton').click();
  assert.equal(await page.locator('#menuButton').getAttribute('aria-expanded'), 'true');
  await nav('groups');
  assert.equal(await page.locator('#menuButton').getAttribute('aria-expanded'), 'false');
  await noOverflow();
  await page.screenshot({ path: path.join(artifacts, 'groups-mobile.png'), fullPage: true });
  await nav('dashboard');
  await noOverflow();
  await page.screenshot({ path: path.join(artifacts, 'dashboard-mobile.png'), fullPage: true });
  pass('desktop themes and mobile navigation render without horizontal overflow');

  await nav('bots');
  await page.locator('#page [data-logout-bot="bot-b"]').click();
  assert.equal(await page.locator('[data-select-bot="bot-b"]').count(), 0);
  assert.equal(await page.locator('#accountName').textContent(), 'ربات آزمون اول');
  await page.locator('#page [data-logout-bot="bot-a"]').click();
  assert.equal(await page.locator('[data-select-bot]').count(), 0);
  assert.equal(await page.locator('#accountName').textContent(), 'اتصال ربات');
  pass('logging out one bot keeps another usable and final logout removes the session');

  await login(TOKEN_A);
  await page.locator('#accountName').filter({ hasText: 'ربات آزمون اول' }).waitFor({ state: 'attached' });
  await page.reload();
  await page.locator('#navigation [data-route="bots"]').waitFor();
  assert.equal(await page.locator('[data-select-bot]').count(), 0);
  assert.equal(await page.locator('#accountName').textContent(), 'اتصال ربات');
  assert.equal(await storageHasSecrets(), false);
  assert.equal(exceptions.length, 0, exceptions.join('\n'));
  pass('refresh requires authentication again and all browser workflows produce no JavaScript exceptions');
} finally {
  await browser.close();
}
console.log(`${passed} browser/static regression checks passed. API calls were intercepted test fixtures; live service behavior is not covered.`);
