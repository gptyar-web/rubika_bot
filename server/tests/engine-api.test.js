import test from 'node:test';
import assert from 'node:assert/strict';
import { engineFixture,event,NOW,CHAT } from './helpers/engine-fixture.js';
const MOD={active:true,moderation_enabled:true,moderation_authorized:true,locks:{link:true}};
test('manual engine requires permission, commits offsets after processing and never processes duplicate events twice',async()=>{
  const f=await engineFixture(MOD);f.setBatch([event('bad.example')]);assert.equal((await f.invoke({action:'engine_run'})).body.code,'PERMISSION_REQUIRED');
  const first=await f.invoke({action:'engine_run',authorized:true,limit:5});assert.equal(first.body.processed,1);assert.equal(first.body.actions,1);assert.equal((await f.store.getRuntime(f.scope)).offset_id,'next_1');
  const repeated=await f.invoke({action:'engine_run',authorized:true,limit:5});assert.equal(repeated.body.duplicates,1);assert.equal(f.calls.filter(c=>c.method==='deleteMessage').length,1);
});
test('pause is scoped per bot and rejects processing while allowing status reads',async()=>{
  const f=await engineFixture(MOD);assert.equal((await f.invoke({action:'engine_toggle',enabled:false})).body.enabled,false);assert.equal((await f.invoke({action:'engine_run',authorized:true})).body.code,'ENGINE_PAUSED');
  const status=await f.invoke({action:'engine_status'});assert.equal(status.body.runtime.enabled,false);assert.equal(status.body.worker_running,false);assert.equal((await f.invoke({action:'engine_toggle',enabled:true})).body.enabled,true);
});
test('worker heartbeat requires a live running lease, not merely code support',async()=>{
  const f=await engineFixture();await f.store.acquireLease(f.scope,'worker');await f.store.saveRuntime(f.scope,{status:'running'},'worker');assert.equal((await f.invoke({action:'engine_status'})).body.worker_running,true);await f.store.releaseLease(f.scope,'worker');f.runtime.get(f.scope).lease_until=new Date(NOW-1).toISOString();assert.equal((await f.invoke({action:'engine_status'})).body.worker_running,false);
});
test('resource activation rejects unsafe regex, unregistered targets and silent consent edits',async()=>{
  const f=await engineFixture();const rule={match:'regex',trigger:'(a+)+$',response:'x',enabled:true,authorized:true,status:'approved',allowed_chat_ids:[CHAT]};
  assert.equal((await f.invoke({action:'collection_save',collection:'automations',data:rule})).status,400);
  assert.equal((await f.invoke({action:'collection_save',collection:'automations',data:{...rule,match:'keyword',trigger:'hello',allowed_chat_ids:['not_registered']}})).status,400);
  assert.equal((await f.invoke({action:'collection_save',collection:'subscribers',data:{user_id:'u',subscribed:true}})).body.code,'CONSENT_READ_ONLY');
  assert.equal((await f.invoke({action:'save',chat_id:CHAT,title:'x',settings:{moderation_enabled:true,moderation_authorized:false}})).body.code,'PERMISSION_REQUIRED');
});
test('schedule approval requires a future time and a registered authorized destination',async()=>{
  const f=await engineFixture();const data={title:'x',chat_id:CHAT,text:'hello',scheduled_at:new Date(NOW+60000).toISOString(),status:'approved',enabled:true,authorized:true};
  assert.equal((await f.invoke({action:'collection_save',collection:'schedules',data:{...data,scheduled_at:new Date(NOW-1).toISOString()}})).status,400);
  assert.equal((await f.invoke({action:'collection_save',collection:'schedules',data:{...data,authorized:false}})).body.code,'PERMISSION_REQUIRED');
  assert.equal((await f.invoke({action:'collection_save',collection:'schedules',data})).status,200);
});
test('actual processed metrics are isolated and empty reports do not fabricate traffic',async()=>{
  const f=await engineFixture(MOD);const empty=await f.invoke({action:'reports'});assert.equal(empty.body.report.summary.received,0);f.setBatch([event('bad.example')]);await f.invoke({action:'engine_run',authorized:true});const report=await f.invoke({action:'reports',from:new Date(NOW-60000).toISOString(),to:new Date(NOW+60000).toISOString(),compare:true});assert.equal(report.body.report.summary.received,1);assert.equal(report.body.report.summary.warnings,1);assert.equal(report.body.report.previous.summary.received,0);
});
test('activation stamps are controlled by the server and historical messages stay unaffected',async()=>{
  const f=await engineFixture({});await f.invoke({action:'save',chat_id:CHAT,title:'x',settings:{...MOD,moderation_started_at:'2000-01-01T00:00:00Z'}});assert.equal((await f.db.getChat(f.scope,CHAT)).settings.moderation_started_at,new Date(NOW).toISOString());
});

test('reactivation after master pause or authorization withdrawal starts a new safe time boundary',async()=>{
  for(const previous of [{...MOD,active:false},{...MOD,moderation_authorized:false}]){
    const f=await engineFixture({...previous,moderation_started_at:'2026-10-01T00:00:00.000Z'});
    const saved=await f.invoke({action:'save',chat_id:CHAT,title:'x',settings:{...MOD,moderation_started_at:'2026-10-01T00:00:00.000Z'}});
    assert.equal(saved.status,200);assert.equal((await f.db.getChat(f.scope,CHAT)).settings.moderation_started_at,new Date(NOW).toISOString());
  }
});
