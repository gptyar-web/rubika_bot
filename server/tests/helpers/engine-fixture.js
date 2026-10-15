import { createHandler, botScope } from '../../supabase/functions/rubika-panel/lib/handler.js';
export const TOKEN='UNIT_TEST_BOT_TOKEN_123456789';
export const SALT='unit-test-salt-at-least-32-characters-long';
export const NOW=Date.parse('2026-10-15T12:00:00Z');
export const CHAT='g_test';
export function event(text='hello',id='m1',extra={}) {return{type:'NewMessage',chat_id:CHAT,new_message:{message_id:id,sender_id:'u_test',sender_type:'User',time:String(NOW/1000),text,...extra}};}
export async function engineFixture(settings={}) {
  const scope=await botScope('b_test',SALT),resources=new Map(),chats=new Map(),operations=new Map(),events=new Map(),states=new Map(),sessions=new Map(),runtime=new Map(),audit=[],calls=[];
  const key=(...parts)=>parts.join('|');
  chats.set(key(scope,CHAT),{scope,chat_id:CHAT,title:'آزمون',type:'group',settings});
  const db={
    async rateLimit(){return true;},async saveBot(){},async listChats(s){return[...chats.values()].filter(row=>row.scope===s);},async getChat(s,id){return chats.get(key(s,id));},
    async saveChat(s,data){const row={scope:s,...data};chats.set(key(s,data.chat_id),row);return row;},async deleteChat(s,id){const row=chats.get(key(s,id));chats.delete(key(s,id));return row?[row]:[];},
    async listResources(s,collection){return collection==='logs'?audit.filter(row=>row.scope===s):[...resources.values()].filter(row=>row.scope===s&&row.collection===collection);},
    async saveResource(s,collection,id,data){const row={scope:s,collection,id,data,created_at:new Date(NOW).toISOString()};resources.set(key(s,collection,id),row);return row;},
    async deleteResource(s,collection,id){const row=resources.get(key(s,collection,id));resources.delete(key(s,collection,id));return row?[row]:[];},
    async audit(s,data){audit.push({scope:s,data,created_at:new Date(NOW).toISOString()});},
    async claimOperation(s,id,request_hash){const k=key(s,id);if(operations.has(k))return{claimed:false,...operations.get(k)};operations.set(k,{request_hash,status:'pending'});return{claimed:true,request_hash,status:'pending'};},
    async finishOperation(s,id,status,result,error_code){Object.assign(operations.get(key(s,id)),{status,result,error_code});},async recordEvents(s,rows){return rows;},
  };
  const store={
    async acquireLease(s,owner){const previous=runtime.get(s);if(previous?.owner&&previous.owner!==owner)return{acquired:false};runtime.set(s,{...previous,owner,enabled:previous?.enabled??true,lease_until:new Date(NOW+300000).toISOString()});return{acquired:true};},
    async releaseLease(s,owner){const row=runtime.get(s);if(row?.owner===owner)row.owner=null;},
    async getRuntime(s){return runtime.get(s)||null;},async saveRuntime(s,data,owner){const row=runtime.get(s)||{};if(row.owner&&row.owner!==owner)throw Error('Lease mismatch');runtime.set(s,{...row,...data,heartbeat_at:new Date(NOW).toISOString()});},
    async setEnabled(s,enabled){runtime.set(s,{...runtime.get(s),enabled});},
    async claimEvent(s,id,metadata){const k=key(s,id);if(events.has(k))return{claimed:false,...events.get(k)};events.set(k,{event_key:id,scope:s,metadata,status:'pending',received_at:new Date(NOW).toISOString()});return{claimed:true,status:'pending'};},
    async finishEvent(s,id,status,summary){Object.assign(events.get(key(s,id)),{status,summary});},
    async getUserState(s,c,u){return states.get(key(s,c,u))||{};},async saveUserState(s,c,u,data){states.set(key(s,c,u),data);},
    async getSession(s,c,u){return sessions.get(key(s,c,u))||null;},async saveSession(s,c,u,data){sessions.set(key(s,c,u),data);},async deleteSession(s,c,u){sessions.delete(key(s,c,u));},async listSessions(s){return[...sessions.entries()].filter(([k])=>k.startsWith(s+'|')).map(([,data])=>({chat_id:data.chat_id,user_id:data.user_id,data,expires_at:data.expires_at}));},
    async listMetrics(s){return[...events.values()].filter(row=>row.scope===s);},async listScheduleJobs(){return[];},
  };
  let batch=[];
  const adapter={pollingParams(input){return{limit:input.limit??5,...(input.offset_id?{offset_id:input.offset_id}:{})};},async call(token,method,params){calls.push({token,method,params});if(method==='getMe')return{bot_id:token===TOKEN?'b_test':'b_other',id:'b_test',name:'آزمون'};if(method==='getUpdates')return{updates:batch,next_offset_id:'next_1'};if(method==='deleteMessage')return{};return{message_id:'reply_1'};}};
  const handler=createHandler({env:{SCOPE_SALT:SALT},database:db,adapter,runtimeStore:store,clock:()=>NOW});
  const invoke=async body=>{const response=await handler(new Request('https://example.supabase.co/functions/v1/rubika-panel',{method:'POST',headers:{'Content-Type':'application/json',Origin:'https://mozdbaranarshiya.github.io'},body:JSON.stringify({token:TOKEN,...body})}));return{status:response.status,body:await response.json()};};
  return{scope,bot:{bot_id:'b_test',name:'آزمون'},token:TOKEN,db,store,adapter,chats,resources,operations,events,states,sessions,runtime,audit,calls,invoke,setBatch:items=>batch=items};
}
