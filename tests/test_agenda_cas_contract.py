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
        self.assertIn('k !== "agendaplus_events" && k !== "agendaplus_tasks"', APP)
        self.assertIn("_agendaStableStringify(localItem || null)", APP)
        self.assertIn('_agendaResolveConflict(key, "local")', APP)
        self.assertIn('_agendaResolveConflict(key, "server")', APP)

    def test_cutover_feature_flag_defaults_off(self):
        self.assertIn("values (true, false)", SQL)
        self.assertIn('SB.rpc("agenda_sync_enabled")', APP)

class SchedulerAndBarrierTests(unittest.TestCase):
    def setUp(self):
        self.scheduler = (ROOT / "supabase/functions/scheduler/index.ts").read_text()
        self.barrier = (ROOT / "supabase/migrations/20261127123500_agenda_legacy_kv_write_barrier.sql").read_text()

    def test_scheduler_switches_on_flag_and_fails_closed(self):
        self.assertIn('from("agenda_sync_control").select("enabled").eq("singleton", true)', self.scheduler)
        self.assertIn("if (controlError) throw controlError", self.scheduler)
        self.assertIn('normalizedEnabled ? await loadNormalized(uid) : await loadLegacy(uid)', self.scheduler)
        self.assertIn('from("kv").select("key,value").eq("user_id", userId)', self.scheduler)

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

if __name__ == "__main__":
    unittest.main(verbosity=2)
