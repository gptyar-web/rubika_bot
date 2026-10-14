// Optional integration check: creates and removes a disposable Docker PostgreSQL.
// No connection to the user's Supabase project and no real credentials are used.
import { execFile, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import assert from "node:assert/strict";

const execute = promisify(execFile);
const container = `rubika-panel-sql-test-${process.pid}`;
// Official image digest verified during development; Docker verifies artifact digests.
const image = "postgres:17-alpine@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24";
const scope = "a".repeat(64);
const psqlArgs = ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-At"];
const sql = input => execFileSync("docker", psqlArgs, { input, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
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
  const migration = readFileSync(new URL("../supabase/migrations/202610140001_control_pro.sql", import.meta.url), "utf8");
  sql(migration);
  sql(migration); // Reapplying is safe and does not delete existing data.
  assert.equal(sql("select count(*) from pg_class where relname like 'rubika_panel_v3_%' and relkind='r' and relrowsecurity;"), "7");
  assert.equal(sql("select has_table_privilege('anon','public.rubika_panel_v3_chats','select');"), "f");
  assert.equal(sql("select has_function_privilege('authenticated','public.rubika_panel_v3_claim_operation(text,uuid,text)','execute');"), "f");
  assert.throws(() => sql("set role anon; select * from public.rubika_panel_v3_bots;"));
  sql(`insert into public.rubika_panel_v3_bots(scope,bot_id,name) values ('${scope}','bot_test','Test');`);
  const rate = sql("set role service_role; select public.rubika_panel_v3_rate_limit('integration', 2); select public.rubika_panel_v3_rate_limit('integration', 2); select public.rubika_panel_v3_rate_limit('integration', 2);");
  assert.deepEqual(rate.split("\n").slice(-3), ["t", "t", "f"]);
  const claimSql = `set role service_role; select public.rubika_panel_v3_claim_operation('${scope}','11111111-1111-4111-8111-111111111111','requesthash');`;
  const parallel = await Promise.all(Array.from({ length: 10 }, () => execute("docker", [...psqlArgs, "-c", claimSql])));
  const operations = parallel.map(result => JSON.parse(result.stdout.trim().split("\n").at(-1)));
  assert.equal(operations.filter(operation => operation.claimed).length, 1);
  assert.equal(operations.filter(operation => operation.status === "pending").length, 10);
  sql(`set role service_role; update public.rubika_panel_v3_operations set status='success',result='{"message_id":"m1"}'::jsonb where scope='${scope}';`);
  const replay = JSON.parse(sql(claimSql).split("\n").at(-1));
  assert.equal(replay.claimed, false); assert.equal(replay.result.message_id, "m1");
  sql(`set role service_role; insert into public.rubika_panel_v3_events(scope,event_hash,type,occurred_at) values ('${scope}','event1','NewMessage',now()) on conflict do nothing; insert into public.rubika_panel_v3_events(scope,event_hash,type,occurred_at) values ('${scope}','event1','NewMessage',now()) on conflict do nothing;`);
  assert.equal(sql(`select count(*) from public.rubika_panel_v3_events where scope='${scope}';`), "1");
  console.log("PostgreSQL integration passed: repeatable migration, seven RLS tables, blocked public grants, atomic rate limits, concurrent operation claims, cached result and event deduplication.");
} finally {
  if (started) execFileSync("docker", ["rm", "-f", container], { stdio: "ignore" });
}
