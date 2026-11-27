begin;
insert into auth.users(id,email) values ('10000000-0000-4000-8000-000000000001','cas-a@synthetic.invalid'), ('10000000-0000-4000-8000-000000000002','cas-b@synthetic.invalid');
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$
declare r jsonb; denied boolean;
begin
 r:=public.agenda_legacy_kv_cas('agendaplus_events',false,null,'[{"id":"a"}]');
 if r->>'status'<>'applied' then raise exception 'insert failed %',r; end if;
 r:=public.agenda_legacy_kv_cas('agendaplus_events',false,null,'[{"id":"b"}]');
 if r->>'status'<>'conflict' or r->'current_value'<>'[{"id":"a"}]'::jsonb then raise exception 'insert conflict failed %',r; end if;
 r:=public.agenda_legacy_kv_cas('agendaplus_events',true,'[{"id":"stale"}]','[{"id":"c"}]');
 if r->>'status'<>'conflict' or r->'current_value'<>'[{"id":"a"}]'::jsonb then raise exception 'stale update failed %',r; end if;
 r:=public.agenda_legacy_kv_cas('agendaplus_events',true,'[{"id":"a"}]','[{"id":"new"}]');
 if r->>'status'<>'applied' then raise exception 'matching update failed %',r; end if;
 denied:=false; begin perform public.agenda_legacy_kv_cas('agendaplus_theme',false,null,'[]'); exception when sqlstate '22023' then denied:=true; end;
 if not denied then raise exception 'invalid key accepted'; end if;
 denied:=false; begin perform public.agenda_legacy_kv_cas('agendaplus_events',true,'[]','{}'); exception when sqlstate '22023' then denied:=true; end;
 if not denied then raise exception 'invalid payload accepted'; end if;
 perform set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000002',true);
 r:=public.agenda_legacy_kv_cas('agendaplus_events',false,null,'[{"id":"account-b"}]');
 if r->>'status'<>'applied' then raise exception 'other account must have independent row %',r; end if;
 r:=public.agenda_legacy_kv_cas('agendaplus_events',true,'[{"id":"new"}]','[]');
 if r->>'status'<>'conflict' or r->'current_value'<>'[{"id":"account-b"}]'::jsonb then raise exception 'account isolation failed %',r; end if;
 perform set_config('request.jwt.claim.sub','',true);
 denied:=false; begin perform public.agenda_legacy_kv_cas('agendaplus_events',false,null,'[]'); exception when sqlstate '42501' then denied:=true; end;
 if not denied then raise exception 'missing identity accepted'; end if;
end $$;
reset role;
update public.agenda_sync_control set enabled=true where singleton=true;
set local role authenticated;
select set_config('request.jwt.claim.sub','10000000-0000-4000-8000-000000000001',true);
do $$ declare r jsonb; begin
 r:=public.agenda_legacy_kv_cas('agendaplus_events',true,'[{"id":"new"}]','[]');
 if r->>'status'<>'blocked' then raise exception 'enabled flag must block legacy CAS %',r; end if;
end $$;
reset role;
do $$ begin
 if has_function_privilege('anon','public.agenda_legacy_kv_cas(text,boolean,jsonb,jsonb)','EXECUTE') then raise exception 'anon has execute'; end if;
 if not has_function_privilege('authenticated','public.agenda_legacy_kv_cas(text,boolean,jsonb,jsonb)','EXECUTE') then raise exception 'authenticated lacks execute'; end if;
end $$;
rollback;
select 'PASS: DB legacy CAS transactional functional and ACL checks; rolled back' as result;
