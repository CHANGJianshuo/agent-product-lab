from __future__ import annotations

import argparse
import json
import sys
import time
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Any

from .config import ROOT, load_local_env
from .parser import ExtractedCandidate, extract_candidates, normalize_messages, title_similarity
from .providers import ProviderError, extract_with_deepseek


DEFAULT_DATASET = ROOT / "evals" / "regression.json"


@dataclass
class Score:
    provider: str
    cases: int
    expected_events: int
    predicted_events: int
    true_positive: int
    false_positive: int
    false_negative: int
    precision: float
    recall: float
    f1: float
    change_accuracy: float
    owner_exact_match: float
    due_exact_match: float
    title_match: float
    latency_ms: int
    prompt_tokens: int
    completion_tokens: int
    failed_cases: list[dict[str, Any]]


def _round_ratio(numerator: int, denominator: int) -> float:
    return round(numerator / denominator, 4) if denominator else 0.0


def _candidate_payload(message_index: int, candidate: ExtractedCandidate) -> dict[str, Any]:
    return {
        "message_index": message_index,
        "kind": candidate.kind,
        "change_type": candidate.change_type,
        "title": candidate.title,
        "owner": candidate.owner,
        "due_at": candidate.due_at,
    }


def _extract_case(case: dict[str, Any], provider: str) -> tuple[list[dict[str, Any]], dict[str, int]]:
    filename = str(case.get("filename") or "case.txt")
    messages = normalize_messages(filename, str(case.get("content") or ""))
    if provider == "rules":
        events = [
            _candidate_payload(index, candidate)
            for index, message in enumerate(messages, start=1)
            for candidate in extract_candidates(message)
        ]
        return events, {"latency_ms": 0, "prompt_tokens": 0, "completion_tokens": 0}
    result = extract_with_deepseek(messages, case.get("current_tasks") or [])
    return [
        _candidate_payload(index, candidate) for index, candidate in result.events
    ], {
        "latency_ms": result.metadata.latency_ms,
        "prompt_tokens": result.metadata.prompt_tokens,
        "completion_tokens": result.metadata.completion_tokens,
    }


def _event_affinity(expected: dict[str, Any], actual: dict[str, Any]) -> float:
    if expected.get("message_index") != actual.get("message_index") or expected.get("kind") != actual.get("kind"):
        return -1.0
    expected_title = expected.get("title")
    actual_title = actual.get("title")
    if expected_title and actual_title:
        return title_similarity(str(expected_title), str(actual_title))
    return 0.5 if expected_title == actual_title else 0.2


def evaluate_dataset(
    dataset_path: Path = DEFAULT_DATASET,
    provider: str = "rules",
    limit: int | None = None,
) -> Score:
    if provider not in {"rules", "deepseek"}:
        raise ValueError("provider must be rules or deepseek")
    payload = json.loads(dataset_path.read_text(encoding="utf-8"))
    cases = payload.get("cases") if isinstance(payload, dict) else payload
    if not isinstance(cases, list):
        raise ValueError("evaluation dataset must contain a cases array")
    selected = cases[:limit] if limit else cases

    expected_total = predicted_total = tp = fp = fn = 0
    change_ok = change_total = owner_ok = owner_total = 0
    due_ok = due_total = title_ok = title_total = 0
    latency_ms = prompt_tokens = completion_tokens = 0
    failures: list[dict[str, Any]] = []
    started = time.monotonic()

    for case in selected:
        expected = case.get("expected") or []
        if not isinstance(expected, list):
            expected = []
        try:
            actual, usage = _extract_case(case, provider)
        except (ProviderError, ValueError) as exc:
            actual = []
            usage = {"latency_ms": 0, "prompt_tokens": 0, "completion_tokens": 0}
            failures.append({"id": case.get("id"), "error": str(exc)[:240]})
        expected_total += len(expected)
        predicted_total += len(actual)
        latency_ms += usage["latency_ms"]
        prompt_tokens += usage["prompt_tokens"]
        completion_tokens += usage["completion_tokens"]

        unmatched = set(range(len(actual)))
        case_matches: list[tuple[dict[str, Any], dict[str, Any]]] = []
        for expected_event in expected:
            ranked = sorted(
                ((_event_affinity(expected_event, actual[index]), index) for index in unmatched),
                reverse=True,
            )
            if ranked and ranked[0][0] >= 0.35:
                _, matched_index = ranked[0]
                unmatched.remove(matched_index)
                case_matches.append((expected_event, actual[matched_index]))
                tp += 1
            else:
                fn += 1
        fp += len(unmatched)

        mismatch_fields: list[str] = []
        for expected_event, actual_event in case_matches:
            change_total += 1
            if expected_event.get("change_type") == actual_event.get("change_type"):
                change_ok += 1
            else:
                mismatch_fields.append("change_type")
            if "owner" in expected_event:
                owner_total += 1
                if expected_event.get("owner") == actual_event.get("owner"):
                    owner_ok += 1
                else:
                    mismatch_fields.append("owner")
            if "due_at" in expected_event:
                due_total += 1
                if expected_event.get("due_at") == actual_event.get("due_at"):
                    due_ok += 1
                else:
                    mismatch_fields.append("due_at")
            if expected_event.get("title"):
                title_total += 1
                if actual_event.get("title") and title_similarity(
                    str(expected_event["title"]), str(actual_event["title"])
                ) >= 0.72:
                    title_ok += 1
                else:
                    mismatch_fields.append("title")
        if unmatched or len(case_matches) != len(expected) or mismatch_fields:
            failures.append(
                {
                    "id": case.get("id"),
                    "expected": expected,
                    "actual": actual,
                    "mismatch_fields": sorted(set(mismatch_fields)),
                }
            )

    precision = _round_ratio(tp, tp + fp)
    recall = _round_ratio(tp, tp + fn)
    f1 = round(2 * precision * recall / (precision + recall), 4) if precision + recall else 0.0
    measured_latency = round((time.monotonic() - started) * 1000)
    return Score(
        provider=provider,
        cases=len(selected),
        expected_events=expected_total,
        predicted_events=predicted_total,
        true_positive=tp,
        false_positive=fp,
        false_negative=fn,
        precision=precision,
        recall=recall,
        f1=f1,
        change_accuracy=_round_ratio(change_ok, change_total),
        owner_exact_match=_round_ratio(owner_ok, owner_total),
        due_exact_match=_round_ratio(due_ok, due_total),
        title_match=_round_ratio(title_ok, title_total),
        latency_ms=latency_ms or measured_latency,
        prompt_tokens=prompt_tokens,
        completion_tokens=completion_tokens,
        failed_cases=failures,
    )


def _print_summary(score: Score) -> None:
    print(f"\nConverge evaluation · {score.provider}")
    print(f"cases={score.cases} expected={score.expected_events} predicted={score.predicted_events}")
    print(f"precision={score.precision:.4f} recall={score.recall:.4f} f1={score.f1:.4f}")
    print(
        f"change_acc={score.change_accuracy:.4f} owner_em={score.owner_exact_match:.4f} "
        f"due_em={score.due_exact_match:.4f} title_match={score.title_match:.4f}"
    )
    print(
        f"latency_ms={score.latency_ms} tokens={score.prompt_tokens + score.completion_tokens} "
        f"cases_with_differences={len(score.failed_cases)}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Evaluate Converge conversation extraction")
    parser.add_argument("--dataset", type=Path, default=DEFAULT_DATASET)
    parser.add_argument("--provider", choices=["rules", "deepseek", "all"], default="rules")
    parser.add_argument("--limit", type=int)
    parser.add_argument("--output", type=Path, help="Optional JSON result path")
    args = parser.parse_args()
    load_local_env()
    providers = ["rules", "deepseek"] if args.provider == "all" else [args.provider]
    scores: list[Score] = []
    try:
        for provider in providers:
            score = evaluate_dataset(args.dataset, provider, args.limit)
            scores.append(score)
            _print_summary(score)
    except (OSError, ValueError, json.JSONDecodeError, ProviderError) as exc:
        print(f"evaluation failed: {exc}", file=sys.stderr)
        raise SystemExit(2) from exc
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(
            json.dumps([asdict(score) for score in scores], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )


if __name__ == "__main__":
    main()
