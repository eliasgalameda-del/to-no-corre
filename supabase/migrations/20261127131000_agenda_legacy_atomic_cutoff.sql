-- STAGED CUTOFF CANDIDATE. Never apply before explicit owner approval and
-- deployment/verification of the compatible client + agenda_legacy_kv_cas.
-- Restrictive policies AND with all permissive policies, even if other owner
-- policies exist. Blocks *direct* legacy-array writes while flag is false too;
-- authorized RPC uses the caller identity and bypasses RLS as owner.
-- Old apps may retain unsynced edits and whole-batch errors can block prefs.
create policy "agenda legacy arrays require atomic rpc insert" on public.kv
 as restrictive for insert to authenticated
 with check (key not in ('agendaplus_events','agendaplus_tasks'));
create policy "agenda legacy arrays require atomic rpc update" on public.kv
 as restrictive for update to authenticated
 using (key not in ('agendaplus_events','agendaplus_tasks'))
 with check (key not in ('agendaplus_events','agendaplus_tasks'));
create policy "agenda legacy arrays require atomic rpc delete" on public.kv
 as restrictive for delete to authenticated
 using (key not in ('agendaplus_events','agendaplus_tasks'));
