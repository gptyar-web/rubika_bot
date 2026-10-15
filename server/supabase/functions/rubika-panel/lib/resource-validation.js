import { assert, integer, safeData, identifier } from './validation.js';
import { validateInteractionResource, safeRegex } from './interactions.js';
import { schedulePlan } from './scheduler.js';
import { buildMessage, destinations } from './adapter.js';

export const INTERACTION_COLLECTIONS = ['automations','commands','faq','flows','menus'];
export function validateResource(collection,input,token,{now=Date.now()}={}) {
  const data=safeData(input,token);
  if(INTERACTION_COLLECTIONS.includes(collection)) {
    if(collection==='commands')data.match='command';
    if(collection==='faq')data.match='keyword';
    validateInteractionResource(collection,data);
  }
  if(['templates','drafts','schedules'].includes(collection)) {
    const keypad={...(data.inline_keypad?{inline_keypad:data.inline_keypad}:{}),...(data.chat_keypad?{chat_keypad:data.chat_keypad,chat_keypad_type:data.chat_keypad_type}:{})};
    if(Object.keys(keypad).length)buildMessage('sendMessage',{chat_id:'validation_only',text:typeof data.text==='string'&&data.text.trim()?data.text:'preview',...keypad});
  }
  if(collection==='schedules') {
    const date=data.scheduled_at ?? data.scheduledAt;
    if(date!==undefined)assert(typeof date==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(date)&&Number.isFinite(Date.parse(date)),'scheduled_at must be an ISO timestamp with timezone.');
    if(data.enabled===true||data.status==='approved') {
      assert(data.enabled===true&&data.authorized===true&&data.status==='approved','Enabling a schedule requires explicit approval and permission.','PERMISSION_REQUIRED');
      const plan=schedulePlan({id:'11111111-1111-4111-8111-111111111111',data});
      assert(plan,'The approved schedule is invalid.');
      assert(plan.starts>now,'Approve a future scheduled time; overdue records must be reviewed and rescheduled.');
    } else {
      assert(data.enabled!==true,'Draft schedules must be disabled.');
      data.enabled=false;data.authorized=false;data.status='draft';
    }
  }
  return data;
}
export async function validateResourceDestinations(collection,data,scope,db) {
  let chats=[];
  if(INTERACTION_COLLECTIONS.includes(collection))chats=data.allowed_chat_ids || [];
  if(collection==='schedules'&&data.enabled===true){const plan=schedulePlan({id:'11111111-1111-4111-8111-111111111111',data});chats=plan.params.flatMap(params=>destinations(plan.method,params));}
  for(const chatId of new Set(chats)){identifier(chatId);assert(await db.getChat(scope,chatId),'Only registered authorized destinations may be enabled.','DESTINATION_NOT_REGISTERED');}
}
export function validateEngineSettings(settings) {
  for(const name of ['active','anti_spam','quiet_enabled','moderation_enabled','moderation_authorized','automation_enabled','automation_authorized','warning_enabled','subscriptions'])if(name in settings)assert(typeof settings[name]==='boolean',`${name} must be boolean.`);
  if(settings.moderation_enabled===true)assert(settings.moderation_authorized===true,'Moderation requires explicit permission.','PERMISSION_REQUIRED');
  if(settings.automation_enabled===true)assert(settings.automation_authorized===true,'Automatic replies require explicit permission.','PERMISSION_REQUIRED');
  if(settings.blocked_patterns!==undefined){assert(typeof settings.blocked_patterns==='string'&&settings.blocked_patterns.length<=2000,'Blocked patterns must be text up to 2000 characters.');const values=settings.blocked_patterns.split('\n').map(value=>value.trim()).filter(Boolean);assert(values.length<=20,'At most twenty blocked patterns are allowed.');values.forEach(value=>safeRegex(value));}
  if(settings.locks!==undefined){assert(settings.locks&&typeof settings.locks==='object'&&!Array.isArray(settings.locks),'Locks must be an object.');for(const value of Object.values(settings.locks))assert(typeof value==='boolean','Lock values must be boolean.');}
  if(settings.admin_exceptions!==undefined){assert(typeof settings.admin_exceptions==='string'&&settings.admin_exceptions.length<=2000,'Exception identifiers must be text.');settings.admin_exceptions.split(/[\n,]/).map(value=>value.trim()).filter(Boolean).forEach(value=>identifier(value,'exception'));
  }
  if(settings.warning_message!==undefined)assert(typeof settings.warning_message==='string'&&settings.warning_message.length<=2000,'Warning message exceeds 2000 characters.');
  return settings;
}
