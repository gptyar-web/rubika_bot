import "fake-indexeddb/auto";
import test from "node:test";
import assert from "node:assert/strict";
import { Vault, openEnvelope } from "../js/vault.js";
const password = "storage test passphrase 2026";
test("persistent encrypted vault: create, reload, wrong password, backup, change password, restore and lease", async () => {
  const first = new Vault();
  await first.create(password);
  first.state.bots.push({
    id: "bot",
    name: "بات",
    token: "SYNTHETIC_PERSISTED_TOKEN",
  });
  await first.save();
  const e = await first.backup();
  assert(!JSON.stringify(e).includes("SYNTHETIC_PERSISTED_TOKEN"));
  const reload = new Vault();
  await assert.rejects(reload.unlock("wrong"));
  await reload.unlock(password);
  assert.equal(reload.state.bots[0].token, "SYNTHETIC_PERSISTED_TOKEN");
  reload.state.settings.panelName = "فضای کار دوم";
  await reload.save();
  first.state.settings.panelName = "stale";
  await assert.rejects(first.save(), /زبانهٔ دیگری/);
  assert.equal(
    (await openEnvelope(await reload.read(), password)).state.settings
      .panelName,
    "فضای کار دوم",
  );
  await reload.changePassword(password, "new storage test passphrase");
  await reload.lock();
  assert.equal(reload.state, null);
  assert.equal(reload.key, null);
  await assert.rejects(reload.unlock(password));
  await reload.unlock("new storage test passphrase");
  await reload.restore(JSON.stringify(e), password);
  assert.equal(reload.state.bots[0].token, "SYNTHETIC_PERSISTED_TOKEN");
  await reload.lock();
  await reload.unlock(password);
  assert.equal(reload.state.bots.length, 1);
  await assert.rejects(reload.restore('{"format":"invalid"}', password));
  assert.equal(reload.state.bots.length, 1);
});
