create table if not exists public.agenda_sync_control (
  singleton boolean primary key default true check (singleton),
  enabled boolean not null default false,
  changed_at timestamptz not null default now()
);
insert into public.agenda_sync_control(singleton, enabled) values (true, false)
on conflict (singleton) do nothing;
alter table public.agenda_sync_control enable row level security;
revoke all on public.agenda_sync_control from public, anon, authenticated, service_role;

create table if not exists public.agenda_item_migrations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  legacy_imported_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.agenda_item_migrations enable row level security;
revoke all on public.agenda_item_migrations from public, anon, authenticated, service_role;

-- Agenda rows are read with RLS; all authenticated writes go through the CAS RPC.
revoke insert, update, delete, truncate, references, trigger on public.agenda_items from public, anon, authenticated;
grant select on public.agenda_items to authenticated;

create or replace function public.agenda_sync_enabled()
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_uid uuid := auth.uid(); v_enabled boolean;
begin
  if v_uid is null then raise exception 'authentication_required' using errcode = '28000'; end if;
  select c.enabled into v_enabled from public.agenda_sync_control c where c.singleton = true;
  return coalesce(v_enabled, false);
end;
$$;
revoke all on function public.agenda_sync_enabled() from public, anon, service_role;
grant execute on function public.agenda_sync_enabled() to authenticated;

create or replace function public.agenda_item_cas(
  p_item_type text,
  p_item_id text,
  p_payload jsonb,
  p_expected_version bigint,
  p_is_delete boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_enabled boolean;
  v_version bigint;
  v_current jsonb;
  v_next jsonb;
begin
  if v_uid is null then raise exception 'authentication_required' using errcode = '28000'; end if;
  select c.enabled into v_enabled from public.agenda_sync_control c where c.singleton = true;
  if not coalesce(v_enabled, false) then raise exception 'agenda_sync_not_enabled' using errcode = '55000'; end if;
  if p_item_type not in ('event','task') or p_item_id is null or length(btrim(p_item_id)) = 0 then
    raise exception 'invalid_agenda_item_key' using errcode = '22023';
  end if;
  if p_is_delete then
    if p_expected_version is null then raise exception 'delete_requires_expected_version' using errcode = '22023'; end if;
    v_next := jsonb_build_object('_deleted', true);
  else
    if p_payload is null or jsonb_typeof(p_payload) <> 'object' or p_payload->>'id' is distinct from p_item_id then
      raise exception 'invalid_agenda_item_payload' using errcode = '22023';
    end if;
    v_next := p_payload;
  end if;

  if p_expected_version is null then
    if p_is_delete then raise exception 'delete_requires_expected_version' using errcode = '22023'; end if;
    insert into public.agenda_items(user_id,item_type,item_id,payload,version,updated_at)
      values (v_uid,p_item_type,p_item_id,v_next,1,now())
      on conflict (user_id,item_type,item_id) do nothing
      returning version,payload into v_version,v_current;
    if found then return jsonb_build_object('status','applied','version',v_version,'payload',v_current); end if;
  else
    update public.agenda_items a set payload=v_next, version=a.version+1, updated_at=now()
      where a.user_id=v_uid and a.item_type=p_item_type and a.item_id=p_item_id and a.version=p_expected_version
      returning a.version,a.payload into v_version,v_current;
    if found then return jsonb_build_object('status','applied','version',v_version,'payload',v_current); end if;
  end if;

  select a.version,a.payload into v_version,v_current from public.agenda_items a
    where a.user_id=v_uid and a.item_type=p_item_type and a.item_id=p_item_id;
  if not found then return jsonb_build_object('status','not_found'); end if;
  return jsonb_build_object('status','conflict','version',v_version,'payload',v_current);
end;
$$;
revoke all on function public.agenda_item_cas(text,text,jsonb,bigint,boolean) from public, anon, service_role;
grant execute on function public.agenda_item_cas(text,text,jsonb,bigint,boolean) to authenticated;

create or replace function public.agenda_migrate_legacy_items()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_enabled boolean;
  v_imported_at timestamptz;
  v_events jsonb;
  v_tasks jsonb;
  v_pair record;
  v_item jsonb;
  v_item_id text;
  v_count integer := 0;
begin
  if v_uid is null then raise exception 'authentication_required' using errcode = '28000'; end if;
  select c.enabled into v_enabled from public.agenda_sync_control c where c.singleton = true;
  if not coalesce(v_enabled, false) then raise exception 'agenda_sync_not_enabled' using errcode = '55000'; end if;
  insert into public.agenda_item_migrations(user_id) values (v_uid) on conflict (user_id) do nothing;
  select m.legacy_imported_at into v_imported_at from public.agenda_item_migrations m where m.user_id=v_uid for update;
  if v_imported_at is not null then return 0; end if;
  select k.value into v_events from public.kv k where k.user_id=v_uid and k.key='agendaplus_events';
  select k.value into v_tasks from public.kv k where k.user_id=v_uid and k.key='agendaplus_tasks';
  for v_pair in select 'event'::text as item_type, v_events as items union all select 'task'::text, v_tasks loop
    if jsonb_typeof(v_pair.items) = 'array' then
      for v_item in select value from jsonb_array_elements(v_pair.items) loop
        if jsonb_typeof(v_item) = 'object' and jsonb_typeof(v_item->'id') in ('string','number') then
          v_item_id := v_item->>'id';
          if v_item_id is not null and length(btrim(v_item_id)) > 0 then
            insert into public.agenda_items(user_id,item_type,item_id,payload,version,updated_at)
              values (v_uid,v_pair.item_type,v_item_id,v_item,1,now())
              on conflict (user_id,item_type,item_id) do nothing;
            if found then v_count := v_count + 1; end if;
          end if;
        end if;
      end loop;
    end if;
  end loop;
  update public.agenda_item_migrations set legacy_imported_at=now() where user_id=v_uid;
  return v_count;
end;
$$;
revoke all on function public.agenda_migrate_legacy_items() from public, anon, service_role;
grant execute on function public.agenda_migrate_legacy_items() to authenticated;
