from __future__ import annotations

import json
import unittest
from datetime import datetime

from actiontrace.evaluate import DEFAULT_DATASET, evaluate_dataset
from actiontrace.parser import normalize_messages


class EvaluationTests(unittest.TestCase):
    def test_regression_dataset_and_rule_score_are_reproducible(self) -> None:
        payload = json.loads(DEFAULT_DATASET.read_text(encoding="utf-8"))
        self.assertGreaterEqual(len(payload["cases"]), 50)
        self.assertIn("not_human_validated", payload["label_status"])
        score = evaluate_dataset(DEFAULT_DATASET, "rules")
        self.assertEqual(len(payload["cases"]), score.cases)
        self.assertGreater(score.expected_events, 0)
        self.assertGreaterEqual(score.f1, 0.0)
        self.assertLessEqual(score.f1, 1.0)
        self.assertEqual(0, score.prompt_tokens + score.completion_tokens)

    def test_regression_labels_have_unique_valid_grain(self) -> None:
        payload = json.loads(DEFAULT_DATASET.read_text(encoding="utf-8"))
        cases = payload["cases"]
        self.assertEqual(len(cases), len({case["id"] for case in cases}))
        self.assertEqual(len(cases), len({case["content"] for case in cases}))
        allowed_changes = {
            "task": {"create", "complete", "cancel", "reschedule", "transfer"},
            "decision": {"record"},
            "risk": {"record"},
        }
        for case in cases:
            with self.subTest(case=case["id"]):
                messages = normalize_messages(case.get("filename", "case.txt"), case["content"])
                for event in case.get("expected", []):
                    self.assertIn(event["kind"], allowed_changes)
                    self.assertIn(event["change_type"], allowed_changes[event["kind"]])
                    self.assertIn(event["message_index"], range(1, len(messages) + 1))
                    self.assertTrue(str(event["title"]).strip())
                    if event.get("due_at"):
                        self.assertIsNotNone(datetime.fromisoformat(event["due_at"]).tzinfo)


if __name__ == "__main__":
    unittest.main()
