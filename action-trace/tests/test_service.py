from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from actiontrace.service import (
    approve_candidate,
    bootstrap,
    clarify_candidate,
    export_tasks_ics,
    generate_report,
    get_state,
    import_conversation,
    set_simulated_time,
)
from actiontrace.parser import ExtractedCandidate
from actiontrace.providers import ExtractionMetadata, ExtractionResult, ProviderError


class ServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.previous_db = os.environ.get("ACTIONTRACE_DB_PATH")
        self.previous_extractor = os.environ.get("ACTIONTRACE_EXTRACTOR")
        os.environ["ACTIONTRACE_DB_PATH"] = str(Path(self.temp_dir.name) / "test.db")
        os.environ["ACTIONTRACE_EXTRACTOR"] = "rules"
        bootstrap()

    def tearDown(self) -> None:
        if self.previous_db is None:
            os.environ.pop("ACTIONTRACE_DB_PATH", None)
        else:
            os.environ["ACTIONTRACE_DB_PATH"] = self.previous_db
        if self.previous_extractor is None:
            os.environ.pop("ACTIONTRACE_EXTRACTOR", None)
        else:
            os.environ["ACTIONTRACE_EXTRACTOR"] = self.previous_extractor
        self.temp_dir.cleanup()

    def test_draft_approval_idempotency_and_reminder(self) -> None:
        content = "[2026-09-03 09:08] 小林：我来完成登录页视觉稿，明天下午三点前发群里。"
        result = import_conversation("chat.txt", content)
        self.assertEqual(1, result["import_id"])
        self.assertEqual(1, result["message_count"])
        self.assertEqual(1, result["candidate_count"])
        self.assertEqual("rules", result["extractor"])

        before = get_state()
        self.assertEqual(0, before["stats"]["task_count"], "import must never commit a task")
        candidate_id = before["candidates"][0]["id"]

        edits = {"title": "完成登录页视觉稿", "owner": "小林", "due_at": "2026-09-04T15:00:00+08:00"}
        first = approve_candidate(candidate_id, edits, "same-key")
        second = approve_candidate(candidate_id, edits, "same-key")
        self.assertEqual(first["approval_id"], second["approval_id"])
        self.assertTrue(second["idempotent_replay"])
        self.assertEqual(1, get_state()["stats"]["task_count"])

        set_simulated_time("2026-09-05T09:00:00+08:00")
        after = get_state()
        self.assertEqual("overdue", after["tasks"][0]["health"])
        self.assertEqual(1, len(after["reminders"]))
        self.assertEqual("draft", after["reminders"][0]["status"])
        calendar = export_tasks_ics()
        self.assertIn("BEGIN:VTODO", calendar)
        self.assertIn("SUMMARY:完成登录页视觉稿", calendar)
        weekly = generate_report("weekly")["report"]
        self.assertIn("闭环周报", weekly)
        self.assertIn("证据：chat.txt 第 1 行", weekly)

    def test_clarification_then_approval(self) -> None:
        import_conversation("chat.txt", "[2026-09-03 09:11] 阿哲：接口联调我来处理。")
        candidate = get_state()["candidates"][0]
        self.assertEqual("needs_clarification", candidate["status"])
        self.assertEqual(["due_at"], [item["field_name"] for item in candidate["clarifications"]])

        clarify_candidate(candidate["id"], {"due_at": "2026-09-06T18:00:00+08:00"})
        approve_candidate(candidate["id"], {}, "clarified-task")
        state = get_state()
        self.assertEqual(
            "approved",
            next(item for item in state["candidates"] if item["id"] == candidate["id"])["status"],
        )
        self.assertEqual("阿哲", state["tasks"][0]["owner"])
        self.assertEqual("2026-09-06T18:00:00+08:00", state["tasks"][0]["due_at"])
        evidence_types = {
            item["source_type"]
            for item in next(entry for entry in state["candidates"] if entry["id"] == candidate["id"])["evidence"]
        }
        self.assertIn("user_confirmation", evidence_types)

    def test_reschedule_updates_existing_task_without_duplicate(self) -> None:
        import_conversation("first.txt", "[2026-09-03 09:08] 小林：我来完成登录页视觉稿，明天下午三点前发群里。")
        create_candidate = get_state()["candidates"][0]
        approve_candidate(create_candidate["id"], {}, "create-task")

        import_conversation("followup.txt", "[2026-09-04 10:00] 小林：完成登录页视觉稿改到下周三。")
        update_candidate = next(item for item in get_state()["candidates"] if item["change_type"] == "reschedule")
        approve_candidate(update_candidate["id"], {}, "reschedule-task")

        tasks = get_state()["tasks"]
        self.assertEqual(1, len(tasks))
        self.assertEqual(2, tasks[0]["version"])
        self.assertEqual("2026-09-09T18:00:00+08:00", tasks[0]["due_at"])

    def test_repeated_commitment_links_to_existing_task(self) -> None:
        message = "[2026-09-03 09:08] 小林：我来完成登录页视觉稿，明天下午三点前发群里。"
        import_conversation("first.txt", message)
        first = get_state()["candidates"][0]
        approve_candidate(first["id"], {}, "first")

        import_conversation("repeat.txt", message)
        repeated = next(item for item in get_state()["candidates"] if item["status"] == "pending")
        result = approve_candidate(repeated["id"], {}, "repeat")
        self.assertEqual("duplicate_linked", result["result"])
        self.assertEqual(1, len(get_state()["tasks"]))

        from actiontrace.service import reset_demo

        self.assertTrue(reset_demo()["reset"])
        self.assertEqual(0, len(get_state()["tasks"]))

    def test_auto_mode_falls_back_without_committing(self) -> None:
        os.environ["ACTIONTRACE_EXTRACTOR"] = "auto"
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "test-only-key"}, clear=False), patch(
            "actiontrace.service.extract_with_deepseek",
            side_effect=ProviderError("provider temporarily unavailable"),
        ):
            result = import_conversation(
                "fallback.txt",
                "[2026-09-03 09:08] 小林：我来完成登录页，明天下午三点前提交。",
            )
        self.assertEqual("rules", result["extractor"])
        self.assertIn("temporarily unavailable", result["fallback_reason"])
        state = get_state()
        self.assertEqual(1, state["stats"]["pending_count"])
        self.assertEqual(0, state["stats"]["task_count"])

    def test_persists_field_evidence_from_another_message(self) -> None:
        candidate = ExtractedCandidate(
            kind="task",
            change_type="create",
            title="完成发布检查",
            owner="小周",
            due_at="2026-09-04T15:00:00+08:00",
            confidence=0.88,
            rule_id="llm.deepseek-v4-flash",
            evidence_fields={
                "event": "他说明天下午三点前完成。",
                "title": "这项发布检查由小周负责。",
                "owner": "这项发布检查由小周负责。",
                "due_at": "他说明天下午三点前完成。",
            },
            evidence_message_indices={"event": 2, "title": 1, "owner": 1, "due_at": 2},
        )
        extraction = ExtractionResult(
            [(2, candidate)],
            ExtractionMetadata("deepseek", "deepseek-v4-flash", 120, 100, 20),
        )
        with patch("actiontrace.service._extract_conversation", return_value=extraction):
            import_conversation(
                "cross-message.txt",
                "[2026-09-03 09:00] 安然：这项发布检查由小周负责。\n"
                "[2026-09-03 09:05] 小林：他说明天下午三点前完成。",
            )
        stored = get_state()["candidates"][0]
        owner_evidence = next(item for item in stored["evidence"] if item["field_name"] == "owner")
        self.assertEqual(1, owner_evidence["line_start"])
        self.assertNotEqual(stored["message_id"], owner_evidence["message_id"])


if __name__ == "__main__":
    unittest.main()
