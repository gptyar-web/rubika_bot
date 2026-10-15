import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planInteraction, renderTemplate, safeRegex, validateAutomation, validateFlow,
  validateMenu, validateWorkHours, withinWorkHours,
} from '../supabase/functions/rubika-panel/lib/interactions.js';

const now = new Date('2026-10-15T08:30:00.000Z'); // Thursday 12:00 Tehran
const bot = { bot_id: 'b1', name: 'ربات نمونه' };
const chat = { chat_id: 'g1', title: 'گروه نمونه', settings: { rules: 'احترام به دیگران', rules_text: 'متن قدیمی', subscriptions: true } };
const approved = { enabled: true, authorized: true, status: 'approved', allowed_chat_ids: ['g1'] };
const rule = (changes = {}) => ({ id: 'r1', ...approved, match: 'keyword', trigger: 'سلام', response: 'سلام {user_id}', ...changes });
const flow = (changes = {}) => ({ id: 'f1', ...approved, title: 'فرم نمونه', command: '/form', session_ttl_minutes: 5, steps: [{ id: 's1', key: 'age', prompt: 'سن؟', validation: 'number' }, { id: 's2', key: 'email', prompt: 'ایمیل؟', validation: 'email' }, { id: 's3', key: 'option', prompt: 'گزینه؟', validation: 'choice', options: ['اول', 'دوم'] }], ...changes });
const menu = (changes = {}) => ({ id: 'm1', ...approved, title: 'فهرست', command: '/menu', items: Array.from({ length: 10 }, (_, n) => ({ id: `i${n}`, text: `گزینه ${n}`, response: `پاسخ ${n}` })), ...changes });
function plan(text, extra = {}) {
  return planInteraction({ bot, chat, now, message: { sender_type: 'User', sender_id: 'u1', text }, ...extra });
}
function callback(id, extra = {}) { return plan('', { ...extra, message: { sender_type: 'User', sender_id: 'u1', text: '', aux_data: { button_id: id } } }); }
const buttons = action => action.params.chat_keypad.rows.flatMap(row => row.buttons);

test('templates replace only allowlisted own scalar variables and preserve unknown placeholders', () => {
  const inherited = Object.assign(Object.create({ name: 'inherited' }), { user_id: 'u1', token: 'must-not-render', date: 123, time: { malicious: true } });
  assert.equal(renderTemplate('{name} {{user_id}} {token} {date} {time}', inherited), '{name} u1 {token} 123 {time}');
  assert.equal(renderTemplate('{name}', { name: 'a\0b' }), 'ab');
  assert.equal(renderTemplate('{name}', { name: 'x'.repeat(200) }).length, 160);
  assert.equal(renderTemplate('{name}', { name: '<img onerror=alert(1)>' }), '<img onerror=alert(1)>');
});

test('safe regex handles anchors, bounded and unbounded literal classes, Unicode and case sensitivity', () => {
  const cases = [
    ['^سلام[۰-۹]{2}$', 'سلام۱۲', true], ['^سلام[۰-۹]{2}$', 'سلام۱۲۳', false],
    ['^[a-z]+\\d?$', 'Abc2', true], ['^[a-z]+\\d?$', 'abc22', false],
    ['^[^0-9]{1,3}$', 'آب', true], ['^[^0-9]{1,3}$', 'آب1', false],
    ['\\shello\\s', '\thello\n', true], ['^colou?r$', 'color', true], ['^colou?r$', 'colour', true],
    ['^a*b+c$', 'bbbC', true], ['^a*b+c$', 'ba', false], ['ب', 'الف ب پ', true],
    ['^[😀-🙏]{1,2}$', '😀🙏', true], ['^a{0,2}$', '', true],
  ];
  for (const [pattern, value, expected] of cases) assert.equal(safeRegex(pattern).test(value), expected, `${pattern}: ${value}`);
  assert.equal(safeRegex('^ABC$', { caseSensitive: true }).test('abc'), false);
  assert.equal(safeRegex('^ABC$', { caseSensitive: true }).test('ABC'), true);
  assert.equal(safeRegex('a').test('a'.repeat(4097)), false);
  assert.equal(safeRegex('a').test(null), false);
});

test('regex rejects backtracking expressions and oversized automata before matching', () => {
  for (const pattern of ['(a+)+$', '(a|aa)+$', '(?=x)', '\\1', '.*', '[^a]+', '[z-a]', '[', '[]', 'a{2,1}', 'a{65}', 'a{1,}', 'a'.repeat(101), 'a{64}b{64}c{64}d{64}']) {
    assert.throws(() => safeRegex(pattern), undefined, pattern);
  }
  // A valid long nonmatch must stay in the finite-state matcher.
  const regex = safeRegex('^a+a+a+a+b$');
  assert.equal(regex.test('a'.repeat(4096)), false);
});

test('Tehran work hours are end-exclusive and overnight shifts retain their starting weekday', () => {
  const hours = { start: '22:00', end: '06:00', days: [3] }; // Wednesday night
  assert.equal(withinWorkHours(hours, '2026-10-14T18:29:59Z'), false);
  assert.equal(withinWorkHours(hours, '2026-10-14T18:30:00Z'), true);
  assert.equal(withinWorkHours(hours, '2026-10-15T01:00:00Z'), true);
  assert.equal(withinWorkHours(hours, '2026-10-15T02:30:00Z'), false);
  assert.equal(withinWorkHours(hours, '2026-10-15T18:30:00Z'), false);
  assert.equal(withinWorkHours({ start: '00:00', end: '00:00', days: [3] }, '2026-10-14T10:00:00Z'), true);
  assert.equal(withinWorkHours({ start: '09:00', end: '17:00', days: [3] }, now), false);
  for (const value of [{ start: '24:00', end: '06:00' }, { start: '9:00', end: '17:00' }, { start: '09:00', end: '17:00', days: [1, 1] }, { start: '09:00', end: '17:00', days: [] }]) assert.throws(() => validateWorkHours(value));
});

test('automations require enabled, authorized, approved and exact destination allowlist together', () => {
  assert.equal(plan('سلام', { automations: [rule()] }).actions[0].params.text, 'سلام u1');
  for (const change of [{ enabled: false }, { enabled: undefined }, { authorized: false }, { status: 'draft' }, { status: 'paused' }, { allowed_chat_ids: ['g2'] }, { allowed_chat_ids: [] }]) {
    assert.equal(plan('سلام', { automations: [rule(change)] }).actions.length, 0, JSON.stringify(change));
  }
  assert.throws(() => validateAutomation(rule({ authorized: false })));
  assert.throws(() => validateAutomation(rule({ allowed_chat_ids: ['g1', 'g1'] })));
  assert.equal(plan('سلام', { message: { sender_type: 'Bot', sender_id: 'u1', text: 'سلام' }, automations: [rule()] }).actions.length, 0);
});

test('commands, keyword priority, regex and templates select one valid response with outside-hours handling', () => {
  const command = rule({ match: 'command', trigger: '/hello', response: 'command {chat_title}' });
  assert.equal(plan('/HELLO anything', { automations: [command] }).actions[0].params.text, 'command گروه نمونه');
  assert.equal(plan('/hellooo', { automations: [command] }).actions.length, 0);
  assert.equal(plan('سلام', { automations: [rule({ id: 'low', response: 'low', priority: 1 }), rule({ id: 'high', response: 'high', priority: 2 })] }).actions[0].params.text, 'high');
  assert.equal(plan('۱۲۳', { automations: [rule({ match: 'regex', trigger: '^[۰-۹]{3}$', response: 'digits' })] }).actions[0].params.text, 'digits');
  assert.equal(plan('سلام', { automations: [rule({ response: undefined, template_id: 't1' })], templates: [{ id: 't1', data: { text: 'قالب {{bot_name}} {token}' } }] }).actions[0].params.text, 'قالب ربات نمونه {token}');
  const restricted = rule({ work_hours: { start: '09:00', end: '10:00' }, outside_response: 'تعطیل' });
  assert.equal(plan('سلام', { automations: [restricted] }).actions[0].params.text, 'تعطیل');
  assert.equal(plan('سلام', { automations: [{ ...restricted, outside_response: undefined }] }).actions.length, 0);
  assert.equal(plan('سلام', { automations: [rule({ match: 'regex', trigger: '(a+)+' })] }).warnings[0].code, 'INVALID_INTERACTION');
});

test('builtin help, rules and identity reflect only authorized resources and actual identifiers', () => {
  const result = plan('/help', { automations: [rule({ match: 'command', trigger: '/allowed' }), rule({ match: 'command', trigger: '/hidden', authorized: false })], flows: [flow()], menus: [menu()] });
  assert.match(result.actions[0].params.text, /\/allowed/); assert.match(result.actions[0].params.text, /\/form/); assert.match(result.actions[0].params.text, /\/menu/); assert.doesNotMatch(result.actions[0].params.text, /\/hidden/);
  assert.equal(plan('/rules').actions[0].params.text, 'احترام به دیگران');
  assert.equal(plan('/rules', { chat: { ...chat, settings: { rules_text: 'قانون قدیمی' } } }).actions[0].params.text, 'قانون قدیمی');
  assert.match(plan('/id').actions[0].params.text, /u1[\s\S]*g1/u);
});

test('flow definitions forbid credential fields, duplicate keys, invalid choices and TTL over fifteen minutes', () => {
  assert.equal(validateFlow(flow()).session_ttl_minutes, 5);
  for (const key of ['password', 'apiKey', 'api_key', 'secret', 'token', 'privatekey']) assert.throws(() => validateFlow(flow({ steps: [{ id: 's1', key, prompt: 'value', validation: 'text' }] })));
  assert.throws(() => validateFlow(flow({ session_ttl_minutes: 16 })));
  assert.throws(() => validateFlow(flow({ steps: [{ id: 's1', key: 'answer', prompt: 'value', validation: 'choice', options: ['one'] }] })));
  assert.throws(() => validateFlow(flow({ steps: [{ id: 's1', key: 'answer', prompt: 'value', validation: 'choice', options: ['one', 'one'] }] })));
  assert.throws(() => validateFlow(flow({ steps: [{ id: 's1', key: 'age', prompt: 'value', validation: 'text' }, { id: 's2', key: 'age', prompt: 'again', validation: 'text' }] })));
});

test('flow starts with explicit consent; button IDs, answers and completion remain scoped to its session', () => {
  const flows = [flow()];
  const started = plan('/form', { flows });
  assert.equal(started.session.stage, 'awaiting_consent'); assert.deepEqual(started.session.answers, {});
  assert.equal(started.actions[0].params.chat_keypad_type, 'New');
  assert.deepEqual(buttons(started.actions[0]).map(button => button.id), ['flow:f1:confirm', 'flow:f1:cancel']);
  const ignored = plan('99', { flows, session: started.session });
  assert.equal(ignored.completed_flow, undefined); assert.equal(ignored.session, undefined); assert.equal(ignored.actions[0].reason, 'flow_consent');
  const consented = callback('flow:f1:confirm', { flows, session: started.session });
  assert.equal(consented.session.consented, true); assert.equal(consented.session.step, 0);
  const first = plan('۲۵', { flows, session: consented.session });
  assert.deepEqual(first.session.answers, { age: 25 });
  const invalidEmail = plan('invalid@', { flows, session: first.session });
  assert.equal(invalidEmail.actions[0].reason, 'flow_invalid'); assert.equal(invalidEmail.session, undefined);
  const second = plan('person@example.com', { flows, session: first.session });
  assert.equal(callback('flow:OTHER:s3:1', { flows, session: second.session }).actions.length, 0);
  assert.equal(callback('flow:f1:s3:09', { flows, session: second.session }).actions.length, 0);
  const completed = callback('flow:f1:s3:1', { flows, session: second.session });
  assert.equal(completed.session.stage, 'completed'); assert.deepEqual(completed.completed_flow.answers, { age: 25, email: 'person@example.com', option: 'دوم' });
  assert.equal(completed.completed_flow.expires_at, started.session.expires_at);
  assert.equal(plan('extra text', { flows, session: completed.session }).actions.length, 0);
  assert.equal(plan('/cancel', { flows, session: completed.session }).session, null);
});

test('flow sessions cannot cross bot, chat or user boundaries, outlive fifteen minutes, or skip consent', () => {
  const flows = [flow()]; const started = plan('/form', { flows }).session;
  const session = callback('flow:f1:confirm', { flows, session: started }).session;
  for (const change of [{ bot_id: 'b2' }, { chat_id: 'g2' }, { user_id: 'u2' }, { expires_at: now.toISOString() }, { expires_at: new Date(+now + 16 * 60000).toISOString() }]) {
    const result = plan('25', { flows, session: { ...session, ...change } });
    assert.equal(result.actions.length, 0); assert.equal(result.completed_flow, undefined);
  }
  assert.equal(plan('25', { flows, session: { ...session, consented: false } }).session, null);
  assert.equal(plan('25', { flows: [flow({ enabled: false })], session }).actions[0].reason, 'flow_disabled');
});

test('flow answer validation rejects secret strings and corrupt persisted answers instead of copying them', () => {
  const flows = [flow({ steps: [{ id: 's1', key: 'answer', prompt: 'value', validation: 'text' }] })];
  const started = plan('/form', { flows }).session; const session = plan('/confirm', { flows, session: started }).session;
  for (const value of ['Bearer abcdefghijklmn', 'token=abcdef', 'password: value', 'x'.repeat(40), 'a'.repeat(32), 'eyJabcdefghijk.payload.signature', 'abc\0def']) assert.equal(plan(value, { flows, session }).actions[0].reason, 'flow_invalid', value);
  const stages = [flow()]; const first = plan('/confirm', { flows: stages, session: plan('/form', { flows: stages }).session }).session;
  const saved = plan('25', { flows: stages, session: first }).session;
  assert.equal(plan('person@example.com', { flows: stages, session: { ...saved, answers: { age: 'bad-number', token: 'secret' } } }).session, null);
});

test('menus require globally unique IDs and paginate only currently displayed choices', () => {
  assert.throws(() => validateMenu(menu({ items: [{ id: 'same', text: 'first', children: [{ id: 'same', text: 'nested', response: 'no' }] }] })));
  const menus = [menu()]; const first = plan('/menu', { menus });
  assert.equal(first.session.page, 0); assert.equal(first.actions[0].params.chat_keypad_type, 'New');
  const ids = buttons(first.actions[0]).map(button => button.id); assert.equal(new Set(ids).size, ids.length); assert.equal(ids.length, 10);
  assert.equal(callback('menu:m1:item:i9', { menus, session: first.session }).actions.length, 0);
  assert.equal(callback('menu:other:next', { menus, session: first.session }).actions.length, 0);
  const next = callback('menu:m1:next', { menus, session: first.session }); assert.equal(next.session.page, 1);
  assert.equal(callback('menu:m1:item:i9', { menus, session: next.session }).actions[0].params.text, 'پاسخ 9');
  assert.equal(callback('menu:m1:item:i0', { menus, session: next.session }).actions.length, 0);
  assert.equal(callback('menu:m1:prev', { menus, session: next.session }).session.page, 0);
  assert.equal(callback('menu:m1:close', { menus, session: next.session }).session, null);
});

test('nested menus support scoped back navigation and explicit typed fallback commands', () => {
  const menus = [menu({ items: [{ id: 'parent', text: 'شاخه', children: [{ id: 'leaf', text: 'برگ', response: 'پاسخ {user_id}' }] }] })];
  const first = plan('/menu', { menus }); const nested = plan('/choose parent', { menus, session: first.session });
  assert.deepEqual(nested.session.path, ['parent']); assert(buttons(nested.actions[0]).some(button => button.id === 'menu:m1:back'));
  assert.equal(plan('/choose leaf', { menus, session: nested.session }).actions[0].params.text, 'پاسخ u1');
  assert.deepEqual(plan('/back', { menus, session: nested.session }).session.path, []);
});

test('subscription changes require the exact explicit command and an enabled chat preference', () => {
  assert.equal(plan('subscribe').consent, undefined); assert.equal(plan('عضو شدن').consent, undefined);
  assert.deepEqual(plan('/subscribe').consent, { chat_id: 'g1', user_id: 'u1', subscribed: true, requested_at: now.toISOString() });
  assert.equal(plan('/unsubscribe').consent.subscribed, false);
  assert.equal(plan('/subscribe', { chat: { ...chat, settings: { subscriptions: false } } }).consent, undefined);
  assert.equal(plan('/subscribe', { chat: { ...chat, settings: { subscriptions: false } } }).actions[0].reason, 'subscription_disabled');
});
