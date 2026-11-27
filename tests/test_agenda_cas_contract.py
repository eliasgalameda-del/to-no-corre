"""Offline contract checks; does not connect to production or mutate user data."""
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SQL = (ROOT / "agenda_cas_migration.sql").read_text()
APP = (ROOT / "latest_index.html").read_text()

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

    def test_cutover_feature_flag_defaults_off(self):
        self.assertIn("values (true, false)", SQL)
        self.assertIn('SB.rpc("agenda_sync_enabled")', APP)

if __name__ == "__main__":
    unittest.main(verbosity=2)
