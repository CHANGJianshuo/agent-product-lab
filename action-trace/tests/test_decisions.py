from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path

from actiontrace.decisions import (
    DecisionConflictError,
    add_decision_option,
    add_decision_participant,
    analyze_decision_room,
    cast_decision_votes,
    finalize_decision_room,
    seed_decision_demo,
)
from actiontrace.service import bootstrap, generate_report, get_state, reset_demo


class DecisionRoomTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.previous_db = os.environ.get("CONVERGE_DB_PATH")
        os.environ["CONVERGE_DB_PATH"] = str(Path(self.temp_dir.name) / "test.db")
        bootstrap()

    def tearDown(self) -> None:
        if self.previous_db is None:
            os.environ.pop("CONVERGE_DB_PATH", None)
        else:
            os.environ["CONVERGE_DB_PATH"] = self.previous_db
        self.temp_dir.cleanup()

    def test_demo_has_private_constraints_and_pareto_front(self) -> None:
        seeded = seed_decision_demo()
        state = get_state()
        room = state["decision_rooms"][0]
        self.assertEqual(seeded["room_id"], room["id"])
        self.assertEqual(3, len(room["participants"]))
        self.assertEqual(4, len(room["options"]))
        private = next(item for item in room["participants"] if item["name"] == "安然")
        self.assertTrue(private["budget_private"])
        self.assertTrue(private["budget_configured"])
        self.assertIsNone(private["budget_max"], "private budgets must be redacted from state")
        analysis = room["analysis"]
        self.assertTrue(analysis["ready"])
        self.assertGreaterEqual(analysis["pareto_count"], 2)
        self.assertGreaterEqual(analysis["option_count"] - analysis["feasible_count"], 1)

    def test_vote_finalize_creates_audited_action_idempotently(self) -> None:
        room_id = seed_decision_demo()["room_id"]
        analysis = analyze_decision_room(room_id)["analysis"]
        pareto_ids = [item["option_id"] for item in analysis["results"] if item["pareto"]]
        state = get_state()
        participant = state["decision_rooms"][0]["participants"][0]
        cast_decision_votes(room_id, participant["id"], pareto_ids)
        selected = pareto_ids[0]
        first = finalize_decision_room(
            room_id,
            selected,
            "预订餐厅并确认人数",
            "安然",
            "2026-09-05T17:00:00+08:00",
            "优先兼顾硬约束与最低成员满意度。",
            "decision-finalize-test",
        )
        second = finalize_decision_room(
            room_id,
            selected,
            "预订餐厅并确认人数",
            "安然",
            "2026-09-05T17:00:00+08:00",
            "重复提交不应再次建任务。",
            "decision-finalize-test",
        )
        self.assertEqual(first["task_id"], second["task_id"])
        self.assertTrue(second["idempotent_replay"])
        after = get_state()
        room = after["decision_rooms"][0]
        self.assertEqual("decided", room["status"])
        self.assertEqual(selected, room["selected_option_id"])
        self.assertEqual(1, after["stats"]["task_count"])
        self.assertEqual("预订餐厅并确认人数", after["tasks"][0]["title"])
        self.assertIn("群体决策", generate_report("daily")["report"])
        self.assertIn(room["selected_option"]["name"], generate_report("daily")["report"])

    def test_reset_clears_decisions_and_generated_actions(self) -> None:
        seed_decision_demo()
        self.assertEqual(1, get_state()["stats"]["decision_room_count"])
        reset_demo()
        state = get_state()
        self.assertEqual([], state["decision_rooms"])
        self.assertEqual(0, state["stats"]["decision_room_count"])

    def test_voting_requires_analysis_and_locks_inputs(self) -> None:
        room_id = seed_decision_demo()["room_id"]
        participant = get_state()["decision_rooms"][0]["participants"][0]
        with self.assertRaises(DecisionConflictError):
            cast_decision_votes(room_id, participant["id"], [])

        analyze_decision_room(room_id)
        with self.assertRaises(DecisionConflictError):
            add_decision_participant(room_id, {"name": "迟到的新成员"})
        with self.assertRaises(DecisionConflictError):
            add_decision_option(room_id, {"name": "临时新方案"})


if __name__ == "__main__":
    unittest.main()
