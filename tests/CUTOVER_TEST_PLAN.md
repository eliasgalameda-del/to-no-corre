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

## Production pre-cutover reconciliation (read-only)

Run `tests/sql/agenda_reconciliation_dry_run.sql` as a read-only query before cutover and again inside the final write-quiescence transaction. It emits array/live item counts, sorted per-type projection checksums, and only item IDs, issue codes, hashes, and differing JSON field names; it never selects titles, descriptions, or field values. It also flags malformed array values/entries and duplicate legacy IDs. A zero diff is valid only when counts and checksums agree and invalid/duplicate counts are zero. Treat any nonzero result as a manual owner-review queue; hashes/field names are diagnostic, not a conflict-resolution rule.

Never select a winner from timestamps, row counts, checksums, or the importer rule. The arrays carry no trustworthy per-item revision/tombstone history, so a mismatch cannot establish which edit is newer. Preserve the current table and arrays; ask the account owner to choose per item, retain that decision as an explicit reviewed manifest, then apply only those selected payloads with exact expected normalized versions and incremented versions. If there is no owner-approved decision for every mismatch, keep the flag off. Re-run the dry report under the final quiescence lock and abort on any unreviewed or newly changed IDs.

## Atomic cutover / old-client effect

The staged policy is currently applied nowhere in production. Applying it while the flag is false should preserve current `kv` behavior. Deploy and dry-test the staged scheduler while the flag remains false; it then follows the existing v2 legacy read path. Do not enable the flag while production scheduler v2 is still serving: v2 reads only legacy arrays and would become stale after CAS writes start. At cutover, do not set the flag in a standalone update: in one short admin transaction, acquire `LOCK TABLE public.kv IN SHARE ROW EXCLUSIVE MODE` first (waits for current write transactions and blocks new `kv` writes), rerun the report, verify every mismatch has an explicit decision, apply only approved exact-version changes if needed, set `agenda_sync_control.enabled=true`, then commit. This creates a short all-`kv` write pause but leaves reads available; queued writes resume after commit and the array policies then reject agenda-array writes. If the report is not clean/resolved, roll back and leave the flag false. The lock approach assumes the app/PostgREST's normal READ COMMITTED requests; do not use a long-lived REPEATABLE READ writer transaction for cutover.

Important compatibility caveat: old app versions bulk-upsert many `agendaplus_*` keys together (autosync, manual sync, initial cloud sync, and logout). RLS rejects `agendaplus_events`/`agendaplus_tasks` after enable; a multi-row PostgREST upsert is one transaction, so a rejected agenda row can cause the entire request—including unrelated settings in that batch—to fail. The staged new app filters those two keys when enabled, but old builds do not. Before enabling, publish/verify an upgrade path and test old-build error messaging, queued local edits, recovery, and non-agenda settings; do not promise the barrier only affects two independent writes. The current production `kv` policy catalog contains a single permissive owner `ALL` policy, which the migration drops/recreates, but recheck for any added permissive policies before applying. The service-role scheduler bypasses RLS; the staged scheduler reads only and its feature flag source switch is not a `kv` writer.

### Version/update mechanism review

The staged app has no app/build version identifier or mandatory server preflight. `sw.js` has no `fetch` handler or Cache Storage use; it calls `skipWaiting()`/`clients.claim()` and is registered only on the push path. It cannot replace JavaScript already executing in a tab. GitHub Pages currently returns `Cache-Control: max-age=600` for `index.html` and `sw.js`, but that is not an old-client enforcement mechanism. A preflight added only to a future/new build cannot warn or block code that never calls it. The RLS barrier still protects normalized data from legacy-array writes, but a rejected mixed old-client batch can fail its unrelated settings writes too.

Do not apply the barrier or enable the flag until the owner chooses a support path: (1) defer cutover; (2) accept a communicated cutoff and tested recovery process for old clients, including unsynced unrelated preferences; or (3) first release a compatibility build that splits non-agenda writes and provides upgrade messaging, while acknowledging that clients still running earlier JavaScript cannot be forced to update. In all cases, keep the flag off and barrier unapplied until disposable authenticated tests verify stale-client failure and local recovery. Do not ask users to clear browser storage or treat local-only data as a portable backup during recovery. Require an explicit foreground reload/navigation as an upgrade step, but do not assume this proves all stale clients are gone.

No update/version barrier or old-client recovery feature was implemented in this stage; the support choice remains pending. Static SQL tests do not prove PostgREST transaction behavior; validate that in disposable staging.

No reconciliation DML, migration, policy change, flag change, publication, or deployment was performed as part of this report.
