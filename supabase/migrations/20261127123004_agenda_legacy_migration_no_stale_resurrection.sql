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
  -- The original table backfill is already the canonical snapshot for users with rows.
  -- Never merge their legacy whole-list cache: it may be stale and could resurrect deletions.
  if exists (select 1 from public.agenda_items a where a.user_id=v_uid) then
    update public.agenda_item_migrations set legacy_imported_at=now() where user_id=v_uid;
    return 0;
  end if;

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
