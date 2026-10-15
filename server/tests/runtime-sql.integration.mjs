// Optional disposable PostgreSQL test. Does not contact Supabase or Rubika.
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const execute = promisify(execFile);
const container = `rubika-runtime-sql-test-${process.pid}`;
const image = "postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24";
const args = ["exec", "-i", container, "psql", "-h", "127.0.0.1", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"];
const sql = input => execFileSync("docker", args, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const last = output => output.split("\n").at(-1);
const role = input => sql(`set role service_role; ${input}`);
const value = input => last(role(input));
const object = input => JSON.parse(value(input));
const literal = input => `'${String(input).replaceAll("'", "''")}'`;
const json = input => `${literal(JSON.stringify(input))}::jsonb`;
const a = "a".repeat(64), b = "b".repeat(64), hash = "c".repeat(64);
const schedule = "11111111-1111-4111-8111-111111111111";
const starts = new Date(Date.now() - 10800000).toISOString();
const next = new Date(Date.parse(starts) + 3600000).toISOString();
const makePlan = extra => ({ status: "approved", enabled: true, authorized: true, scheduled_at: starts,
  chat_ids: ["chat_a", "chat_b"], text: "A private configured template", recurrence: { interval_minutes: 60, max_occurrences: 3 }, ...extra });
let plan = makePlan();
const claimSQL = (scope = a, destination = "chat_a", occurrence = starts, snapshot = plan, id = schedule, contentHash = hash) =>
  `select public.rubika_panel_v3_claim_schedule(${literal(scope)},${literal(id)},${literal(occurrence)},${literal(destination)},${json(snapshot)},${literal(contentHash)});`;
const putPlan = (data, id = schedule, scope = a) => role(`insert into public.rubika_panel_v3_resources(scope,collection,id,data)
  values (${literal(scope)},'schedules',${literal(id)},${json(data)}) on conflict(scope,collection,id) do update set data=excluded.data;`);
const finish = (operation, status = "success", scope = a) => value(`select public.rubika_panel_v3_finish_schedule(${literal(scope)},${literal(operation)},${literal(status)});`);
const parallel = async queries => (await Promise.all(queries.map(query => execute("docker", [...args, "-c", `set role service_role; ${query}`])))).map(result => JSON.parse(last(result.stdout.trim())));
let started = false;

try {
  execFileSync("docker", ["run", "--rm", "-d", "--name", container, "-e", "POSTGRES_PASSWORD=disposable-test-only", image], { stdio: ["ignore", "pipe", "inherit"] });
  started = true;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { sql("select 1;"); break; } catch {
      if (attempt === 59) throw Error("PostgreSQL did not become ready.");
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  sql("create role anon; create role authenticated; create role service_role bypassrls; grant usage on schema public to service_role;");
  for (let pass = 0; pass < 2; pass++) for (const file of ["202610140001_control_pro.sql", "202610140002_runtime.sql", "202610150003_interactions.sql"])
    sql(readFileSync(new URL(`../supabase/migrations/${file}`, import.meta.url), "utf8"));
  assert.equal(sql("select count(*) from pg_class where relname like 'rubika_panel_v3_%' and relkind='r' and relrowsecurity;"), "12");
  for (const table of ["runtime", "runtime_events", "user_state", "schedule_jobs", "sessions"]) {
    assert.equal(sql(`select has_table_privilege('anon','public.rubika_panel_v3_${table}','select');`), "f");
    assert.equal(sql(`select has_table_privilege('authenticated','public.rubika_panel_v3_${table}','insert');`), "f");
    assert.throws(() => sql(`set role authenticated; select * from public.rubika_panel_v3_${table};`));
  }
  for (const signature of ["set_enabled(text,boolean)", "acquire_lease(text,text,integer)", "release_lease(text,text)", "save_runtime(text,text,jsonb)", "claim_event(text,text,jsonb)", "finish_event(text,text,text,jsonb)", "claim_schedule(text,uuid,timestamptz,text,jsonb,text)", "finish_schedule(text,uuid,text,text)"])
    assert.equal(sql(`select has_function_privilege('anon','public.rubika_panel_v3_${signature}','execute');`), "f");
  role(`insert into public.rubika_panel_v3_bots(scope,bot_id,name) values ('${a}','bot_a','A'),('${b}','bot_b','B');
    insert into public.rubika_panel_v3_chats(scope,chat_id,title,type) values
    ('${a}','chat_a','A','group'),('${a}','chat_b','B','channel'),('${a}','chat_other','Other','group'),('${b}','chat_a','Other scope','group');`);

  role(`insert into public.rubika_panel_v3_resources(scope,collection,id,data) values ('${a}','commands','33333333-3333-4333-8333-333333333333','{"trigger":"/hello","response":"test"}');`);
  assert.equal(value(`select count(*) from public.rubika_panel_v3_resources where scope='${a}' and collection='commands';`),"1");
  const leases = await parallel(Array.from({ length: 8 }, (_, index) => `select public.rubika_panel_v3_acquire_lease('${a}','worker_${index}',60);`));
  assert.equal(leases.filter(lease => lease.acquired).length, 1);
  const winner = `worker_${leases.findIndex(lease => lease.acquired)}`;
  assert.equal(object(`select public.rubika_panel_v3_acquire_lease('${b}','worker_b',60);`).acquired, true);
  assert.equal(object(`select public.rubika_panel_v3_acquire_lease('${a}','${winner}',90);`).acquired, true);
  assert.equal(value(`select public.rubika_panel_v3_release_lease('${b}','${winner}');`), "f");
  assert.equal(value(`select public.rubika_panel_v3_release_lease('${a}','other_worker');`), "f");
  assert.throws(() => role(`select public.rubika_panel_v3_acquire_lease('${a}',null,60);`));
  assert.throws(() => role(`select public.rubika_panel_v3_acquire_lease('${a}','worker',null);`));
  assert.throws(() => role(`select public.rubika_panel_v3_save_runtime('${a}','other_worker','{"offset_id":"bad"}');`));
  assert.throws(() => role(`select public.rubika_panel_v3_save_runtime('${a}',null,'{"offset_id":"bad"}');`));
  assert.equal(value(`select public.rubika_panel_v3_save_runtime('${a}','${winner}','{"offset_id":"offset_1","status":"running"}');`), "t");
  assert.equal(value(`select public.rubika_panel_v3_set_enabled('${a}',false);`), "t");
  assert.equal(value(`select enabled from public.rubika_panel_v3_runtime where scope='${a}';`), "f");
  assert.equal(value(`select enabled from public.rubika_panel_v3_runtime where scope='${b}';`), "t");
  assert.equal(value(`select lease_owner || ':' || offset_id || ':' || status from public.rubika_panel_v3_runtime where scope='${a}';`), `${winner}:offset_1:paused`);
  assert.equal(object(`select public.rubika_panel_v3_acquire_lease('${a}','${winner}',60);`).acquired, true);
  role(`select public.rubika_panel_v3_save_runtime('${a}','${winner}','{"status":"running"}');`);
  assert.throws(() => role(`select public.rubika_panel_v3_save_runtime('${a}','${winner}','{"offset_id":"advanced_while_paused"}');`));
  assert.equal(value(`select status from public.rubika_panel_v3_runtime where scope='${a}';`), "paused");
  assert.throws(() => sql(`set role authenticated; select public.rubika_panel_v3_set_enabled('${a}',true);`));
  assert.throws(() => role(`select public.rubika_panel_v3_set_enabled('${a}',null);`));
  assert.equal(value(`select public.rubika_panel_v3_set_enabled('${a}',true);`), "t");
  role(`update public.rubika_panel_v3_runtime set lease_until=now()-interval '1 second' where scope='${a}';`);
  assert.equal(object(`select public.rubika_panel_v3_acquire_lease('${a}','recovery',60);`).acquired, true);
  assert.equal(value(`select public.rubika_panel_v3_release_lease('${b}','worker_b');`), "t");
  assert.equal(value(`select public.rubika_panel_v3_save_runtime('${b}',null,'{}');`), "t");
  assert.equal(value(`select public.rubika_panel_v3_release_lease('${a}','recovery');`), "t");

  const events = await parallel(Array.from({ length: 8 }, () => `select public.rubika_panel_v3_claim_event('${a}','event_1','{"type":"NewMessage","chat_id":"chat_a"}');`));
  assert.equal(events.filter(event => event.claimed).length, 1);
  assert.equal(object(`select public.rubika_panel_v3_claim_event('${b}','event_1','{}');`).claimed, true);
  assert.equal(value(`select public.rubika_panel_v3_finish_event('${a}','event_1','unknown','{"actions":1}');`), "t");
  assert.equal(value(`select public.rubika_panel_v3_finish_event('${a}','event_1','success','{}');`), "f");
  assert.equal(object(`select public.rubika_panel_v3_claim_event('${a}','event_1','{}');`).status, "unknown");
  assert.throws(() => role(`update public.rubika_panel_v3_runtime_events set status='success' where scope='${a}';`));
  for (const key of ["token", "bot_token", "nestedSecret", "api_key", "credentials", "raw", "message_body"])
    assert.equal(value(`select public.rubika_panel_v3_safe_runtime_json(${json({ [key]: "hidden" })});`), "f");
  assert.throws(() => role(`select public.rubika_panel_v3_claim_event('${a}','event_unsafe','{"text":"body"}');`));
  assert.equal(value("select public.rubika_panel_v3_safe_session('{\"kind\":\"flow\",\"consented\":false,\"answers\":{\"name\":\"N\"}}');"), "f");
  assert.equal(value("select public.rubika_panel_v3_safe_session('{\"kind\":\"flow\",\"consented\":true,\"answers\":{\"name\":\"N\"}}');"), "t");
  assert.equal(value("select public.rubika_panel_v3_safe_session('{}');"), "f");
  assert.throws(() => role(`insert into public.rubika_panel_v3_sessions(scope,chat_id,user_id,data,expires_at) values ('${a}','chat_a','user_1','{"kind":"flow"}',now()+interval '16 minutes');`));

  putPlan(plan);
  assert.equal(value(`select public.rubika_panel_v3_set_enabled('${a}',false);`), "t");
  assert.equal(object(claimSQL()).status, "blocked");
  assert.equal(value(`select public.rubika_panel_v3_set_enabled('${a}',true);`), "t");
  assert.equal(object(claimSQL(a, "chat_other")).status, "blocked"); // Registered, but not an approved destination.
  assert.equal(object(claimSQL(a, "chat_a", new Date(Date.parse(starts) + 1000).toISOString())).status, "blocked");
  assert.equal(object(claimSQL(a, "chat_a", "infinity")).status, "blocked");
  assert.equal(object(claimSQL(a, "chat_a", next)).status, "blocked"); // Cannot skip occurrence zero.
  assert.equal(object(claimSQL(b)).status, "blocked");
  assert.equal(object(claimSQL(a, "chat_a", starts, { ...plan, text: "Edited after listing" })).status, "blocked");
  const claims = await parallel(Array.from({ length: 8 }, (_, index) => claimSQL(a, index % 2 ? "chat_a" : "chat_b")));
  assert.equal(claims.filter(claim => claim.claimed).length, 1); // Across different destinations as well.
  const first = claims.find(claim => claim.claimed);
  const firstDestination = value(`select destination from public.rubika_panel_v3_schedule_jobs where operation_id='${first.operation_id}';`);
  const secondDestination = firstDestination === "chat_a" ? "chat_b" : "chat_a";
  const replay = object(claimSQL(a, firstDestination));
  assert.equal(replay.claimed, false); assert.equal(replay.operation_id, first.operation_id); assert.equal(replay.status, "pending");
  assert.equal(object(claimSQL(a, secondDestination)).status, "pending");
  assert.equal(finish(first.operation_id, "success", b), "f");
  assert.equal(finish(first.operation_id), "t");
  assert.equal(finish(first.operation_id, "unknown"), "f");
  assert.throws(() => role(`update public.rubika_panel_v3_schedule_jobs set status='unknown' where operation_id='${first.operation_id}';`));
  assert.throws(() => role(`update public.rubika_panel_v3_schedule_jobs set destination='chat_other' where operation_id='${first.operation_id}';`));
  const second = object(claimSQL(a, secondDestination));
  assert.equal(second.claimed, true); assert.notEqual(second.operation_id, first.operation_id);
  assert.equal(finish(second.operation_id), "t");
  const recurrence = object(claimSQL(a, "chat_a", next));
  assert.equal(recurrence.claimed, true); assert.notEqual(recurrence.operation_id, first.operation_id);
  assert.equal(finish(recurrence.operation_id, "unknown"), "t");
  assert.equal(object(claimSQL(a, "chat_b", next)).status, "unknown");
  assert.equal(object(claimSQL(a, "chat_a", new Date(Date.parse(next) + 3600000).toISOString())).status, "unknown");
  assert.equal(object(claimSQL(a, "chat_a", next)).operation_id, recurrence.operation_id);
  assert.equal(value(`select count(*) from public.rubika_panel_v3_schedule_jobs where scope='${a}' and schedule_id='${schedule}';`), "3");
  assert.equal(value(`select count(*) from public.rubika_panel_v3_schedule_jobs where snapshot_hash ~ '^[0-9a-f]{64}$';`), "3");

  plan = { ...plan, text: "New template after first delivery", chat_ids: ["chat_a", "chat_other"] };
  putPlan(plan);
  // Caller cannot disguise an edited schedule by reusing the old caller-provided hash.
  assert.equal(object(claimSQL(a, "chat_other")).status, "blocked");
  assert.equal(object(claimSQL(a, "chat_a", next)).status, "blocked");
  const freshId = "22222222-2222-4222-8222-222222222222";
  const malformed = [
    makePlan({ status: undefined }), makePlan({ enabled: undefined }), makePlan({ authorized: undefined }),
    makePlan({ status: "draft" }), makePlan({ enabled: false }), makePlan({ authorized: false }),
    makePlan({ chat_ids: ["chat_a", "chat_a"] }), makePlan({ chat_ids: ["unregistered"] }),
    makePlan({ scheduled_at: "2026-02-31T00:00:00Z" }), makePlan({ recurrence: { interval_minutes: 59, max_occurrences: 3 } }),
    makePlan({ recurrence: { interval_minutes: 60, max_occurrences: 367 } }), makePlan({ recurrence: { interval_minutes: "60", max_occurrences: 3 } }),
    makePlan({ method: "deleteMessage" }), makePlan({ method: "forwardMessage", params: { from_chat_id: "unregistered", message_id: "m1" } }),
  ];
  for (const invalid of malformed) {
    putPlan(invalid, freshId);
    assert.equal(object(claimSQL(a, "chat_a", starts, invalid, freshId)).status, "blocked");
  }
  const fresh = makePlan({ recurrence: null, chat_ids: ["chat_a"] });
  putPlan(fresh, freshId);
  const freshClaim = object(claimSQL(a, "chat_a", starts, fresh, freshId));
  assert.equal(freshClaim.claimed, true);
  assert.throws(() => role(`select public.rubika_panel_v3_finish_schedule('${a}','${freshClaim.operation_id}','rejected','arbitrary message body');`));
  assert.equal(finish(freshClaim.operation_id, "rejected"), "t");
  assert.equal(object(claimSQL(a, "chat_a", starts, fresh, freshId)).status, "rejected");
  assert.equal(value(`select count(*) from public.rubika_panel_v3_schedule_jobs where scope='${a}';`), "4");
  // Reapplying the migration also preserves every already claimed outcome.
  sql(readFileSync(new URL("../supabase/migrations/202610140002_runtime.sql", import.meta.url), "utf8"));
  assert.equal(value(`select count(*) from public.rubika_panel_v3_schedule_jobs where scope='${a}';`), "4");
  assert.equal(object(claimSQL(a, "chat_a", starts, fresh, freshId)).operation_id, freshClaim.operation_id);
  console.log("Runtime PostgreSQL integration passed: repeatable migrations, 12 private RLS tables, isolated scopes, concurrent leases/events/destinations, immutable outcomes, consent constraints, exact approved snapshot/occurrence/destination validation, stable operation UUIDs, recurrence ordering and permanent unknown-result halting.");
} finally {
  if (started) execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
}
