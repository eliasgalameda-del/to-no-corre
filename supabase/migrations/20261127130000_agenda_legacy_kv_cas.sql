-- Atomic compare-and-swap for the two legacy array keys, staging candidate.
-- This does not protect against legacy builds that still have direct kv DML;
-- enable the owner-scoped RLS write barrier before a production cutover.
create or replace function public.agenda_legacy_kv_cas(
  p_key text,
  p_expected_exists boolean,
  p_expected_value jsonb,
  p_new_value jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_written jsonb;
  v_current jsonb;
  v_exists boolean;
  v_sync_enabled boolean;
begin
  if v_uid is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;
  if p_key is null or p_key not in ('agendaplus_events', 'agendaplus_tasks') then
    raise exception 'invalid_agenda_legacy_key' using errcode = '22023';
  end if;
  if p_expected_exists is null or p_new_value is null or jsonb_typeof(p_new_value) <> 'array' then
    raise exception 'invalid_agenda_legacy_payload' using errcode = '22023';
  end if;
  -- Serialize the legacy write with the administrative flag UPDATE. A cutover
  -- that locks/updates this same singleton row cannot pass an in-flight write.
  select c.enabled into v_sync_enabled from public.agenda_sync_control as c
    where c.singleton = true for share;
  if not found then
    raise exception 'agenda_sync_control_missing' using errcode = '55000';
  end if;
  if v_sync_enabled then
    return jsonb_build_object('status','blocked','reason','normalized_sync_enabled');
  end if;

  if p_expected_exists then
    update public.kv as k
       set value = p_new_value, updated_at = now()
     where k.user_id = v_uid
       and k.key = p_key
       and k.value is not distinct from p_expected_value
    returning k.value into v_written;
  else
    insert into public.kv(user_id,key,value,updated_at)
    values (v_uid,p_key,p_new_value,now())
    on conflict (user_id,key) do nothing
    returning value into v_written;
  end if;

  if found then
    return jsonb_build_object('status','applied','value',v_written);
  end if;

  select k.value into v_current
    from public.kv as k
   where k.user_id = v_uid and k.key = p_key;
  v_exists := found;
  return jsonb_build_object(
    'status','conflict',
    'current_exists',v_exists,
    'current_value',case when v_exists then v_current else null end
  );
end;
$$;

revoke all on function public.agenda_legacy_kv_cas(text,boolean,jsonb,jsonb) from public, anon, service_role;
grant execute on function public.agenda_legacy_kv_cas(text,boolean,jsonb,jsonb) to authenticated;
