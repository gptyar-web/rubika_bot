import { ApiError, assert, identifier, safeData, uuid } from './validation.js';
import { buildMessage, destinations } from './adapter.js';
import { planInteraction, renderTemplate, safeRegex } from './interactions.js';

export const SUPPORTED_LOCKS = Object.freeze(['link','username','hashtag','text','profanity','forward','file','sticker','location','contact','mention','poll']);
const encoder = new TextEncoder();
export async function hash(value) {
  const bytes = await crypto.subtle.digest('SHA-256', encoder.encode(typeof value === 'string' ? value : stable(value)));
  return [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2,'0')).join('');
}
export function stable(value) {
  if (Array.isArray(value)) return '['+value.map(stable).join(',')+']';
  if (value && typeof value === 'object') return '{'+Object.keys(value).sort().map(key=>JSON.stringify(key)+':'+stable(value[key])).join(',')+'}';
  return JSON.stringify(value);
}
export async function operationId(seed) {
  const hex = await hash(seed);const bytes=Uint8Array.from(hex.slice(0,32).match(/../g),part=>parseInt(part,16));
  bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;
  const value=[...bytes].map(byte=>byte.toString(16).padStart(2,'0')).join('');
  return `${value.slice(0,8)}-${value.slice(8,12)}-${value.slice(12,16)}-${value.slice(16,20)}-${value.slice(20)}`;
}

// Mutations are claimed BEFORE dispatch. A pending/unknown operation is never resent.
export async function dispatchOperation({scope,token,method,params,operation_id,db,adapter,authorized=false}) {
  assert(authorized === true,'Explicit destination authorization is required.','PERMISSION_REQUIRED');
  const input=buildMessage(method,params);safeData(input,token);uuid(operation_id,'operation_id');
  for(const chatId of destinations(method,input)) {
    if(!await db.getChat(scope,chatId))return{status:'blocked',error_code:'DESTINATION_NOT_REGISTERED',operation_id};
  }
  const requestHash=await hash({method,params:input});
  const operation=await db.claimOperation(scope,operation_id,requestHash);
  if(!operation.claimed) {
    if(operation.request_hash!==requestHash)return{status:'blocked',error_code:'OPERATION_CONFLICT',operation_id};
    return{status:operation.status,result:operation.result,operation_id,replayed:true};
  }
  if(!await db.rateLimit(`send:${scope}`,20)) {
    await db.finishOperation(scope,operation_id,'rejected',null,'RATE_LIMITED');
    return{status:'rejected',error_code:'RATE_LIMITED',operation_id};
  }
  let result;
  try { result=await adapter.call(token,method,input); }
  catch(error) {
    const status=error.details?.outcome==='rejected'?'rejected':'unknown';
    const code=typeof error.code==='string'?error.code:'RUBIKA_UNAVAILABLE';
    try {await db.finishOperation(scope,operation_id,status,null,code);}catch{/* Pending blocks replay even when recording failed. */}
    return{status,error_code:code,operation_id};
  }
  // Success payloads may be malicious upstream echoes. Never persist the active token.
  const clean=redact(result,token);
  try {await db.finishOperation(scope,operation_id,'success',clean);}
  catch {return{status:'confirmed_unrecorded',operation_id};}
  return{status:'success',result:clean,operation_id};
}
function redact(value,token) {
  if(typeof value==='string')return value.split(token).join('[REDACTED]');
  if(Array.isArray(value))return value.map(item=>redact(item,token));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!/(?:token|secret|password|authorization)/i.test(key)).map(([key,item])=>[key,redact(item,token)]));
  return value;
}
const normalText = text => String(text || '').normalize('NFKC').replace(/ي/g,'ی').replace(/ك/g,'ک').replace(/[\u200c\u200d\u200e\u200f\ufeff]/g,'').replace(/\s+/g,' ').trim().toLowerCase();
const lines = value => Array.isArray(value)?value.map(String):String(value || '').split(/[\n,]+/).map(value=>value.trim()).filter(Boolean);
function validId(value) { return typeof value==='string' && /^[A-Za-z0-9_:\-]{1,160}$/.test(value); }
function minuteOfDay(now) {
  const parts=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Asia/Tehran',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}).formatToParts(new Date(now)).map(part=>[part.type,part.value]));
  return Number(parts.hour)*60+Number(parts.minute);
}
export function isQuiet(settings,now) {
  if(settings.quiet_enabled!==true)return false;
  const parse=value=>/^([01]\d|2[0-3]):[0-5]\d$/.test(value || '')?Number(value.slice(0,2))*60+Number(value.slice(3)):null;
  const start=parse(settings.quiet_start),end=parse(settings.quiet_end);if(start===null||end===null||start===end)return false;
  const current=minuteOfDay(now);return start<end?current>=start&&current<end:current>=start||current<end;
}
function blockedLink(text,allowed) {
  const links=text.match(/(?:https?:\/\/|www\.)[^\s<>]+|\b(?:[a-z0-9](?:[a-z0-9-]{0,62})\.)+[a-z]{2,63}(?:\/[^\s<>]*)?/gi)||[];
  return links.some(link=>{
    let host;try{host=new URL(/^https?:\/\//i.test(link)?link:'https://'+link).hostname.toLowerCase();}catch{return true;}
    return !allowed.some(domain=>host===domain||host.endsWith('.'+domain));
  });
}

// Pure classification stores hashes and timestamps rather than message bodies.
export async function evaluateModeration({message,settings,state={},now=Date.now()}) {
  const violations=[];const locks=settings.locks||{};const text=String(message.text || '').slice(0,4096),normalized=normalText(text);
  const authorized=settings.active===true&&settings.moderation_enabled===true&&settings.moderation_authorized===true;
  if(!authorized||lines(settings.admin_exceptions).includes(message.sender_id))return{violations,state:{...state,last_seen_at:now},exempt:!authorized?'disabled':'configured_exception'};
  if(isQuiet(settings,now))violations.push('quiet');
  if(locks.text&&text.trim())violations.push('text');
  if(locks.link&&blockedLink(text,lines(settings.allowed_domains).map(domain=>domain.toLowerCase().replace(/\.$/,''))))violations.push('link');
  if((locks.username||locks.mention)&&/@[\p{L}\p{N}_]{2,64}/u.test(text))violations.push(locks.mention?'mention':'username');
  if(locks.hashtag&&/#[\p{L}\p{N}_]+/u.test(text))violations.push('hashtag');
  if(locks.profanity&&lines(settings.blocked_words).some(word=>normalized.includes(normalText(word))))violations.push('profanity');
  for(const [field,key] of [['forwarded_from','forward'],['forwarded_no_link','forward'],['file','file'],['sticker','sticker'],['location','location'],['live_location','location'],['contact_message','contact'],['poll','poll']])if(locks[key]&&message[field])violations.push(key);
  for(const pattern of lines(settings.blocked_patterns).slice(0,20))if(safeRegex(pattern).test(normalized))violations.push('pattern');
  const windowMs=Math.max(1,Math.min(3600,Number(settings.flood_seconds)||8))*1000;
  const oldWindow=Number(state.window_start)||now;const newWindow=oldWindow>now||now-oldWindow>=windowMs;
  const messageCount=newWindow?1:Math.max(0,Number(state.message_count)||0)+1;
  const recent=(state.recent_hashes||[]).filter(item=>Number.isFinite(item.time)&&item.time<=now&&now-item.time<windowMs).slice(-19);
  const media={file:message.file?.file_id,sticker:message.sticker?.sticker_id,poll:message.poll?.question,location:message.location};
  const identity=normalized || (Object.values(media).some(value=>value!==undefined)?stable(media):'');
  const fingerprint=await hash(identity);
  if(settings.anti_spam===true){
    if(messageCount>Math.max(1,Number(settings.flood_count)||6))violations.push('flood');
    if(identity&&!message.aux_data?.button_id&&recent.some(item=>item.hash===fingerprint))violations.push('repeated');
  }
  recent.push({hash:fingerprint,time:now});
  return{violations:[...new Set(violations)],state:{...state,window_start:newWindow?now:oldWindow,message_count:messageCount,last_seen_at:now,last_message_at:now,recent_hashes:recent}};
}

async function resources(db,scope,collection) {return(await db.listResources(scope,collection,{limit:500})).map(item=>({...item.data,id:item.id}));}
export async function processBatch({scope,token,bot,updates,db,store,adapter,now=Date.now()}) {
  assert(Array.isArray(updates)&&updates.length<=10,'The engine processes at most ten events per batch.');
  const result={processed:0,duplicates:0,skipped:0,actions:0,errors:0,accounted:0,complete:false,results:[]};
  const chats=new Map((await db.listChats(scope)).map(chat=>[chat.chat_id,chat]));
  // Only owner-created, explicitly enabled resources may produce outbound replies.
  const [automations,templates,flows,menus,commands,faq]=await Promise.all(['automations','templates','flows','menus','commands','faq'].map(collection=>resources(db,scope,collection)));
  const replyRules=[...automations,...commands.map(command=>({...command,match:'command'})),...faq.map(item=>({...item,match:'keyword'}))];
  for(const event of updates) {
    const began=Date.now(),message=event?.new_message;
    if(event?.type!=='NewMessage'||!message||message.sender_type!=='User'||!validId(event.chat_id)||!validId(message.message_id)||!validId(message.sender_id)){result.skipped++;result.accounted++;continue;}
    // Ignore bot echoes and malformed identifiers. No event text enters storage.
    if(message.sender_id===bot.bot_id||[event.chat_id,message.message_id,message.sender_id,String(message.aux_data?.button_id || '')].some(value=>value.includes(token))){result.skipped++;result.accounted++;continue;}
    const eventKey=await hash({type:event.type,chat_id:event.chat_id,message_id:message.message_id,button_id:message.aux_data?.button_id || ''});
    const occurred=Number(message.time)*1000;
    const metadata={type:'NewMessage',chat_id:event.chat_id,user_id:message.sender_id,message_id:message.message_id,occurred_at:new Date(Number.isFinite(occurred)&&occurred>0&&occurred<32503680000000?occurred:now).toISOString()};
    const claim=await store.claimEvent(scope,eventKey,metadata);
    if(!claim.claimed){result.duplicates++;result.accounted++;result.results.push({event_key:eventKey,status:claim.status || 'pending',duplicate:true});continue;}
    const chat=chats.get(event.chat_id);
    const summary={status:'success',processed:!!chat,skipped:!chat,violations:[],warnings:0,actions:0,errors:0,methods:[],statuses:[],latency_ms:0};
    if(!chat){await store.finishEvent(scope,eventKey,'skipped',summary);result.skipped++;result.accounted++;continue;}
    if(validId(message.aux_data?.button_id)&&!message.aux_data.button_id.includes(token)){summary.button_id=message.aux_data.button_id;summary.clicks=1;}
    const settings={...chat.settings};const eventTime=Number.isFinite(occurred)&&occurred>0&&occurred<=now+300000?occurred:now;
    if(eventTime<Date.parse(settings.moderation_started_at || ''))settings.moderation_enabled=false;
    if(eventTime<Date.parse(settings.automation_started_at || ''))settings.automation_enabled=false;
    const userState=await store.getUserState(scope,event.chat_id,message.sender_id)||{};
    const callback=message.aux_data?.button_id;
    const callbackSession=typeof callback==='string'&&/^(?:flow|menu):[^:]+:(?:cancel|close)$/.test(callback)?await store.getSession(scope,event.chat_id,message.sender_id):null;
    const cancelCallback=callbackSession&&callback===(callbackSession.kind+':'+(callbackSession.flow_id || callbackSession.menu_id)+':'+(callbackSession.kind==='flow'?'cancel':'close'));
    const cancellation=/^\/(cancel|unsubscribe)$/i.exec(String(message.text || '').trim()) || (cancelCallback?[null,'cancel']:null);
    const moderation=cancellation||chat.type==='channel'?{violations:[],state:userState}:await evaluateModeration({message,settings,state:userState,now:eventTime});
    let newState=moderation.state;const actions=[];
    if(cancellation) {
      if(cancellation[1].toLowerCase()==='cancel')await store.deleteSession(scope,event.chat_id,message.sender_id);
      else {const id=await operationId(`subscription:${scope}:${event.chat_id}:${message.sender_id}`);await db.saveResource(scope,'subscribers',id,{chat_id:event.chat_id,user_id:message.sender_id,subscribed:false,requested_at:new Date(now).toISOString()});}
      summary.command='/'+cancellation[1].toLowerCase();
      if(settings.automation_authorized===true)actions.push({method:'sendMessage',params:{chat_id:event.chat_id,text:cancellation[1].toLowerCase()==='cancel'?'نشست موقت شما پاک شد.':'درخواست لغو عضویت ثبت شد.'},reason:'withdrawal'});
    } else if(moderation.violations.length) {
      summary.violations=moderation.violations;const warningCount=Math.max(0,Number(userState.warning_count)||0)+1;
      newState={...newState,warning_count:warningCount,last_warning_at:now};summary.warnings=1;
      actions.push({method:'deleteMessage',params:{chat_id:event.chat_id,message_id:message.message_id},reason:'moderation'});
      if(settings.warning_enabled===true) {
        const context={name:message.sender_id,user_id:message.sender_id,chat_title:chat.title,bot_name:bot.name,date:new Intl.DateTimeFormat('fa-IR',{timeZone:'Asia/Tehran',dateStyle:'short'}).format(new Date(now)),time:new Intl.DateTimeFormat('fa-IR',{timeZone:'Asia/Tehran',timeStyle:'short'}).format(new Date(now))};
        const text=renderTemplate(settings.warning_message || 'کاربر {user_id}، پیام شما با قوانین این گفتگو سازگار نبود.',context).slice(0,3500)+`\nاخطار ${warningCount} از ${Number(settings.warn_limit)||3}.`;
        actions.push({method:'sendMessage',params:{chat_id:event.chat_id,text},reason:'warning'});
      }
    } else if(settings.active===true&&settings.automation_enabled===true&&settings.automation_authorized===true) {
      const session=await store.getSession(scope,event.chat_id,message.sender_id);
      const plan=await planInteraction({message,chat,bot,automations:replyRules,templates,flows,menus,session:session || {},now});
      if(plan.command&&/^\/[a-z0-9_]{1,32}$/i.test(plan.command))summary.command=plan.command;
      if(plan.session!==undefined){if(plan.session){safeData(plan.session,token);await store.saveSession(scope,event.chat_id,message.sender_id,plan.session,{token});}else await store.deleteSession(scope,event.chat_id,message.sender_id);}
      if(plan.consent) {
        const consentId=await operationId(`subscription:${scope}:${event.chat_id}:${message.sender_id}`);
        const data=safeData({chat_id:event.chat_id,user_id:message.sender_id,subscribed:plan.consent.subscribed===true,requested_at:plan.consent.requested_at || new Date(now).toISOString()},token);
        await db.saveResource(scope,'subscribers',consentId,data);
      }
      for(const action of (plan.actions||[]).slice(0,3)) {
        // Plugin plans cannot redirect a reply or request privileged API methods.
        if(action.method!=='sendMessage'||action.params?.chat_id!==event.chat_id)throw new ApiError(400,'UNSAFE_INTERACTION','An interaction attempted an unsupported destination or method.');
        actions.push(action);
      }
    }
    await store.saveUserState(scope,event.chat_id,message.sender_id,newState);
    for(let index=0;index<actions.length;index++) {
      const action=actions[index];const id=await operationId(`engine:${scope}:${eventKey}:${index}:${action.method}`);
      const dispatched=await dispatchOperation({scope,token,method:action.method,params:action.params,operation_id:id,db,adapter,authorized:true});
      summary.actions++;summary.methods.push(action.method);summary.statuses.push(dispatched.status);
      if(dispatched.status!=='success'){summary.errors++;summary.status=dispatched.status;}
      await db.audit(scope,{action:'engine',status:dispatched.status,method:action.method,chat_id:event.chat_id,event_key:eventKey,operation_id:id,...(dispatched.error_code?{error_code:dispatched.error_code}:{})});
    }
    summary.latency_ms=Math.max(0,Date.now()-began);
    if(summary.violations.length) {
      const id=await operationId(`violation:${scope}:${eventKey}`);
      await db.saveResource(scope,'violations',id,{title:'تخلف شناسایی‌شده توسط موتور',source:'engine',chat_id:event.chat_id,user_id:message.sender_id,message_id:message.message_id,event_key:eventKey,rules:summary.violations,warning_count:newState.warning_count,status:'open',action_statuses:summary.statuses,occurred_at:metadata.occurred_at});
    }
    await store.finishEvent(scope,eventKey,['success','skipped','rejected','unknown'].includes(summary.status)?summary.status:'unknown',summary);
    result.processed++;result.accounted++;result.actions+=summary.actions;result.errors+=summary.errors;
    result.results.push({event_key:eventKey,...summary});
  }
  result.complete=result.accounted===updates.length;
  return result;
}
