# Agenda item CAS sync — staged rollout notes

## Status
- Prepared from `main` commit `b079e953a4198123b21b6f706f7bfa9ca9fec097`.
- The CAS schema/functions are installed in Supabase project `myuwytzbkckemcyfvhkx` through migrations `agenda_items_cas_sync_path`, `agenda_legacy_migration_no_stale_resurrection`, `agenda_items_service_role_cas_only`, and `agenda_cas_reject_null_type`.
- `agenda_sync_control.enabled` is intentionally `false`. This branch's new app path is dormant until the server-side cutover is explicitly enabled.
- No `kv` policy has yet been changed; legacy clients remain unaffected. No app code has been merged to `main` or published. The new app detects cached legacy-list divergence from normalized rows, keeps the local item state, and pauses those items for an explicit per-item resolution rather than overwriting either side.

## Data contract
- App reads `agenda_items` per event/task and keeps `kv` for every other legacy app key.
- App changes are sent one item at a time to `agenda_item_cas`, with the item ID, optional expected version, and tombstone delete flag. Creation only succeeds when the item is absent; updates/deletes only succeed at the exact expected version. Stale writes return `conflict` and preserve local pending data rather than retrying over newer server data.
- An offline per-item queue and its base versions are stored locally. On reconnect it retries with that same base version; the server reports a conflict rather than silently rebasing stale edits.
- The one-time legacy importer reads `agendaplus_events` / `agendaplus_tasks` from `kv` only for a user whose normalized table has no rows. It uses insert-if-absent, never overwrites normalized rows. Existing normalized users are marked migrated without merging the legacy snapshot, avoiding stale-list resurrection. Existing `kv` rows are retained.
- Authenticated and service roles can select normalized agenda rows but cannot write directly; all writes must use the CAS RPC. RPCs are `SECURITY DEFINER` with empty `search_path`, require `auth.uid()`, and are executable only by `authenticated`.

## Cutover blocker / risks
Old app builds continue whole-array writes to `kv`. The new app must not merge those arrays after normalized data exists. Enabling the flag alone is therefore not a complete rollout: stale app builds could keep changing legacy `kv` while new builds only read normalized rows, and the two sources would diverge. A controlled follow-up must deploy the app first, then apply a version barrier that prevents legacy `agendaplus_events` / `agendaplus_tasks` writes, and only then set `agenda_sync_control.enabled=true`. Old builds would no longer sync those two arrays; their on-device data remains but those builds need an explicit upgrade notice/support plan. Do not enable the flag until the barrier and user-facing path are reviewed and an authenticated CAS integration test is available.

The current rollout intentionally does not alter the existing `kv` policy or enable the new path. The branch adds a basic per-item conflict-resolution choice (`Manter local` / `Usar nuvem`); it is not yet exercised with authenticated clients and needs product review. Choosing `Manter local` explicitly authorizes a CAS write against the displayed server version; a subsequent race still returns a conflict. Offline startup still depends on the existing auth/session flow.

The deployed `scheduler` Edge Function still reads the whole event/task arrays from `kv` for push reminders and summaries. It must switch to normalized rows (while keeping birthdays and other settings in `kv`) before the feature flag is enabled, or reminders will continue using stale schedule data. The current `tnc-mcp` Edge Function only validates the authorized connection and has no agenda CRUD, so end-to-end MCP agenda sync remains untested.

Supabase's security advisor emits its generic warning for authenticated-callable `SECURITY DEFINER` RPCs. This is intentional for the CAS boundary because direct table mutation is revoked; the RPCs verify `auth.uid()`, fully qualify objects with an empty `search_path`, and scope every read/write to that UID. Review this rationale alongside the advisor remediation guidance: https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable.
