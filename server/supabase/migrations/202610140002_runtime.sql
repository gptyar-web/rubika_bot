-- Worker coordination is private and contains no bot credentials or message bodies.
begin;

create or replace function public.rubika_panel_v3_safe_runtime_json(p_value jsonb, p_depth integer default 0)
returns boolean language plpgsql immutable security invoker set search_path = public, pg_temp as $$
declare item record; element jsonb; value_text text;
begin
  if p_value is null or p_depth is null or p_depth < 0 or p_depth > 4 or octet_length(p_value::text) > 12000 then return false; end if;
  case jsonb_typeof(p_value)
    when 'object' then
      for item in select key, value from jsonb_each(p_value) loop
        if item.key !~ '^[a-zA-Z0-9_:.-]{1,160}$'
          or item.key ~* '(token|secret|authorization|password|passwd|api_?key|credential|private_?key)|^(text|message_body|raw|content|phone_number)$'
          or not public.rubika_panel_v3_safe_runtime_json(item.value, p_depth + 1) then return false; end if;
      end loop;
    when 'array' then
      if jsonb_array_length(p_value) > 100 then return false; end if;
      for element in select value from jsonb_array_elements(p_value) loop
        if not public.rubika_panel_v3_safe_runtime_json(element, p_depth + 1) then return false; end if;
      end loop;
    when 'string' then
      value_text := p_value #>> '{}';
      if length(value_text) > 160 or value_text !~ '^[A-Za-z0-9_:.,+ TZ/ -]*$' then return false; end if;
    when 'number' then null;
    when 'boolean' then null;
    when 'null' then null;
    else return false;
  end case;
  return true;
end;
$$;

create table if not exists public.rubika_panel_v3_runtime (
  scope text primary key references public.rubika_panel_v3_bots(scope) on delete cascade,
  lease_owner text,
  lease_until timestamptz,
  heartbeat_at timestamptz,
  offset_id text check (length(offset_id) <= 160),
  enabled boolean not null default true,
  status text not null default 'idle' check (status in ('idle','running','paused','error')),
  last_error_code text check (length(last_error_code) <= 160),
  updated_at timestamptz not null default now()
);
alter table public.rubika_panel_v3_runtime add column if not exists enabled boolean not null default true;

create table if not exists public.rubika_panel_v3_runtime_events (
  scope text not null references public.rubika_panel_v3_bots(scope) on delete cascade,
  event_key text not null check (event_key ~ '^[A-Za-z0-9_:.-]{1,160}$'),
  metadata jsonb not null check (jsonb_typeof(metadata) = 'object' and public.rubika_panel_v3_safe_runtime_json(metadata)),
  status text not null default 'pending' check (status in ('pending','success','skipped','rejected','unknown')),
  summary jsonb not null default '{}' check (jsonb_typeof(summary) = 'object' and public.rubika_panel_v3_safe_runtime_json(summary)),
  received_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (scope, event_key)
);
create index if not exists rubika_v3_runtime_events_recent on public.rubika_panel_v3_runtime_events(scope, received_at desc);

create table if not exists public.rubika_panel_v3_user_state (
  scope text not null references public.rubika_panel_v3_bots(scope) on delete cascade,
  chat_id text not null check (chat_id ~ '^[A-Za-z0-9_:.-]{1,160}$'),
  user_id text not null check (user_id ~ '^[A-Za-z0-9_:.-]{1,160}$'),
  state jsonb not null default '{}' check (jsonb_typeof(state) = 'object' and public.rubika_panel_v3_safe_runtime_json(state)),
  updated_at timestamptz not null default now(),
  primary key (scope, chat_id, user_id)
);

create table if not exists public.rubika_panel_v3_schedule_jobs (
  scope text not null references public.rubika_panel_v3_bots(scope) on delete cascade,
  schedule_id uuid not null,
  occurrence_at timestamptz not null,
  destination text not null check (destination ~ '^[A-Za-z0-9_:.-]{1,160}$'),
  operation_id uuid not null default gen_random_uuid(),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  snapshot_hash text check (snapshot_hash ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending' check (status in ('pending','success','rejected','unknown')),
  error_code text check (error_code ~ '^[A-Z0-9_]{1,80}$'),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (scope, schedule_id, occurrence_at, destination),
  unique (scope, operation_id)
);
-- Older local drafts may already have jobs. A missing fingerprint blocks reuse of
-- that schedule ID; never guess the original snapshot or remove deduplication rows.
alter table public.rubika_panel_v3_schedule_jobs add column if not exists snapshot_hash text
  check (snapshot_hash ~ '^[0-9a-f]{64}$');
create index if not exists rubika_v3_schedule_jobs_recent on public.rubika_panel_v3_schedule_jobs(scope, created_at desc);

-- Even private table updates cannot rewrite the identity or a terminal result.
create or replace function public.rubika_panel_v3_guard_runtime_outcome()
returns trigger language plpgsql security invoker set search_path = public, pg_temp as $$
declare mutable_fields text[];
begin
  mutable_fields := case when tg_table_name = 'rubika_panel_v3_runtime_events'
    then array['status','summary','completed_at'] else array['status','error_code','completed_at'] end;
  if (to_jsonb(new) - mutable_fields) is distinct from (to_jsonb(old) - mutable_fields)
    or (old.status <> 'pending' and new is distinct from old) then
    raise exception 'Runtime outcome identity and terminal results are immutable';
  end if;
  return new;
end;
$$;
drop trigger if exists rubika_v3_guard_event_outcome on public.rubika_panel_v3_runtime_events;
create trigger rubika_v3_guard_event_outcome before update on public.rubika_panel_v3_runtime_events
  for each row execute function public.rubika_panel_v3_guard_runtime_outcome();
drop trigger if exists rubika_v3_guard_schedule_outcome on public.rubika_panel_v3_schedule_jobs;
create trigger rubika_v3_guard_schedule_outcome before update on public.rubika_panel_v3_schedule_jobs
  for each row execute function public.rubika_panel_v3_guard_runtime_outcome();

-- Only explicit fields from a consented interaction are stored, never raw updates.
-- Waiting for consent stores an empty values object; every session expires in 15 min.
create or replace function public.rubika_panel_v3_safe_session(p_data jsonb)
returns boolean language plpgsql immutable security invoker set search_path = public, pg_temp as $$
declare item record; values_object jsonb;
begin
  if jsonb_typeof(p_data) is distinct from 'object' or octet_length(p_data::text) > 16000
    or coalesce(p_data->>'kind','') not in ('flow','menu')
    or exists (select 1 from jsonb_object_keys(p_data) as key where key not in
      ('kind','stage','bot_id','chat_id','user_id','flow_id','menu_id','step','path','page','consented','values','answers','expires_at')) then return false; end if;
  if p_data ? 'stage' and p_data->>'stage' not in ('awaiting_consent','answering','completed') then return false; end if;
  if not public.rubika_panel_v3_safe_runtime_json(p_data - 'values' - 'answers' - 'expires_at') then return false; end if;
  if coalesce(p_data->'answers','{}'::jsonb) <> '{}'::jsonb and coalesce(p_data->'values','{}'::jsonb) <> '{}'::jsonb then return false; end if;
  values_object := coalesce(p_data->'answers',p_data->'values','{}'::jsonb);
  if jsonb_typeof(values_object) <> 'object' or (select count(*) from jsonb_object_keys(values_object)) > 20 then return false; end if;
  if p_data->'consented' is distinct from 'true'::jsonb and values_object <> '{}'::jsonb then return false; end if;
  for item in select key,value from jsonb_each(values_object) loop
    if item.key !~ '^[A-Za-z][A-Za-z0-9_]{0,63}$' or item.key ~* '(token|secret|authorization|password|passwd|api_?key|credential|private_?key)'
      or jsonb_typeof(item.value) not in ('string','number','boolean')
      or (jsonb_typeof(item.value) = 'string' and length(item.value #>> '{}') > 500) then return false; end if;
  end loop;
  return true;
end;
$$;

create table if not exists public.rubika_panel_v3_sessions (
  scope text not null references public.rubika_panel_v3_bots(scope) on delete cascade,
  chat_id text not null check (chat_id ~ '^[A-Za-z0-9_:.-]{1,160}$'),
  user_id text not null check (user_id ~ '^[A-Za-z0-9_:.-]{1,160}$'),
  data jsonb not null check (public.rubika_panel_v3_safe_session(data)),
  expires_at timestamptz not null check (expires_at <= updated_at + interval '15 minutes'),
  updated_at timestamptz not null default now(),
  primary key (scope,chat_id,user_id)
);
create index if not exists rubika_v3_sessions_expiry on public.rubika_panel_v3_sessions(expires_at);

-- An expired lease may be recovered. A live lease is extended only by its owner.
create or replace function public.rubika_panel_v3_set_enabled(p_scope text, p_enabled boolean)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if p_enabled is null then raise exception 'Enabled must be boolean'; end if;
  insert into public.rubika_panel_v3_runtime(scope) values (p_scope) on conflict do nothing;
  update public.rubika_panel_v3_runtime set enabled = p_enabled,
    status = case when not p_enabled then 'paused' when status = 'paused' then 'idle' else status end,
    updated_at = now() where scope = p_scope;
  return found;
end;
$$;

create or replace function public.rubika_panel_v3_acquire_lease(p_scope text, p_owner text, p_ttl integer)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare lease public.rubika_panel_v3_runtime; won boolean;
begin
  if p_owner is null or p_owner !~ '^[A-Za-z0-9_:.-]{1,160}$' or p_ttl is null or p_ttl < 15 or p_ttl > 300 then raise exception 'Invalid lease'; end if;
  insert into public.rubika_panel_v3_runtime(scope) values (p_scope) on conflict do nothing;
  update public.rubika_panel_v3_runtime
  set lease_owner = p_owner, lease_until = now() + make_interval(secs => p_ttl), updated_at = now()
  where scope = p_scope and (lease_until is null or lease_until <= now() or lease_owner = p_owner)
  returning * into lease;
  won := found;
  if not won then select * into lease from public.rubika_panel_v3_runtime where scope = p_scope; end if;
  return jsonb_build_object('acquired', won, 'expires_at', lease.lease_until);
end;
$$;

create or replace function public.rubika_panel_v3_release_lease(p_scope text, p_owner text)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  update public.rubika_panel_v3_runtime set lease_owner = null, lease_until = null,
    status = case when enabled then 'idle' else 'paused' end, updated_at = now()
  where scope = p_scope and lease_owner = p_owner;
  return found;
end;
$$;

create or replace function public.rubika_panel_v3_save_runtime(p_scope text, p_owner text, p_data jsonb)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare runtime public.rubika_panel_v3_runtime;
begin
  if jsonb_typeof(p_data) is distinct from 'object' or not public.rubika_panel_v3_safe_runtime_json(p_data)
    or exists (select 1 from jsonb_object_keys(p_data) as key where key not in ('offset_id','status','last_error_code')) then raise exception 'Invalid runtime fields'; end if;
  select * into runtime from public.rubika_panel_v3_runtime where scope = p_scope for update;
  if not runtime.enabled and p_data ? 'offset_id' and (p_data->>'offset_id') is distinct from runtime.offset_id
    then raise exception 'Runtime cursor cannot advance while paused'; end if;
  update public.rubika_panel_v3_runtime set
    offset_id = case when p_data ? 'offset_id' then p_data->>'offset_id' else offset_id end,
    status = case when not enabled then 'paused' else coalesce(p_data->>'status', status) end,
    last_error_code = case when p_data ? 'last_error_code' then p_data->>'last_error_code' else last_error_code end,
    heartbeat_at = now(), updated_at = now()
  where scope = p_scope and ((p_owner is not null and lease_owner = p_owner and lease_until > now())
    or (p_owner is null and (lease_until is null or lease_until <= now())));
  if not found then raise exception 'Runtime lease is not owned'; end if;
  return true;
end;
$$;

create or replace function public.rubika_panel_v3_claim_event(p_scope text, p_key text, p_metadata jsonb)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare event public.rubika_panel_v3_runtime_events; won boolean;
begin
  if jsonb_typeof(p_metadata) is distinct from 'object' or not public.rubika_panel_v3_safe_runtime_json(p_metadata)
    or exists (select 1 from jsonb_object_keys(p_metadata) as key where key not in ('type','chat_id','user_id','message_id','occurred_at')) then raise exception 'Invalid event metadata'; end if;
  insert into public.rubika_panel_v3_runtime_events(scope, event_key, metadata)
  values (p_scope, p_key, p_metadata) on conflict do nothing;
  won := found;
  select * into event from public.rubika_panel_v3_runtime_events where scope = p_scope and event_key = p_key;
  return jsonb_build_object('claimed',won,'status',event.status,'summary',event.summary);
end;
$$;

create or replace function public.rubika_panel_v3_finish_event(p_scope text, p_key text, p_status text, p_summary jsonb)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if p_status is null or p_status not in ('success','skipped','rejected','unknown') then raise exception 'Invalid event status'; end if;
  update public.rubika_panel_v3_runtime_events set status = p_status, summary = p_summary, completed_at = now()
  where scope = p_scope and event_key = p_key and status = 'pending';
  return found;
end;
$$;

-- Locking the schedule serializes destination claims, cancellation, and edits.
-- A claimed schedule ID remains bound to its original snapshot permanently.
-- No new occurrence/destination may start while any outcome is unconfirmed.
create or replace function public.rubika_panel_v3_claim_schedule(p_scope text, p_schedule_id uuid, p_occurrence timestamptz, p_destination text, p_snapshot jsonb, p_hash text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare
  job public.rubika_panel_v3_schedule_jobs; won boolean; resource_data jsonb;
  schedule_fingerprint text; chats jsonb; chat text; starts timestamptz; starts_text text;
  repeat_data jsonb; interval_minutes integer := 0; occurrences integer := 1;
  occurrence_index integer := 0; delta numeric; method text; halted_status text; runtime_enabled boolean;
begin
  select enabled into runtime_enabled from public.rubika_panel_v3_runtime where scope = p_scope for share;
  if runtime_enabled = false then return jsonb_build_object('claimed',false,'status','blocked'); end if;
  select data into resource_data from public.rubika_panel_v3_resources
  where scope = p_scope and collection = 'schedules' and id = p_schedule_id for update;
  if resource_data is null or resource_data is distinct from p_snapshot
    or resource_data->>'status' is distinct from 'approved'
    or resource_data->'enabled' is distinct from 'true'::jsonb
    or resource_data->'authorized' is distinct from 'true'::jsonb
    or p_occurrence is null or not isfinite(p_occurrence) or p_occurrence > now()
    or p_destination is null or p_destination !~ '^[A-Za-z0-9_:.-]{1,160}$'
    or p_hash is null or p_hash !~ '^[0-9a-f]{64}$'
    then return jsonb_build_object('claimed',false,'status','blocked'); end if;

  method := coalesce(resource_data->>'method', 'sendMessage');
  if method not in ('sendMessage','sendPoll','sendLocation','sendContact','sendSticker','sendFile','forwardMessage')
    then return jsonb_build_object('claimed',false,'status','blocked'); end if;
  starts_text := coalesce(resource_data->>'scheduled_at',resource_data->>'scheduledAt');
  if starts_text is null or starts_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?(Z|[+-][0-9]{2}:[0-9]{2})$'
    then return jsonb_build_object('claimed',false,'status','blocked'); end if;
  begin starts := starts_text::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then
    return jsonb_build_object('claimed',false,'status','blocked');
  end;
  chats := coalesce(nullif(resource_data->'chat_ids','null'::jsonb), jsonb_build_array(coalesce(
    nullif(resource_data->'chat_id','null'::jsonb), nullif(resource_data#>'{params,chat_id}','null'::jsonb), resource_data#>'{params,to_chat_id}')));
  if jsonb_typeof(chats) is distinct from 'array' then return jsonb_build_object('claimed',false,'status','blocked'); end if;
  if jsonb_array_length(chats) < 1 or jsonb_array_length(chats) > 20
    or exists (select 1 from jsonb_array_elements(chats) as item where jsonb_typeof(item) <> 'string' or (item #>> '{}') !~ '^[A-Za-z0-9_:.-]{1,160}$')
    or (select count(distinct item) from jsonb_array_elements(chats) as item) <> jsonb_array_length(chats)
    or not chats ? p_destination then return jsonb_build_object('claimed',false,'status','blocked'); end if;
  -- Hold registered chats through the claim transaction, including forwarding's source.
  for chat in select value from jsonb_array_elements_text(chats) loop
    perform 1 from public.rubika_panel_v3_chats where scope = p_scope and chat_id = chat for share;
    if not found then return jsonb_build_object('claimed',false,'status','blocked'); end if;
  end loop;
  if method = 'forwardMessage' then
    perform 1 from public.rubika_panel_v3_chats where scope = p_scope and chat_id = resource_data#>>'{params,from_chat_id}' for share;
    if not found then return jsonb_build_object('claimed',false,'status','blocked'); end if;
  end if;

  repeat_data := nullif(resource_data->'recurrence','null'::jsonb);
  if repeat_data is not null then
    if jsonb_typeof(repeat_data) is distinct from 'object'
      or jsonb_typeof(repeat_data->'interval_minutes') is distinct from 'number'
      or jsonb_typeof(repeat_data->'max_occurrences') is distinct from 'number'
      then return jsonb_build_object('claimed',false,'status','blocked'); end if;
    delta := (repeat_data->>'interval_minutes')::numeric;
    if delta < 60 or delta > 525600 or trunc(delta) <> delta then return jsonb_build_object('claimed',false,'status','blocked'); end if;
    interval_minutes := delta::integer;
    delta := (repeat_data->>'max_occurrences')::numeric;
    if delta < 1 or delta > 366 or trunc(delta) <> delta then return jsonb_build_object('claimed',false,'status','blocked'); end if;
    occurrences := delta::integer;
  end if;
  if interval_minutes = 0 then
    if p_occurrence <> starts then return jsonb_build_object('claimed',false,'status','blocked'); end if;
  else
    delta := extract(epoch from (p_occurrence - starts)) / (interval_minutes::numeric * 60);
    if delta < 0 or delta >= occurrences or trunc(delta) <> delta then return jsonb_build_object('claimed',false,'status','blocked'); end if;
    occurrence_index := delta::integer;
  end if;

  schedule_fingerprint := encode(sha256(convert_to(resource_data::text,'UTF8')),'hex');
  if exists (select 1 from public.rubika_panel_v3_schedule_jobs
    where scope = p_scope and schedule_id = p_schedule_id
      and (snapshot_hash is distinct from schedule_fingerprint or content_hash is distinct from p_hash))
    then return jsonb_build_object('claimed',false,'status','blocked'); end if;
  select * into job from public.rubika_panel_v3_schedule_jobs
  where scope = p_scope and schedule_id = p_schedule_id and occurrence_at = p_occurrence and destination = p_destination;
  if found then return jsonb_build_object('claimed',false,'status',job.status,'operation_id',job.operation_id,'content_hash',job.content_hash); end if;
  select status into halted_status from public.rubika_panel_v3_schedule_jobs
  where scope = p_scope and schedule_id = p_schedule_id and status <> 'success'
  order by occurrence_at,destination limit 1;
  if found then return jsonb_build_object('claimed',false,'status',halted_status); end if;
  -- A caller cannot skip an earlier occurrence, even when every date is already due.
  if occurrence_index > 0 and exists (
    select 1 from generate_series(0, occurrence_index - 1) as prior(index)
      cross join jsonb_array_elements_text(chats) as target(chat_id)
    where not exists (select 1 from public.rubika_panel_v3_schedule_jobs as previous
      where previous.scope = p_scope and previous.schedule_id = p_schedule_id and previous.destination = target.chat_id
        and previous.occurrence_at = starts + make_interval(mins => interval_minutes * prior.index) and previous.status = 'success'))
    then return jsonb_build_object('claimed',false,'status','blocked'); end if;
  insert into public.rubika_panel_v3_schedule_jobs(scope,schedule_id,occurrence_at,destination,content_hash,snapshot_hash)
  values (p_scope,p_schedule_id,p_occurrence,p_destination,p_hash,schedule_fingerprint) on conflict do nothing;
  won := found;
  select * into job from public.rubika_panel_v3_schedule_jobs
  where scope = p_scope and schedule_id = p_schedule_id and occurrence_at = p_occurrence and destination = p_destination;
  return jsonb_build_object('claimed',won,'status',job.status,'operation_id',job.operation_id,'content_hash',job.content_hash);
end;
$$;

create or replace function public.rubika_panel_v3_finish_schedule(p_scope text, p_operation uuid, p_status text, p_error text default null)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
begin
  if p_status is null or p_status not in ('success','rejected','unknown')
    or (p_error is not null and p_error !~ '^[A-Z0-9_]{1,80}$') then raise exception 'Invalid schedule result'; end if;
  update public.rubika_panel_v3_schedule_jobs set status = p_status, error_code = p_error, completed_at = now()
  where scope = p_scope and operation_id = p_operation and status = 'pending';
  return found;
end;
$$;

alter table public.rubika_panel_v3_runtime enable row level security;
alter table public.rubika_panel_v3_runtime_events enable row level security;
alter table public.rubika_panel_v3_user_state enable row level security;
alter table public.rubika_panel_v3_schedule_jobs enable row level security;
alter table public.rubika_panel_v3_sessions enable row level security;
revoke all on public.rubika_panel_v3_runtime,public.rubika_panel_v3_runtime_events,
  public.rubika_panel_v3_user_state,public.rubika_panel_v3_schedule_jobs,public.rubika_panel_v3_sessions from anon,authenticated;
grant all on public.rubika_panel_v3_runtime,public.rubika_panel_v3_runtime_events,
  public.rubika_panel_v3_user_state,public.rubika_panel_v3_schedule_jobs,public.rubika_panel_v3_sessions to service_role;
revoke execute on function public.rubika_panel_v3_safe_runtime_json(jsonb,integer),
  public.rubika_panel_v3_safe_session(jsonb),
  public.rubika_panel_v3_guard_runtime_outcome(),
  public.rubika_panel_v3_set_enabled(text,boolean),
  public.rubika_panel_v3_acquire_lease(text,text,integer),public.rubika_panel_v3_release_lease(text,text),
  public.rubika_panel_v3_save_runtime(text,text,jsonb),public.rubika_panel_v3_claim_event(text,text,jsonb),
  public.rubika_panel_v3_finish_event(text,text,text,jsonb),public.rubika_panel_v3_claim_schedule(text,uuid,timestamptz,text,jsonb,text),
  public.rubika_panel_v3_finish_schedule(text,uuid,text,text) from public,anon,authenticated;
grant execute on function public.rubika_panel_v3_safe_runtime_json(jsonb,integer),
  public.rubika_panel_v3_safe_session(jsonb),
  public.rubika_panel_v3_guard_runtime_outcome(),
  public.rubika_panel_v3_set_enabled(text,boolean),
  public.rubika_panel_v3_acquire_lease(text,text,integer),public.rubika_panel_v3_release_lease(text,text),
  public.rubika_panel_v3_save_runtime(text,text,jsonb),public.rubika_panel_v3_claim_event(text,text,jsonb),
  public.rubika_panel_v3_finish_event(text,text,text,jsonb),public.rubika_panel_v3_claim_schedule(text,uuid,timestamptz,text,jsonb,text),
  public.rubika_panel_v3_finish_schedule(text,uuid,text,text) to service_role;

commit;
