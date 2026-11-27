"""Offline contract checks; does not connect to production or mutate user data."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MIGRATIONS = [
    ROOT / "supabase/migrations/20261127122816_agenda_items_cas_sync_path.sql",
    ROOT / "supabase/migrations/20261127123004_agenda_legacy_migration_no_stale_resurrection.sql",
    ROOT / "supabase/migrations/20261127123040_agenda_items_service_role_cas_only.sql",
    ROOT / "supabase/migrations/20261127123105_agenda_cas_reject_null_type.sql",
]
SQL = "\n".join(path.read_text() for path in MIGRATIONS) if all(path.exists() for path in MIGRATIONS) else (ROOT / "agenda_cas_migration.sql").read_text()
APP_PATH = ROOT / "index.html" if (ROOT / "index.html").exists() else ROOT / "latest_index.html"
APP = APP_PATH.read_text()

class CasReference:
    def __init__(self):
        self.row = None
    def apply(self, expected, payload, deleted=False):
        if self.row is None:
            if expected is not None or deleted:
                return {"status": "not_found"}
            self.row = {"version": 1, "payload": payload}
            return {"status": "applied", **self.row}
        if expected != self.row["version"]:
            return {"status": "conflict", **self.row}
        self.row = {"version": self.row["version"] + 1,
                    "payload": {"_deleted": True} if deleted else payload}
        return {"status": "applied", **self.row}

class AgendaCasContractTests(unittest.TestCase):
    def test_two_writers_with_same_base_version_conflict_without_lost_update(self):
        store = CasReference()
        self.assertEqual(store.apply(None, {"id": "x", "title": "base"})["version"], 1)
        winner = store.apply(1, {"id": "x", "title": "writer A"})
        loser = store.apply(1, {"id": "x", "title": "writer B"})
        self.assertEqual(winner["status"], "applied")
        self.assertEqual(loser["status"], "conflict")
        self.assertEqual(store.row["payload"]["title"], "writer A")
        self.assertEqual(store.row["version"], 2)

    def test_insert_only_if_absent_and_tombstone_is_versioned(self):
        store = CasReference()
        self.assertEqual(store.apply(None, {"id": "x"})["status"], "applied")
        self.assertEqual(store.apply(None, {"id": "x", "title": "duplicate"})["status"], "conflict")
        deleted = store.apply(1, None, deleted=True)
        self.assertEqual(deleted["version"], 2)
        self.assertEqual(deleted["payload"], {"_deleted": True})

    def test_sql_requires_owner_jwt_and_uses_expected_version_atomically(self):
        self.assertIn("v_uid uuid := auth.uid()", SQL)
        self.assertIn("a.version=p_expected_version", SQL)
        self.assertIn("on conflict (user_id,item_type,item_id) do nothing", SQL)
        self.assertIn("'status','conflict'", SQL)
        self.assertIn("security definer", SQL.lower())
        self.assertIn("set search_path = ''", SQL.lower())

    def test_app_calls_cas_and_keeps_conflicts_pending(self):
        self.assertIn('SB.rpc("agenda_item_cas"', APP)
        self.assertIn("baseVersion: existing ? existing.baseVersion", APP)
        self.assertIn('row.status === "conflict"', APP)
        self.assertIn("_agendaMeta.conflicts[key]", APP)
        self.assertIn('function _agendaIsLegacyKey(key)', APP)
        self.assertIn("_agendaStableStringify(localItem || null)", APP)
        self.assertIn('_agendaResolveConflict(key, "local")', APP)
        self.assertIn('_agendaResolveConflict(key, "server")', APP)

    def test_cutover_feature_flag_defaults_off(self):
        self.assertIn("values (true, false)", SQL)
        self.assertIn('SB.rpc("agenda_sync_enabled")', APP)

class LegacyAtomicCutoffContractTests(unittest.TestCase):
    def test_rpc_atomicity_flag_lock_and_identity(self):
        sql = (ROOT / "supabase/migrations/20261127130000_agenda_legacy_kv_cas.sql").read_text().lower()
        self.assertIn("auth.uid()", sql)
        self.assertIn("k.user_id = v_uid", sql)
        self.assertIn("k.value is not distinct from p_expected_value", sql)
        self.assertIn("on conflict (user_id,key) do nothing", sql)
        self.assertIn("for share", sql)
        self.assertIn("'status','blocked'", sql)
        self.assertIn("from public, anon, service_role", sql)
        self.assertIn('SB.rpc("agenda_legacy_kv_cas"', APP)

    def test_cutoff_restricts_direct_array_dml_even_with_flag_off(self):
        sql = (ROOT / "supabase/migrations/20261127131000_agenda_legacy_atomic_cutoff.sql").read_text().lower()
        self.assertEqual(sql.count("as restrictive for"), 3)
        self.assertIn("for insert", sql)
        self.assertIn("for update", sql)
        self.assertIn("for delete", sql)
        self.assertNotIn("agenda_sync_enabled()", sql)

class SchedulerAndBarrierTests(unittest.TestCase):
    def setUp(self):
        self.scheduler = (ROOT / "supabase/functions/scheduler/index.ts").read_text()
        self.barrier = (ROOT / "supabase/migrations/20261127123500_agenda_legacy_kv_write_barrier.sql").read_text()

    def test_scheduler_switches_on_flag_and_fails_closed(self):
        self.assertIn('from("agenda_sync_control").select("enabled").eq("singleton", true)', self.scheduler)
        self.assertIn("if (controlError) throw controlError", self.scheduler)
        self.assertIn('if (!control) throw new Error("agenda_sync_control_missing")', self.scheduler)
        self.assertIn('normalizedEnabled ? await loadNormalized(uid) : await loadLegacy(uid)', self.scheduler)
        self.assertIn('from("kv").select("key,value").eq("user_id", userId)', self.scheduler)

    def test_scheduler_control_permission_is_select_only(self):
        migration = (ROOT / 'supabase/migrations/20261127125000_agenda_scheduler_control_read.sql').read_text()
        statements = re.sub(r'--[^\n]*', '', migration).strip().lower()
        self.assertEqual(statements, 'grant select on public.agenda_sync_control to service_role;')
        self.assertIn('revoke all on public.agenda_sync_control from public, anon, authenticated, service_role', SQL.lower())

    def test_scheduler_owner_scope_tombstones_and_settings(self):
        self.assertIn('from("agenda_items").select("item_type,item_id,payload").eq("user_id", userId)', self.scheduler)
        self.assertIn('from("kv").select("value").eq("user_id", userId).eq("key", "agendaplus_bdays")', self.scheduler)
        self.assertIn('payload._deleted === true', self.scheduler)
        self.assertIn('t._deleted !== true', self.scheduler)
        self.assertIn('req.headers.get("x-cron-key") !== m.cron_key', self.scheduler)
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", self.scheduler.split("Deno.serve")[1])

    def test_staged_barrier_preserves_reads_and_blocks_only_two_agenda_keys_when_enabled(self):
        sql = self.barrier.lower()
        self.assertIn('for select to authenticated', sql)
        self.assertIn('for insert to authenticated', sql)
        self.assertIn('for update to authenticated', sql)
        self.assertIn('for delete to authenticated', sql)
        self.assertIn("key not in ('agendaplus_events', 'agendaplus_tasks')", sql)
        self.assertIn('or not public.agenda_sync_enabled()', sql)
        self.assertNotIn("agenda_sync_control.enabled = true", sql)

    def test_reconciliation_sql_is_read_only_and_reports_metadata_only(self):
        report = (ROOT / 'tests/sql/agenda_reconciliation_dry_run.sql').read_text()
        statements = re.sub(r'--[^\n]*', '', report).lower()
        self.assertRegex(statements, r'\bwith\b')
        self.assertRegex(statements, r'\bselect\b')
        self.assertNotRegex(statements, r'\b(insert\s+into|update\s+public|delete\s+from|alter\s+table|create\s+table|drop\s+table)\b')
        self.assertIn("'feature_enabled'", report)
        self.assertIn("'legacy_projection_checksum'", report)
        self.assertIn("'normalized_projection_checksum'", report)
        self.assertIn("'differing_field_names'", report)
        self.assertIn("'legacy_invalid_rows'", report)
        self.assertIn("'legacy_duplicate_ids'", report)
        self.assertNotRegex(report, r"jsonb_build_object\(\s*'[^']*(title|desc|description)[^']*'")

    def test_service_worker_is_not_a_stale_client_version_barrier(self):
        worker = (ROOT / 'sw.js').read_text()
        self.assertNotRegex(worker, r'addEventListener\(\s*[\"\']fetch')
        self.assertNotIn('caches.', worker)
        self.assertNotRegex(APP, r'\b(?:APP_VERSION|BUILD_ID|MINIMUM_APP_VERSION)\b')
        self.assertIn('navigator.serviceWorker.register("sw.js")', APP)

class CompatibilityBuildTests(unittest.TestCase):
    def test_blocked_legacy_agenda_batch_retries_preferences_independently(self):
        self.assertIn('function _agendaIsBlockedWrite(error)', APP)
        self.assertIn('error.code === "42501"', APP)
        self.assertIn('const agendaRows = rows.filter((row) => _agendaIsLegacyKey(row.key))', APP)
        write_path = APP[APP.index('async function _writeKvRows'):APP.index('\nasync function _agendaResolveConflict', APP.index('async function _writeKvRows'))]
        self.assertIn('const pref = prefRows.length ? await SB.from("kv").upsert(prefRows', write_path)
        self.assertIn('const legacy = agendaRows.length ? await _agendaLegacySync(uidv)', write_path)
        self.assertIn('A nuvem bloqueou a gravação da agenda desta versão', APP)
        self.assertIn('Seus eventos e tarefas continuam neste aparelho', APP)

    def test_enabled_or_unknown_gate_never_writes_legacy_arrays_to_kv(self):
        self.assertIn('const mustIsolate = !_agendaGateKnown || _agendaSyncEnabled || _agendaLegacyBlocked', APP)
        pull = APP[APP.index('async function pullRemote(uidv) {'):APP.index('\nfunction App() {', APP.index('async function pullRemote(uidv) {'))]
        self.assertNotIn('agenda_migrate_legacy_items', pull)
        self.assertIn('if (!_agendaGateKnown)', pull)
        self.assertIn('filter((k) => !_agendaIsLegacyKey(k))', pull)

    def test_legacy_pending_queue_is_persistent_and_account_scoped(self):
        self.assertIn('const _agendaLegacyPendingKey = "tnc_legacy_pending_v1:"', APP)
        self.assertIn('localStorage.setItem(_agendaLegacyPendingKey + _agendaLegacyPending.uid', APP)
        self.assertIn('localStorage.getItem(_agendaLegacyPendingKey + uid)', APP)
        self.assertIn('entry.revision', APP)
        self.assertIn('currentLocal', APP)
        self.assertIn('_agendaLegacyRecordLocal(_sbUser, key, val)', APP)
        self.assertIn('async function _agendaLegacySync(uid)', APP)
        self.assertIn('_agendaLegacyResolveConflict(type, id, "local")', APP)
        self.assertIn('_agendaLegacyResolveConflict(type, id, "cloud")', APP)

    def test_offline_listener_reconciles_legacy_and_normalized_queues(self):
        listener = APP[APP.index('window.addEventListener("online"'):APP.index('\nfunction usePersist', APP.index('window.addEventListener("online"'))]
        self.assertIn('_sbFlush()', listener)
        self.assertIn('pullRemote(_sbUser)', listener)

    def test_offline_bootstrap_and_reconnect_keep_local_queue_retryable(self):
        self.assertIn('if (!navigator.onLine)', APP[APP.index('async function pullRemote(uidv) {'):])
        self.assertIn('_agendaGateKnown = false', APP)
        self.assertIn('if (!_sbTimer && Object.keys(_sbQueue).length) _sbTimer = setTimeout(_sbFlush, 5000)', APP)
        self.assertIn('window.addEventListener("online"', APP)
        self.assertIn('pullRemote(_sbUser)', APP)

    def test_logout_does_not_clear_local_agenda_if_cloud_save_is_unconfirmed(self):
        start = APP.index('  const logout = async () => {', APP.index('function App()'))
        end = APP.index('\n  if (state === "loading")', start)
        logout = APP[start:end]
        self.assertIn('if (result.error || result.agendaBlocked || !_agendaGateKnown)', logout)
        self.assertIn('return;', logout)
        self.assertLess(logout.index('if (result.error || result.agendaBlocked || !_agendaGateKnown)'), logout.index('Object.keys(localStorage).filter'))
        self.assertIn('await _agendaDrain()', logout)
        self.assertIn('_agendaLegacyBlocked = false', logout)

    def test_manual_sync_refreshes_gate_and_sends_non_agenda_even_when_enabled(self):
        start = APP.index('  const syncNow = async () => {')
        end = APP.index('\n  const card =', start)
        sync = APP[start:end]
        self.assertIn('await _refreshAgendaGate(user.id)', sync)
        self.assertIn('_agendaLegacyBlocked = false', sync)
        self.assertIn('await _agendaDrain()', sync)
        self.assertIn('await _writeKvRows(user.id, rows)', sync)
        self.assertIn('finally { setBusy(false); }', sync)

if __name__ == "__main__":
    unittest.main(verbosity=2)
