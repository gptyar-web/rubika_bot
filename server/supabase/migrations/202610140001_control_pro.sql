-- A separate versioned schema avoids guessing the unavailable legacy table columns.
-- Existing rubika_panel_bots / rubika_panel_groups and their data remain untouched.
begin;

create table if not exists public.rubika_panel_v3_bots (
  scope text primary key check (scope ~ '^[0-9a-f]{64}$'),
  bot_id text not null,
  name text not null,
  username text not null default '',
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create table if not exists public.rubika_panel_v3_chats (
  scope text not null references public.rubika_panel_v3_bots(scope) on delete cascade,
  chat_id text not null,
  title text not null,
  type text not null check (type in ('group', 'channel')),
  settings jsonb not null default '{}'::jsonb check (jsonb_typeof(settings) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (scope, chat_id)
);

create table if not exists public.rubika_panel_v3_resources (
  scope text not null references public.rubika_panel_v3_bots(scope) on delete cascade,
  collection text not null check (collection in ('drafts','templates','automations','schedules','tickets','users','violations','consents')),
  id uuid not null,
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (scope, collection, id)
);
create index if not exists rubika_v3_resources_recent on public.rubika_panel_v3_resources(scope, collection, updated_at desc);

create table if not exists public.rubika_panel_v3_audit (
  id uuid primary key default gen_random_uuid(),
  scope text not null references public.rubika_panel_v3_bots(scope) on delete cascade,
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  created_at timestamptz not null default now()
);
create index if not exists rubika_v3_audit_recent on public.rubika_panel_v3_audit(scope, created_at desc);

create table if not exists public.rubika_panel_v3_operations (
  scope text not null references public.rubika_panel_v3_bots(scope) on delete cascade,
  operation_id uuid not null,
  request_hash text not null,
  status text not null check (status in ('pending', 'success', 'rejected', 'unknown')) default 'pending',
  result jsonb,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (scope, operation_id)
);

create table if not exists public.rubika_panel_v3_events (
  scope text not null references public.rubika_panel_v3_bots(scope) on delete cascade,
  event_hash text not null,
  type text not null,
  chat_id text,
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  primary key (scope, event_hash)
);
create index if not exists rubika_v3_events_recent on public.rubika_panel_v3_events(scope, occurred_at desc);

create table if not exists public.rubika_panel_v3_rate_limits (
  bucket text not null,
  window_start timestamptz not null,
  count integer not null,
  primary key (bucket, window_start)
);

-- Edge instances may be concurrent: rate limiting and operation claiming are atomic.
create or replace function public.rubika_panel_v3_rate_limit(p_bucket text, p_limit integer)
returns boolean language plpgsql security invoker set search_path = public, pg_temp as $$
declare current_count integer;
begin
  if p_limit < 1 or p_limit > 500 or length(p_bucket) > 100 then
    return false;
  end if;
  insert into public.rubika_panel_v3_rate_limits(bucket, window_start, count)
  values (p_bucket, date_trunc('minute', now()), 1)
  on conflict (bucket, window_start)
  do update set count = rubika_panel_v3_rate_limits.count + 1
  returning count into current_count;
  -- Old counters contain no credentials or IPs; bound storage continuously.
  delete from public.rubika_panel_v3_rate_limits where window_start < now() - interval '1 day';
  return current_count <= p_limit;
end;
$$;

create or replace function public.rubika_panel_v3_claim_operation(p_scope text, p_id uuid, p_hash text)
returns jsonb language plpgsql security invoker set search_path = public, pg_temp as $$
declare existing_row public.rubika_panel_v3_operations; claimed boolean;
begin
  insert into public.rubika_panel_v3_operations(scope, operation_id, request_hash)
  values (p_scope, p_id, p_hash)
  on conflict (scope, operation_id) do nothing;
  claimed := found;
  select * into existing_row from public.rubika_panel_v3_operations where scope = p_scope and operation_id = p_id;
  return jsonb_build_object('claimed', claimed, 'status', existing_row.status,
    'request_hash', existing_row.request_hash, 'result', existing_row.result, 'error_code', existing_row.error_code);
end;
$$;

-- No public browser access and no permissive policies. Only the private service role
-- used inside the token-authenticated Edge Function may access these tables/RPCs.
alter table public.rubika_panel_v3_bots enable row level security;
alter table public.rubika_panel_v3_chats enable row level security;
alter table public.rubika_panel_v3_resources enable row level security;
alter table public.rubika_panel_v3_audit enable row level security;
alter table public.rubika_panel_v3_operations enable row level security;
alter table public.rubika_panel_v3_events enable row level security;
alter table public.rubika_panel_v3_rate_limits enable row level security;

revoke all on public.rubika_panel_v3_bots, public.rubika_panel_v3_chats,
  public.rubika_panel_v3_resources, public.rubika_panel_v3_audit,
  public.rubika_panel_v3_operations, public.rubika_panel_v3_events,
  public.rubika_panel_v3_rate_limits from anon, authenticated;
grant all on public.rubika_panel_v3_bots, public.rubika_panel_v3_chats,
  public.rubika_panel_v3_resources, public.rubika_panel_v3_audit,
  public.rubika_panel_v3_operations, public.rubika_panel_v3_events,
  public.rubika_panel_v3_rate_limits to service_role;
revoke execute on function public.rubika_panel_v3_rate_limit(text, integer) from public, anon, authenticated;
revoke execute on function public.rubika_panel_v3_claim_operation(text, uuid, text) from public, anon, authenticated;
grant execute on function public.rubika_panel_v3_rate_limit(text, integer) to service_role;
grant execute on function public.rubika_panel_v3_claim_operation(text, uuid, text) to service_role;

commit;
