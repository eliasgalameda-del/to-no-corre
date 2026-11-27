# Staged CAS cutover verification plan (not executed)

Do not run against production and do not create production users. Use a disposable Supabase staging project with two dedicated authenticated test accounts, real issued JWT sessions, and only synthetic schedule rows. Do not claim an RLS test based only on `SET ROLE` or a hand-written JWT claim; that is not equivalent to a valid PostgREST-authenticated session.

## Read-only production preflight before any cutover

1. Confirm `agenda_sync_control.enabled = false` and record the migration list.
2. For each account, compare keys/IDs and content hashes from `kv.agendaplus_events` / `kv.agendaplus_tasks` against non-tombstone `agenda_items` rows. Do not merge automatically. Any mismatch requires owner review/resolution before the flag changes; the importer deliberately skips users that already have normalized rows.
3. Review the expected RLS policies and function ACLs from catalogs. `agenda_items` must allow owner-only SELECT, no direct authenticated/service-role DML, and authenticated EXECUTE only on the three agenda RPCs.

Example read-only mismatch query (run only in a staging copy / approved admin session; it reveals IDs and hashes, not full item payloads):

```sql
with legacy as (
  select k.user_id, case k.key when 'agendaplus_events' then 'event' else 'task' end as item_type,
         x.item->>'id' as item_id, md5(x.item::text) as payload_hash
  from public.kv k
  cross join lateral jsonb_array_elements(case when jsonb_typeof(k.value)='array' then k.value else '[]'::jsonb end) x(item)
  where k.key in ('agendaplus_events','agendaplus_tasks')
), normalized as (
  select user_id, item_type, item_id, md5(payload::text) as payload_hash
  from public.agenda_items where payload->>'_deleted' is distinct from 'true'
)
select coalesce(l.user_id,n.user_id) as user_id, coalesce(l.item_type,n.item_type) as item_type,
       coalesce(l.item_id,n.item_id) as item_id,
       l.payload_hash as legacy_hash, n.payload_hash as normalized_hash
from legacy l full join normalized n using (user_id,item_type,item_id)
where l.item_id is null or n.item_id is null or l.payload_hash is distinct from n.payload_hash
order by 1,2,3;
```

## Disposable two-account integration tests

- With the flag off: legacy account A can still sync both agenda arrays and non-agenda settings; scheduler dry mode follows the legacy arrays.
- After deploying the staged barrier migration in staging but leaving the flag off: the same legacy writes still work; reads stay owner-scoped.
- Enable the flag only in disposable staging: stale-client writes to `agendaplus_events` and `agendaplus_tasks` are rejected, while a non-agenda `kv` key remains writable. Existing legacy rows remain readable.
- Account A can read its own `agenda_items`; account B's equivalent authenticated read returns zero rows for A's user ID. A's RPC cannot read or mutate B's item, even if passed B's ID.
- Two concurrent CAS updates from account A with the same expected version: exactly one applies and the other reports conflict; deletion is a versioned tombstone and cannot be resurrected with an insert-if-absent.
- Scheduler dry mode with flag on includes A's live normalized event/task rows, excludes A's tombstones, and never includes B's schedule in A's push output. Keep subscriptions isolated so no push is actually sent.
- Switch old/new app sessions only after the stale-client failure and recovery/upgrade UX are verified. Do not use force mode or live push delivery.

No authenticated two-account test was performed in this task: no disposable project/session was available. No test users or user rows were created.
