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
  if p_item_type is null or p_item_type not in ('event','task') or p_item_id is null or length(btrim(p_item_id)) = 0 then
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
