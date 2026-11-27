-- Staged cutover barrier: does not change runtime behavior while
-- public.agenda_sync_control.enabled=false. This migration is intentionally
-- NOT applied to production in this stage.
--
-- Once the flag is true, legacy clients may still read the old arrays but
-- cannot insert/update/delete them. The versioned agenda_items CAS path is
-- then authoritative. All non-agenda kv keys retain owner-scoped writes.
-- The existing own-kv ALL policy must be replaced because permissive policies
-- are ORed; adding a second restrictive-looking policy would not block writes.

drop policy if exists "own kv" on public.kv;

create policy "own kv select" on public.kv
  for select to authenticated
  using (user_id = auth.uid());

create policy "own kv insert with agenda barrier" on public.kv
  for insert to authenticated
  with check (
    user_id = auth.uid()
    and (
      key not in ('agendaplus_events', 'agendaplus_tasks')
      or not public.agenda_sync_enabled()
    )
  );

create policy "own kv update with agenda barrier" on public.kv
  for update to authenticated
  using (
    user_id = auth.uid()
    and (
      key not in ('agendaplus_events', 'agendaplus_tasks')
      or not public.agenda_sync_enabled()
    )
  )
  with check (
    user_id = auth.uid()
    and (
      key not in ('agendaplus_events', 'agendaplus_tasks')
      or not public.agenda_sync_enabled()
    )
  );

create policy "own kv delete with agenda barrier" on public.kv
  for delete to authenticated
  using (
    user_id = auth.uid()
    and (
      key not in ('agendaplus_events', 'agendaplus_tasks')
      or not public.agenda_sync_enabled()
    )
  );
