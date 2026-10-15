import { ApiError, assert, collectionName, groupInput, identifier, integer, record, safeData, tokenValue, uuid } from "./validation.js";
import { buildMessage, createRubikaAdapter, destinations, MESSAGE_METHODS } from "./adapter.js";
import { createDatabase } from "./database.js";
import { createRuntimeStore } from './runtime-store.js';
import { processBatch, dispatchOperation } from './engine.js';
import { runDueSchedules } from './scheduler.js';
import { buildReport, reportRange } from './reports.js';
import { validateResource, validateResourceDestinations, validateEngineSettings } from './resource-validation.js';

export const CAPABILITIES = Object.freeze({
  collections: true, messaging: true, polling: true, channels: true,
  engine: true, manual_engine: true, reports: true, background: false, webhook: false, moderation: true, scheduling: true,
  automation_execution: true, rbac: false, two_factor: false, upload: false,
});
const ACTIONS = ["health", "login", "list", "save", "delete", "collection_list", "collection_save", "collection_delete", "message", "poll", "engine_status", "engine_run", "schedule_run", "reports", "engine_toggle", "sessions_list"];

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

export async function digest(value) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(buffer)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function botScope(botId, salt) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`rubika-panel-v3:${botId}`));
  return [...new Uint8Array(signed)].map(byte => byte.toString(16).padStart(2, "0")).join("");
}

function redact(value, token) {
  if (typeof value === "string") return value.replaceAll(token, "[REDACTED]");
  if (Array.isArray(value)) return value.map(item => redact(item, token));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/^(token|secret|authorization)$/iu.test(key)).map(([key, item]) => [key, redact(item, token)]));
  return value;
}

async function readJson(request) {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) throw new ApiError(415, "JSON_REQUIRED", "Use Content-Type: application/json.");
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > 65536) throw new ApiError(413, "BODY_TOO_LARGE", "The request exceeds 64 KiB.");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "INVALID_JSON", "An object request body is required.");
  const chunks = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > 65536) { await reader.cancel(); throw new ApiError(413, "BODY_TOO_LARGE", "The request exceeds 64 KiB."); }
    chunks.push(value);
  }
  const buffer = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.length; }
  let value;
  try { value = JSON.parse(new TextDecoder().decode(buffer)); } catch { throw new ApiError(400, "INVALID_JSON", "The request body is not valid JSON."); }
  return record(value, "request");
}

export function createHandler({ env = {}, database, adapter, runtimeStore, clock = () => Date.now(), fetcher = fetch } = {}) {
  const allowedOrigins = new Set((env.ALLOWED_ORIGINS ?? "https://mozdbaranarshiya.github.io").split(",").map(origin => origin.trim()).filter(Boolean));
  const localEnabled = env.ALLOW_LOCALHOST === "true";
  let db = database;
  let rubika = adapter;
  let store = runtimeStore;
  const ready = Boolean(env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY && env.SCOPE_SALT?.length >= 32);
  return async function handle(request) {
    const origin = request.headers.get("origin");
    const localOrigin = localEnabled && /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u.test(origin ?? "");
    const originAllowed = !origin || allowedOrigins.has(origin) || localOrigin;
    const headers = {
      "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Vary": "Origin",
      ...(origin && originAllowed ? { "Access-Control-Allow-Origin": origin } : {}),
    };
    function response(body, status = 200) { return new Response(JSON.stringify(body), { status, headers }); }
    try {
      if (!originAllowed) throw new ApiError(403, "ORIGIN_DENIED", "This web origin is not allowed.");
      if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...headers, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type", "Access-Control-Max-Age": "600" } });
      if (request.method !== "POST") throw new ApiError(405, "METHOD_NOT_ALLOWED", "Use POST for this endpoint.");
      const body = await readJson(request);
      assert(ACTIONS.includes(body.action), "Unknown panel action.", "UNSUPPORTED_ACTION");
      if (body.action === "health") return response({ ok: true, service: "rubika-panel", version: "3.1", configured: ready, capabilities: CAPABILITIES, message_methods: MESSAGE_METHODS, live_verified: false });
      if (!ready && !database) throw new ApiError(503, "CONFIGURATION_REQUIRED", "Configure Supabase server secrets and SCOPE_SALT before using authenticated actions.");
      db ??= createDatabase({ url: env.SUPABASE_URL, key: env.SUPABASE_SERVICE_ROLE_KEY, fetcher });
      rubika ??= createRubikaAdapter({ base: env.RUBIKA_API_BASE, fetcher });
      const token = tokenValue(body.token);
      // A shared cap cannot be bypassed by spoofing a forwarded IP header.
      if (!await db.rateLimit("global-auth", 120)) throw new ApiError(429, "RATE_LIMITED", "Too many requests. Try again next minute.");
      const bot = await rubika.call(token, "getMe", {});
      const scope = await botScope(bot.bot_id, env.SCOPE_SALT ?? "test-only-salt-not-used-in-production");
      if (!await db.rateLimit(`bot:${scope}`, 60)) throw new ApiError(429, "RATE_LIMITED", "This bot has reached the request limit. Try again next minute.");
      await db.saveBot(scope, redact(bot, token));
      const audit = data => db.audit(scope, redact(data, token));
      let result;
      switch (body.action) {
        case "login":
          await audit({ action: "login", status: "success" });
          result = { bot, capabilities: CAPABILITIES, message_methods: MESSAGE_METHODS }; break;
        case "list": {
          const groups = await db.listChats(scope);
          result = { groups: groups.map(({ scope: ignored, ...group }) => group) }; break;
        }
        case "save": {
          const input = groupInput(body, token);
          validateEngineSettings(input.settings);
          const previous=await db.getChat(scope,input.chat_id);
          for(const mode of ['moderation','automation']){
            const enabled=input.settings.active===true&&input.settings[mode+'_enabled']===true&&input.settings[mode+'_authorized']===true;
            const previouslyEnabled=previous?.settings?.active===true&&previous.settings[mode+'_enabled']===true&&previous.settings[mode+'_authorized']===true;
            const previousTime=previous?.settings?.[mode+'_started_at'];
            input.settings[mode+'_started_at']=enabled?(previouslyEnabled&&Number.isFinite(Date.parse(previousTime))?previousTime:new Date(clock()).toISOString()):null;
          }
          const { scope: ignored, ...group } = await db.saveChat(scope, input);
          await audit({ action: "save", status: "success", chat_id: input.chat_id, type: input.type });
          result = { group, applied: false }; break;
        }
        case "delete": {
          const chat_id = identifier(body.chat_id);
          safeData({ chat_id }, token);
          const deleted = await db.deleteChat(scope, chat_id);
          await audit({ action: "delete", status: "success", chat_id });
          result = { deleted: Boolean(deleted?.length), affected: deleted?.length ?? 0 }; break;
        }
        case "collection_list": {
          const collection = collectionName(body.collection);
          const limit = integer(body.limit, "limit", 1, 500, 500);
          const offset = integer(body.offset, "offset", 0, 100000, 0);
          result = { items: await db.listResources(scope, collection, { limit, offset }), limit, offset }; break;
        }
        case "collection_save": {
          const collection = collectionName(body.collection);
          if (collection === "logs") throw new ApiError(403, "AUDIT_READ_ONLY", "The server audit trail cannot be edited.");
          const id = uuid(body.id, "id", true) ?? crypto.randomUUID();
          if(collection === "subscribers") throw new ApiError(403,"CONSENT_READ_ONLY","Subscription consent can only be changed by an explicit user command.");
          const data = validateResource(collection, body.data, token, {now:clock()});
          await validateResourceDestinations(collection,data,scope,db);
          safeData({ id, data }, token);
          const item = await db.saveResource(scope, collection, id, data);
          await audit({ action: "collection_save", status: "success", collection, resource_id: id });
          result = { item, executed: false }; break;
        }
        case "collection_delete": {
          const collection = collectionName(body.collection);
          if (collection === "logs") throw new ApiError(403, "AUDIT_READ_ONLY", "The server audit trail cannot be deleted.");
          if(collection === "subscribers") throw new ApiError(403,"CONSENT_READ_ONLY","Subscription consent is changed only by the requesting user.");
          const id = uuid(body.id);
          safeData({ id }, token);
          const deleted = await db.deleteResource(scope, collection, id);
          await audit({ action: "collection_delete", status: "success", collection, resource_id: id });
          result = { deleted: Boolean(deleted?.length), affected: deleted?.length ?? 0 }; break;
        }
        case "message": {
          const params = buildMessage(body.method, body.params);
          safeData(params, token);
          assert(body.authorized === true, "Confirm permission for the selected destination.", "PERMISSION_REQUIRED");
          for (const chat_id of destinations(body.method, params)) {
            if (!await db.getChat(scope, chat_id)) throw new ApiError(403, "DESTINATION_NOT_REGISTERED", "Register the authorized destination in this panel before using it.");
          }
          if (body.method === "getChat") { result = { result: await rubika.call(token, body.method, params) }; break; }
          if (!await db.rateLimit(`send:${scope}`, 20)) throw new ApiError(429, "RATE_LIMITED", "This bot reached the message-operation limit. Try next minute.");
          const operation_id = uuid(body.operation_id, "operation_id");
          safeData({ operation_id }, token);
          const hash = await digest(canonical({ method: body.method, params }));
          const operation = await db.claimOperation(scope, operation_id, hash);
          if (!operation.claimed) {
            if (operation.request_hash !== hash) throw new ApiError(409, "OPERATION_CONFLICT", "This operation ID already belongs to different content.");
            if (operation.status === "success") { result = { result: operation.result, operation_id, replayed: true }; break; }
            throw new ApiError(409, "OPERATION_ALREADY_ATTEMPTED", "This operation was already attempted. Check the chat before starting a new operation.", { outcome: operation.status, operation_id });
          }
          let upstream;
          try { upstream = await rubika.call(token, body.method, params); }
          catch (error) {
            const status = error.details?.outcome === "rejected" ? "rejected" : "unknown";
            let recording_pending = false;
            try {
              await db.finishOperation(scope, operation_id, status, null, error.code ?? "RUBIKA_UNAVAILABLE");
              await audit({ action: "message", status, method: body.method, chat_id: params.chat_id ?? params.to_chat_id, operation_id });
            } catch { recording_pending = true; }
            throw new ApiError(error.status ?? 502, error.code ?? "RUBIKA_UNAVAILABLE", error instanceof ApiError ? error.message : "Rubika did not return a confirmed response.", { ...error.details, outcome: status, operation_id, ...(recording_pending ? { recording_pending: true } : {}) });
          }
          upstream = redact(upstream, token);
          // If recording fails, pending remains non-retryable: never risk a second send.
          try {
            await db.finishOperation(scope, operation_id, "success", upstream);
            await audit({ action: "message", status: "success", method: body.method, chat_id: params.chat_id ?? params.to_chat_id, operation_id });
          } catch {
            throw new ApiError(503, "OPERATION_RECORDING_INCOMPLETE", "Rubika confirmed this operation, but the server could not finish recording it. Do not resend; check the destination first.", { outcome: "confirmed_unrecorded", operation_id });
          }
          result = { result: upstream, operation_id, replayed: false }; break;
        }
        case "engine_toggle": {
          assert(typeof body.enabled==='boolean','enabled must be boolean.');
          store ??= createRuntimeStore({url:env.SUPABASE_URL,key:env.SUPABASE_SERVICE_ROLE_KEY,fetcher});
          await store.setEnabled(scope,body.enabled);
          await audit({action:'engine_toggle',status:'success',enabled:body.enabled});
          result={enabled:body.enabled};break;
        }
        case "sessions_list": {
          store ??= createRuntimeStore({url:env.SUPABASE_URL,key:env.SUPABASE_SERVICE_ROLE_KEY,fetcher});
          result={sessions:await store.listSessions(scope)};break;
        }
        case "engine_status": {
          store ??= createRuntimeStore({url:env.SUPABASE_URL,key:env.SUPABASE_SERVICE_ROLE_KEY,fetcher});
          const runtime=await store.getRuntime(scope);
          const worker_running=runtime?.status==='running'&&Date.parse(runtime.heartbeat_at)>clock()-120000&&Date.parse(runtime.lease_until)>clock();
          result={runtime:runtime?{...runtime,last_heartbeat_at:runtime.heartbeat_at}:null,worker_running,capabilities:{...CAPABILITIES,background:worker_running}};break;
        }
        case "engine_run":
        case "schedule_run": {
          assert(body.authorized===true,"Confirm permission before executing the engine.","PERMISSION_REQUIRED");
          store ??= createRuntimeStore({url:env.SUPABASE_URL,key:env.SUPABASE_SERVICE_ROLE_KEY,fetcher});
          if((await store.getRuntime(scope))?.enabled===false)throw new ApiError(409,'ENGINE_PAUSED','Enable this bot engine before processing events.');
          const owner='manual:'+crypto.randomUUID();
          const lease=await store.acquireLease(scope,owner,300);
          if(!lease?.acquired)throw new ApiError(409,'ENGINE_BUSY','Another worker owns this bot. Wait before trying again.');
          const guard={...rubika,call:async(...args)=>{if((await store.getRuntime(scope))?.enabled===false)throw new ApiError(409,'ENGINE_PAUSED','Engine was paused.');const renewed=await store.acquireLease(scope,owner,300);if(!renewed?.acquired)throw new ApiError(409,'ENGINE_LEASE_LOST','Engine lease is no longer valid.');return rubika.call(...args);}};
          try {
            await store.saveRuntime(scope,{status:'idle',last_error_code:null},owner);
            if(body.action==='schedule_run') {
              const summary=await runDueSchedules({scope,token,db,store,adapter:guard,now:clock(),dispatchOperation,maxJobs:5});
              result={...summary,processed:summary.attempted,results:summary.jobs};
            } else {
              const runtime=await store.getRuntime(scope);
              const limit=integer(body.limit,'limit',1,10,5);
              const params=rubika.pollingParams({...body,limit,...(runtime?.offset_id?{offset_id:runtime.offset_id}:{})});
              const batch=await guard.call(token,'getUpdates',params);
              if(!Array.isArray(batch.updates)||batch.updates.length>limit)throw new ApiError(502,'INVALID_RUBIKA_RESPONSE','The updates batch exceeds the engine limit.');
              const summary=await processBatch({scope,token,bot,updates:batch.updates,db,store,adapter:guard,now:clock()});
              if(!summary.complete)throw new ApiError(503,'ENGINE_INCOMPLETE','Not every event was accounted for.');
              const renewed=await store.acquireLease(scope,owner,300);if(!renewed?.acquired)throw new ApiError(409,'ENGINE_LEASE_LOST','Engine lease was lost before cursor commit.');
              await store.saveRuntime(scope,{status:'idle',offset_id:batch.next_offset_id??runtime?.offset_id??null,last_error_code:null},owner);
              result={...summary,next_offset_id:batch.next_offset_id??null};
            }
            await audit({action:body.action,status:'success',processed:result.processed});
          } finally {await store.releaseLease(scope,owner);}
          break;
        }
        case "reports": {
          store ??= createRuntimeStore({url:env.SUPABASE_URL,key:env.SUPABASE_SERVICE_ROLE_KEY,fetcher});
          const range=reportRange({from:body.from,to:body.to,now:new Date(clock())});
          const events=await store.listMetrics(scope,body.compare===true?range.previous_from:range.from,range.to);
          const logs=await db.listResources(scope,'logs',{limit:500,offset:0});
          result={report:buildReport({events,audit:logs,from:range.from,to:range.to,previous:body.compare===true,now:new Date(clock())}),truncated:events.length>=5000,audit_limit:500};break;
        }
        case "poll": {
          const params = rubika.pollingParams(body);
          const data = await rubika.call(token, "getUpdates", params);
          if (!Array.isArray(data.updates) || data.updates.length > 100) throw new ApiError(502, "INVALID_RUBIKA_RESPONSE", "Rubika returned an invalid updates batch.");
          const received_at = new Date().toISOString();
          const rows = await Promise.all(data.updates.map(async rawUpdate => {
            const update = redact(rawUpdate, token);
            const rawTime = update?.new_message?.time ?? update?.updated_message?.time;
            const seconds = Number(rawTime);
            const occurred_at = Number.isFinite(seconds) && seconds > 0 && seconds < 32503680000 ? new Date(seconds * 1000).toISOString() : received_at;
            return { event_hash: await digest(canonical(update)), type: String(update?.type ?? "Unknown").slice(0, 80), chat_id: typeof update?.chat_id === "string" ? update.chat_id.slice(0, 160) : null, occurred_at };
          }));
          const recorded = await db.recordEvents(scope, rows);
          await audit({ action: "poll", status: "success", received: data.updates.length, new_events: recorded.length });
          result = { updates: data.updates, next_offset_id: data.next_offset_id ?? null, received_at, new_events: recorded.length }; break;
        }
      }
      return response(redact({ ok: true, ...result }, token));
    } catch (error) {
      if (error instanceof ApiError) return response({ ok: false, error: error.message, code: error.code, ...error.details }, error.status);
      // Deliberately exclude stack traces and raw dependency errors from responses/logs.
      return response({ ok: false, error: "The server could not complete this request.", code: "INTERNAL_ERROR" }, 500);
    }
  };
}
