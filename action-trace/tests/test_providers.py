from __future__ import annotations

import json
import os
import unittest
from unittest.mock import patch

from actiontrace.parser import normalize_messages
from actiontrace.providers import ProviderError, _post_json, extract_with_deepseek, provider_status


class DeepSeekProviderTests(unittest.TestCase):
    def setUp(self) -> None:
        self.previous_model = os.environ.get("DEEPSEEK_MODEL")
        os.environ["DEEPSEEK_MODEL"] = "deepseek-v4-flash"

    def tearDown(self) -> None:
        if self.previous_model is None:
            os.environ.pop("DEEPSEEK_MODEL", None)
        else:
            os.environ["DEEPSEEK_MODEL"] = self.previous_model

    def test_validates_structured_output_and_usage(self) -> None:
        messages = normalize_messages(
            "chat.txt",
            "[2026-09-03 09:08] 小林：登录页视觉稿我来做，明天下午三点前发群里。",
        )
        model_output = {
            "events": [
                {
                    "message_index": 1,
                    "kind": "task",
                    "change_type": "create",
                    "title": "完成登录页视觉稿",
                    "owner": "小林",
                    "due_text": "明天下午三点前",
                    "due_at": "2026-09-04T15:00:00+08:00",
                    "target_task_id": None,
                    "confidence": 0.96,
                }
            ]
        }
        response = {
            "id": "safe-request-id",
            "choices": [
                {"finish_reason": "stop", "message": {"content": json.dumps(model_output, ensure_ascii=False)}}
            ],
            "usage": {"prompt_tokens": 120, "completion_tokens": 44},
        }
        with patch("actiontrace.providers._post_json", return_value=response) as post:
            result = extract_with_deepseek(messages, [], api_key="test-only-key")

        self.assertEqual(1, len(result.events))
        index, candidate = result.events[0]
        self.assertEqual(1, index)
        self.assertEqual("2026-09-04T15:00:00+08:00", candidate.due_at)
        self.assertEqual([], candidate.clarification_fields)
        self.assertEqual("llm.deepseek-v4-flash", candidate.rule_id)
        self.assertEqual(164, result.metadata.prompt_tokens + result.metadata.completion_tokens)
        request_payload = post.call_args.args[0]
        self.assertEqual({"type": "json_object"}, request_payload["response_format"])
        self.assertEqual(0, request_payload["temperature"])
        self.assertNotIn("test-only-key", json.dumps(request_payload, ensure_ascii=False))

    def test_rejects_unsupported_indices_and_unbacked_deadline(self) -> None:
        messages = normalize_messages("chat.txt", "[2026-09-03 09:08] 小林：接口联调我来处理。")
        output = {
            "events": [
                {
                    "message_index": 99,
                    "kind": "task",
                    "change_type": "create",
                    "title": "不存在的消息",
                    "owner": "小林",
                    "confidence": 1,
                },
                {
                    "message_index": 1,
                    "kind": "task",
                    "change_type": "create",
                    "title": "接口联调",
                    "owner": "我",
                    "due_text": "明天下午三点",
                    "due_at": "2026-09-04T15:00:00+08:00",
                    "confidence": 0.8,
                },
            ]
        }
        response = {
            "choices": [{"finish_reason": "stop", "message": {"content": json.dumps(output, ensure_ascii=False)}}]
        }
        with patch("actiontrace.providers._post_json", return_value=response):
            result = extract_with_deepseek(messages, [], api_key="test-only-key")
        self.assertEqual(1, len(result.events))
        candidate = result.events[0][1]
        self.assertEqual("小林", candidate.owner)
        self.assertIsNone(candidate.due_at)
        self.assertEqual(["due_at"], candidate.clarification_fields)

    def test_missing_key_and_public_status_never_expose_secret(self) -> None:
        messages = normalize_messages("chat.txt", "小林：接口联调我来处理。")
        with patch.dict(os.environ, {}, clear=True), self.assertRaises(ProviderError):
            extract_with_deepseek(messages, [], api_key="")
        with patch.dict(os.environ, {"DEEPSEEK_API_KEY": "super-secret-value"}, clear=False):
            status = provider_status()
        self.assertTrue(status["configured"])
        self.assertNotIn("super-secret-value", json.dumps(status))

    def test_cross_message_owner_keeps_field_level_evidence(self) -> None:
        messages = normalize_messages(
            "chat.txt",
            "[2026-09-03 09:00] 安然：这项发布检查由小周负责。\n"
            "[2026-09-03 09:05] 小林：他说明天下午三点前完成。",
        )
        output = {
            "events": [
                {
                    "message_index": 2,
                    "kind": "task",
                    "change_type": "create",
                    "title": "完成发布检查",
                    "owner": "小周",
                    "due_text": "明天下午三点前",
                    "due_at": "2026-09-04T15:00:00+08:00",
                    "confidence": 0.85,
                    "evidence_message_indices": {"event": 2, "title": 1, "owner": 1, "due_at": 2},
                }
            ]
        }
        response = {
            "choices": [{"finish_reason": "stop", "message": {"content": json.dumps(output, ensure_ascii=False)}}]
        }
        with patch("actiontrace.providers._post_json", return_value=response):
            result = extract_with_deepseek(messages, [], api_key="test-only-key")
        candidate = result.events[0][1]
        self.assertEqual("小周", candidate.owner)
        self.assertEqual(1, candidate.evidence_message_indices["owner"])
        self.assertIn("小周", candidate.evidence_fields["owner"])

    def test_drops_speaker_owner_without_first_person_commitment(self) -> None:
        messages = normalize_messages(
            "chat.txt",
            "[2026-09-03 10:00] 安然：需要在明天前完成发布说明。",
        )
        output = {
            "events": [
                {
                    "message_index": 1,
                    "kind": "task",
                    "change_type": "create",
                    "title": "完成发布说明",
                    "owner": "安然",
                    "due_text": "明天前",
                    "due_at": "2026-09-04T18:00:00+08:00",
                    "confidence": 0.9,
                }
            ]
        }
        response = {
            "choices": [{"finish_reason": "stop", "message": {"content": json.dumps(output, ensure_ascii=False)}}]
        }
        with patch("actiontrace.providers._post_json", return_value=response):
            result = extract_with_deepseek(messages, [], api_key="test-only-key")
        candidate = result.events[0][1]
        self.assertIsNone(candidate.owner)
        self.assertEqual(["owner"], candidate.clarification_fields)

    def test_keeps_chinese_and_english_first_person_owners(self) -> None:
        cases = [
            ("小林：我明天再补一份交互说明。", "小林"),
            ("Alex: I will send the API contract tomorrow.", "Alex"),
        ]
        for content, owner in cases:
            with self.subTest(content=content):
                messages = normalize_messages("chat.txt", content)
                output = {
                    "events": [
                        {
                            "message_index": 1,
                            "kind": "task",
                            "change_type": "create",
                            "title": "发送交付物",
                            "owner": owner,
                            "confidence": 0.9,
                        }
                    ]
                }
                response = {
                    "choices": [
                        {"finish_reason": "stop", "message": {"content": json.dumps(output, ensure_ascii=False)}}
                    ]
                }
                with patch("actiontrace.providers._post_json", return_value=response):
                    result = extract_with_deepseek(messages, [], api_key="test-only-key")
                self.assertEqual(owner, result.events[0][1].owner)

    def test_retries_connection_reset_without_exposing_key(self) -> None:
        class FakeResponse:
            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b'{"choices":[]}'

        with (
            patch("actiontrace.providers.urlopen", side_effect=[ConnectionResetError(), FakeResponse()]) as opened,
            patch("actiontrace.providers.time.sleep"),
        ):
            response = _post_json({"model": "test"}, "test-only-key", 5)
        self.assertEqual([], response["choices"])
        self.assertEqual(2, opened.call_count)


if __name__ == "__main__":
    unittest.main()
