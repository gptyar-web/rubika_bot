import test from "node:test";
import assert from "node:assert/strict";
import { createDatabase } from "../supabase/functions/rubika-panel/lib/database.js";

const key = "TEST_PRIVATE_SERVICE_ROLE_KEY";
const scope = "a".repeat(64);

test("PostgREST uses private authentication and scopes every resource lookup", async () => {
  const calls = [];
  const database = createDatabase({ url: "https://example.supabase.co", key, fetcher: async (url, options) => {
    calls.push({ url: new URL(url), options });
    return Response.json([]);
  } });
  await database.listChats(scope);
  await database.getChat(scope, "g1");
  await database.listResources(scope, "drafts", { limit: 20, offset: 10 });
  await database.deleteResource(scope, "drafts", "11111111-1111-4111-8111-111111111111");
  for (const { url, options } of calls) {
    assert.equal(url.searchParams.get("scope"), `eq.${scope}`);
    assert.equal(options.headers.Authorization, `Bearer ${key}`);
    assert.equal(options.redirect, "error");
  }
  assert.equal(calls[2].url.searchParams.get("collection"), "eq.drafts");
  assert.equal(calls[2].url.searchParams.get("offset"), "10");
  assert.equal(calls[3].options.method, "DELETE");
});

test("database infrastructure errors do not expose credentials or internals", async () => {
  const database = createDatabase({ url: "https://example.supabase.co", key, fetcher: async () => Response.json({ message: key, hint: "private schema detail" }, { status: 500 }) });
  await assert.rejects(database.listChats(scope), error => error.code === "DATABASE_UNAVAILABLE" && !error.message.includes(key) && !error.message.includes("schema detail"));
  assert.throws(() => createDatabase({ url: "http://external.example", key }), { code: "CONFIGURATION_REQUIRED" });
});
