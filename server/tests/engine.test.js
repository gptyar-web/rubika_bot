import test from 'node:test';
import assert from 'node:assert/strict';
import { processBatch,evaluateModeration,isQuiet,dispatchOperation,operationId } from '../supabase/functions/rubika-panel/lib/engine.js';
import { ApiError } from '../supabase/functions/rubika-panel/lib/validation.js';
import { engineFixture,event,TOKEN,NOW,CHAT } from './helpers/engine-fixture.js';
const active={active:true,moderation_enabled:true,moderation_authorized:true,anti_spam:false,locks:{link:true}};
const run=(fixture,updates)=>processBatch({...fixture,updates,now:NOW});

test('moderation requires all explicit activation gates and never infers API administrator roles',async()=>{
  for(const settings of [{...active,active:false},{...active,moderation_enabled:false},{...active,moderation_authorized:false},{...active,admin_exceptions:'u_test'}]){
    const f=await engineFixture(settings);const r=await run(f,[event('https://bad.example')]);assert.equal(r.actions,0);assert.equal(f.calls.length,0);
  }
  const f=await engineFixture(active);const r=await run(f,[event('https://bad.example')]);assert.equal(r.actions,1);assert.equal(f.calls[0].method,'deleteMessage');assert.equal(f.resources.values().next().value.data.source,'engine');
});
test('content rules distinguish allowed subdomains and supported metadata without guessing media types',async()=>{
  const settings={...active,allowed_domains:'example.com',locks:{link:true,sticker:true,contact:true,photo:true}};
  const allowed=await evaluateModeration({message:event('https://sub.example.com').new_message,settings,now:NOW});assert.deepEqual(allowed.violations,[]);
  const blocked=await evaluateModeration({message:event('https://example.com.evil.net', 'm1',{sticker:{sticker_id:'s1'},contact_message:{phone_number:'not-stored'},file:{file_id:'image_guess.png'}}).new_message,settings,now:NOW});
  assert.deepEqual(blocked.violations,['link','sticker','contact']);
});
test('quiet windows use Tehran time including midnight and repeated hashes never store message bodies',async()=>{
  assert.equal(isQuiet({quiet_enabled:true,quiet_start:'23:00',quiet_end:'07:00'},Date.parse('2026-10-15T21:00:00Z')),true);
  assert.equal(isQuiet({quiet_enabled:true,quiet_start:'23:00',quiet_end:'07:00'},NOW),false);
  const settings={...active,anti_spam:true,flood_count:2,flood_seconds:8,locks:{}};let state={};
  for(let n=0;n<3;n++){const r=await evaluateModeration({message:event('a private message').new_message,settings,state,now:NOW+n*1000});state=r.state;if(n===2)assert.deepEqual(r.violations,['flood','repeated']);}
  const callbackMessage=event('', 'button_message',{aux_data:{button_id:'menu:repeat'}}).new_message;
  const click1=await evaluateModeration({message:callbackMessage,settings,state:{},now:NOW});const click2=await evaluateModeration({message:callbackMessage,settings,state:click1.state,now:NOW+1000});assert(!click2.violations.includes('repeated'));
  assert(!JSON.stringify(state).includes('private'));assert.equal(state.recent_hashes[0].hash.length,64);
});
test('permanent event and operation claims prevent duplicate deletions and warning increments',async()=>{
  const f=await engineFixture({...active,warning_enabled:true});const first=await run(f,[event('bad.example')]);const second=await run(f,[event('bad.example')]);
  assert.equal(first.actions,2);assert.equal(second.duplicates,1);assert.equal(f.calls.filter(c=>c.method==='deleteMessage').length,1);assert.equal([...f.states.values()][0].warning_count,1);
});
test('unknown upstream results are terminal and do not trigger an automatic resend',async()=>{
  const f=await engineFixture(active);f.adapter.call=async()=>{f.calls.push({method:'deleteMessage'});throw new ApiError(502,'RUBIKA_UNAVAILABLE','private URL must not escape',{outcome:'unknown'});};
  const first=await run(f,[event('bad.example')]);assert.equal(first.errors,1);assert.equal(first.results[0].status,'unknown');await run(f,[event('bad.example')]);assert.equal(f.calls.length,1);
});
test('commands execute only with destination authorization and preserve no raw received message',async()=>{
  const f=await engineFixture({active:true,automation_enabled:true,automation_authorized:true,rules:'قانون واقعی'});const r=await run(f,[event('/rules')]);assert.equal(r.actions,1);assert.equal(f.calls[0].params.text,'قانون واقعی');
  assert.equal([...f.events.values()][0].summary.command,'/rules');assert(!JSON.stringify([...f.events.values()]).includes('قانون واقعی'));
});
test('messages before activation do not apply newly enabled rules, bot echoes and token IDs are ignored',async()=>{
  const f=await engineFixture({...active,moderation_started_at:new Date(NOW+1).toISOString()});const r=await run(f,[event('bad.example'),event('bad.example','m2',{sender_type:'Bot'}),event('bad.example',TOKEN)]);assert.equal(r.actions,0);assert.equal(r.skipped,2);assert(!JSON.stringify([...f.events.values()]).includes(TOKEN));
});
test('withdrawal and cancel work even when replies are disabled and text is locked',async()=>{
  const f=await engineFixture({...active,locks:{text:true},automation_enabled:false,automation_authorized:false});await f.store.saveSession(f.scope,CHAT,'u_test',{kind:'flow',answers:{email:'private@example.com'},consented:true});
  await run(f,[event('/cancel')]);assert.equal(f.sessions.size,0);await run(f,[event('/unsubscribe','m2')]);assert.equal([...f.resources.values()][0].data.subscribed,false);assert.equal(f.calls.length,0);
});
test('unregistered destinations and plugin plans cannot dispatch unrelated mutations',async()=>{
  const f=await engineFixture(active);const unknown=event('bad.example');unknown.chat_id='not_registered';const r=await run(f,[unknown]);assert.equal(r.skipped,1);assert.equal(f.calls.length,0);
  const sent=await dispatchOperation({...f,method:'sendMessage',params:{chat_id:'not_registered',text:'x'},operation_id:await operationId('test'),authorized:true});assert.equal(sent.status,'blocked');assert.equal(f.calls.length,0);
});
test('failure to persist event accounting prevents cursor-safe completion',async()=>{
  const f=await engineFixture(active);f.store.finishEvent=async()=>{throw Error('storage failure');};await assert.rejects(run(f,[event('bad.example')]),/storage failure/);assert.equal(f.calls.length,1);
});

test('master destination switch disables automatic replies while retaining withdrawal controls',async()=>{
  const f=await engineFixture({active:false,automation_enabled:true,automation_authorized:true,rules:'real rules'});
  const r=await run(f,[event('/help')]);assert.equal(r.actions,0);assert.equal(f.calls.length,0);
});
test('a matching cancel callback clears consented answers before text locks and anti-spam',async()=>{
  const f=await engineFixture({...active,locks:{text:true},anti_spam:true,automation_enabled:false,automation_authorized:false});
  await f.store.saveSession(f.scope,CHAT,'u_test',{kind:'flow',flow_id:'form_1',stage:'answering',answers:{email:'private@example.com'},consented:true});
  const r=await run(f,[event('لغو فرم','cancel_button',{aux_data:{button_id:'flow:form_1:cancel'}})]);
  assert.equal(f.sessions.size,0);assert.equal(r.actions,0);assert.equal(f.calls.length,0);
});
