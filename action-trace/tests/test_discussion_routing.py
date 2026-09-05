from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path

from actiontrace.decisions import promote_decision_candidate
from actiontrace.service import ConflictError, approve_candidate, bootstrap, get_state, import_conversation


ROOT = Path(__file__).resolve().parent.parent


class DiscussionRoutingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.previous_db = os.environ.get("CONVERGE_DB_PATH")
        self.previous_mode = os.environ.get("CONVERGE_EXTRACTOR")
        os.environ["CONVERGE_DB_PATH"] = str(Path(self.temp_dir.name) / "test.db")
        os.environ["CONVERGE_EXTRACTOR"] = "rules"
        bootstrap()

    def tearDown(self) -> None:
        if self.previous_db is None:
            os.environ.pop("CONVERGE_DB_PATH", None)
        else:
            os.environ["CONVERGE_DB_PATH"] = self.previous_db
        if self.previous_mode is None:
            os.environ.pop("CONVERGE_EXTRACTOR", None)
        else:
            os.environ["CONVERGE_EXTRACTOR"] = self.previous_mode
        self.temp_dir.cleanup()

    def test_import_routes_unresolved_discussion_to_prefilled_room(self) -> None:
        content = (ROOT / "static" / "decision-demo-chat.txt").read_text(encoding="utf-8")
        imported = import_conversation("聚餐讨论示例.txt", content, "rules")
        self.assertEqual(1, imported["deliberation_count"])

        before = get_state()
        self.assertEqual([], before["decision_rooms"], "import must only create a reviewable draft")
        self.assertEqual(1, len(before["candidates"]), "constraint messages must not become task drafts")
        candidate = next(item for item in before["candidates"] if item["change_type"] == "deliberate")
        self.assertEqual(3, len(candidate["decision_draft"]["participants"]))
        self.assertEqual(4, len(candidate["decision_draft"]["options"]))
        draft_private = next(
            item for item in candidate["decision_draft"]["participants"] if item["name"] == "安然"
        )
        self.assertIsNone(draft_private["budget_max"])
        self.assertNotIn("160", draft_private["source_note"])
        with self.assertRaises(ConflictError):
            approve_candidate(candidate["id"], {}, "wrong-workflow")

        promoted = promote_decision_candidate(candidate["id"], {}, "route-once")
        replay = promote_decision_candidate(candidate["id"], {}, "route-once")
        self.assertEqual(promoted["room_id"], replay["room_id"])
        self.assertTrue(replay["idempotent_replay"])
        self.assertEqual(3, replay["participant_count"])
        self.assertEqual(4, replay["option_count"])

        after = get_state()
        room = after["decision_rooms"][0]
        self.assertEqual("周五团队聚餐", room["title"])
        self.assertEqual(3, len(room["participants"]))
        self.assertEqual(4, len(room["options"]))
        self.assertEqual(candidate["id"], room["source"]["candidate_id"])
        self.assertTrue(all(item["source_line_start"] for item in room["participants"]))
        private = next(item for item in room["participants"] if item["name"] == "安然")
        self.assertTrue(private["budget_configured"])
        self.assertIsNone(private["budget_max"])
        self.assertNotIn("160", private["source_note"])
        self.assertNotIn("我的预算 160", json.dumps(after, ensure_ascii=False))
        self.assertEqual(2, room["analysis"]["feasible_count"])
        self.assertEqual(2, room["analysis"]["pareto_count"])

    def test_resolved_decision_remains_a_record(self) -> None:
        imported = import_conversation(
            "resolved.txt",
            "[2026-09-03 09:00] 安然：我们决定首页首版使用深绿色方案。",
            "rules",
        )
        self.assertEqual(0, imported["deliberation_count"])
        candidate = get_state()["candidates"][0]
        self.assertEqual("record", candidate["change_type"])
        self.assertIsNone(candidate["decision_draft"])


if __name__ == "__main__":
    unittest.main()
