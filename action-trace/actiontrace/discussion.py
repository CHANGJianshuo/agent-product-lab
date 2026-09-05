from __future__ import annotations

import re
from typing import Any

from .parser import ExtractedCandidate, NormalizedMessage


SCENARIO_TERMS = {
    "dining": ("聚餐", "吃饭", "餐厅", "饭店"),
    "travel": ("出游", "旅行", "旅游", "行程", "酒店"),
    "outing": ("团建", "活动", "去哪玩"),
    "rent": ("租房", "合租", "房子", "房源"),
}
OPEN_MARKERS = (
    "还没定",
    "尚未确定",
    "没有定",
    "一起决定",
    "大家决定",
    "大家选",
    "大家投票",
    "怎么选",
    "选哪个",
    "征集意见",
    "说下预算",
    "说一下预算",
)
KNOWN_TAGS = tuple(
    sorted(
        {
            "素食可选",
            "独立卫生间",
            "可带宠物",
            "近地铁",
            "可短租",
            "可停车",
            "无障碍",
            "安静",
            "清淡",
            "川菜",
            "烧烤",
            "热闹",
            "包间",
            "火锅",
            "花生",
            "海鲜",
            "楼梯",
            "宠物",
            "辣",
        },
        key=len,
        reverse=True,
    )
)


def redact_private_budget_text(value: Any) -> str:
    text = str(value or "")
    if not re.search(r"(?:预算|价格).{0,12}(?:私密|保密|不公开|别公开)|(?:私密|保密|不公开|别公开).{0,12}(?:预算|价格)", text):
        return text
    return re.sub(
        r"((?:人均(?:预算)?|预算(?:上限)?|价格)[^\d]{0,8})\d+(?:\.\d+)?",
        r"\1***",
        text,
    )


def _scenario(text: str) -> str:
    for scenario, terms in SCENARIO_TERMS.items():
        if any(term in text for term in terms):
            return scenario
    return "general"


def _topic_title(text: str, scenario: str) -> str:
    subject_patterns = {
        "dining": r"((?:(?:本|这|下)?周[一二三四五六日天]|今天|明天|后天)?[^，。！？]{0,8}?(?:团队)?(?:聚餐|吃饭))",
        "travel": r"((?:(?:本|这|下)?周|假期|国庆|周末)?[^，。！？]{0,10}?(?:出游|旅行|旅游|行程|酒店))",
        "outing": r"((?:(?:本|这|下)?周|周末)?[^，。！？]{0,10}?(?:团建|集体活动|活动))",
        "rent": r"([^，。！？]{0,12}?(?:合租|租房|房源))",
    }
    pattern = subject_patterns.get(scenario)
    match = re.search(pattern, text) if pattern else None
    if match:
        title = match.group(1).strip(" ，。！？：:")
    else:
        title = re.split(r"(?:还没定|尚未确定|需要大家|请大家|大家(?:选|决定|投票)|怎么选|选哪个)", text, 1)[0]
        title = title.strip(" ，。！？：:") or "共同方案"
    return title[:80]


def _number(patterns: tuple[str, ...], text: str) -> float | None:
    for pattern in patterns:
        match = re.search(pattern, text, re.I)
        if match:
            try:
                return round(float(match.group(1)), 2)
            except (TypeError, ValueError):
                return None
    return None


def _clock_token(token: str) -> str | None:
    token = token.strip()
    colon = re.search(r"(\d{1,2})[:：](\d{2})", token)
    if colon:
        hour, minute = int(colon.group(1)), int(colon.group(2))
    else:
        chinese = re.search(r"(上午|下午|晚上)?\s*([一二两三四五六七八九十\d]{1,3})\s*点(?:\s*(半))?", token)
        if not chinese:
            return None
        raw = chinese.group(2)
        digits = {"一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9, "十": 10}
        if raw.isdigit():
            hour = int(raw)
        elif raw.startswith("十") and len(raw) > 1:
            hour = 10 + digits.get(raw[-1], 0)
        else:
            hour = digits.get(raw, 0)
        if chinese.group(1) in {"下午", "晚上"} and hour < 12:
            hour += 12
        minute = 30 if chinese.group(3) else 0
    if not (0 <= hour <= 23 and 0 <= minute <= 59):
        return None
    return f"{hour:02d}:{minute:02d}"


def _time_window(text: str) -> tuple[str | None, str | None]:
    token_pattern = r"(?:上午|下午|晚上)?\s*(?:\d{1,2}[:：]\d{2}|[一二两三四五六七八九十\d]{1,3}\s*点(?:\s*半)?)"
    range_match = re.search(f"({token_pattern})\s*(?:到|至|[-~～—])\s*({token_pattern})", text)
    if range_match:
        return _clock_token(range_match.group(1)), _clock_token(range_match.group(2))
    earliest: str | None = None
    latest: str | None = None
    for match in re.finditer(token_pattern, text):
        value = _clock_token(match.group(0))
        if not value:
            continue
        neighborhood = text[max(0, match.start() - 3) : min(len(text), match.end() + 4)]
        if any(marker in neighborhood for marker in ("以后", "之后", "起", "最早")):
            earliest = value
        elif any(marker in neighborhood for marker in ("以前", "之前", "前", "最晚", "截止")):
            latest = value
    return earliest, latest


def _tags(text: str) -> tuple[list[str], list[str], list[str]]:
    markers = {
        "avoid": ("不能", "不吃", "不要", "避开", "过敏", "忌口", "接受不了"),
        "required": ("必须", "需要", "一定要", "要有", "得有", "只能"),
        "preferred": ("最好", "更喜欢", "偏好", "想吃", "想要", "倾向", "希望"),
    }
    classified: dict[str, list[str]] = {"avoid": [], "required": [], "preferred": []}
    for tag in KNOWN_TAGS:
        start = text.find(tag)
        if start < 0:
            continue
        prefix = text[:start]
        choices = [
            (prefix.rfind(marker), mode)
            for mode, values in markers.items()
            for marker in values
            if prefix.rfind(marker) >= 0
        ]
        if not choices:
            continue
        marker_index, mode = max(choices)
        if start - marker_index <= 30:
            classified[mode].append(tag)
    avoided = classified["avoid"]
    required = [tag for tag in classified["required"] if tag not in avoided]
    preferred = [tag for tag in classified["preferred"] if tag not in avoided and tag not in required]
    return required, avoided, preferred


def _participant(message: NormalizedMessage, index: int) -> dict[str, Any] | None:
    text = message.body
    if re.search(r"(?:候选|备选)(?:方案)?\s*[：:]", text):
        return None
    budget = _number(
        (
            r"(?:人均|预算(?:上限)?)[^\d]{0,8}(\d+(?:\.\d+)?)",
            r"(?:不超过|别超过|最多|封顶|控制在)\s*[¥￥]?\s*(\d+(?:\.\d+)?)\s*(?:元|块)?",
        ),
        text,
    )
    distance = _number((r"(\d+(?:\.\d+)?)\s*(?:公里|km)\s*(?:内|以内|都可以|可接受)?",), text)
    earliest, latest = _time_window(text)
    required, avoided, preferred = _tags(text)
    if not any((budget, distance, earliest, latest, required, avoided, preferred)):
        return None
    return {
        "name": message.speaker,
        "budget_max": budget,
        "budget_private": bool(re.search(r"(?:预算|价格).{0,8}(?:私密|保密|不公开|别公开)", text)),
        "max_distance_km": distance,
        "earliest_time": earliest,
        "latest_time": latest,
        "required_tags": required,
        "avoided_tags": avoided,
        "preferred_tags": preferred,
        "source_note": text[:500],
        "source_message_index": index,
        "source_line_start": message.line_start,
        "source_line_end": message.line_end,
    }


def _options(message: NormalizedMessage, index: int) -> list[dict[str, Any]]:
    text = message.body
    if not re.search(r"(?:候选|备选)(?:方案)?\s*[：:]", text):
        return []
    segments = [segment.strip() for segment in re.split(r"[；;]", text) if segment.strip()]
    results: list[dict[str, Any]] = []
    for segment in segments:
        match = re.search(r"(?:候选|备选)(?:方案)?\s*[：:]\s*([^，,。；;]{1,40})", segment)
        if not match:
            continue
        name = match.group(1).strip()
        cost = _number((r"人均[^\d]{0,5}(\d+(?:\.\d+)?)", r"[¥￥]\s*(\d+(?:\.\d+)?)"), segment)
        distance = _number((r"(\d+(?:\.\d+)?)\s*(?:公里|km)",), segment)
        time_match = re.search(r"(?:\d{1,2}[:：]\d{2}|(?:上午|下午|晚上)\s*[一二两三四五六七八九十\d]{1,3}\s*点(?:\s*半)?)", segment)
        available = _clock_token(time_match.group(0)) if time_match else None
        tags = [tag for tag in KNOWN_TAGS if tag in segment]
        results.append(
            {
                "name": name[:80],
                "cost_per_person": cost,
                "distance_km": distance,
                "available_time": available,
                "tags": tags,
                "source_note": segment[:500],
                "source_message_index": index,
                "source_line_start": message.line_start,
                "source_line_end": message.line_end,
            }
        )
    return results


def extract_deliberation(messages: list[NormalizedMessage]) -> tuple[int, ExtractedCandidate] | None:
    """Build one conservative, evidence-backed deliberation draft from a discussion.

    The deterministic pass intentionally requires an explicit unresolved-choice
    marker plus constraints or options from the same import. This keeps ordinary
    brainstorming from silently turning into an active decision room.
    """

    anchor: tuple[int, NormalizedMessage] | None = None
    for index, message in enumerate(messages, start=1):
        if any(marker in message.body for marker in OPEN_MARKERS):
            anchor = (index, message)
            break
    if not anchor:
        return None

    participant_map: dict[str, dict[str, Any]] = {}
    options: list[dict[str, Any]] = []
    for index, message in enumerate(messages, start=1):
        participant = _participant(message, index)
        if participant:
            key = participant["name"].casefold()
            existing = participant_map.get(key)
            if not existing:
                participant_map[key] = participant
            else:
                for field in ("budget_max", "max_distance_km", "earliest_time", "latest_time"):
                    if participant.get(field) is not None:
                        existing[field] = participant[field]
                existing["budget_private"] = existing["budget_private"] or participant["budget_private"]
                for field in ("required_tags", "avoided_tags", "preferred_tags"):
                    existing[field] = list(dict.fromkeys([*existing[field], *participant[field]]))
                existing["source_note"] = f"{existing['source_note']} / {participant['source_note']}"[:500]
                existing["source_line_end"] = participant["source_line_end"]
        options.extend(_options(message, index))

    participants = list(participant_map.values())

    # Require evidence that this is a group choice, not a single rhetorical question.
    distinct_people = {item["name"] for item in participants}
    if len(distinct_people) < 2 and not options:
        return None

    anchor_index, anchor_message = anchor
    all_text = "\n".join(message.body for message in messages)
    scenario = _scenario(all_text)
    title = _topic_title(anchor_message.body, scenario)
    payload = {
        "title": title,
        "scenario": scenario,
        "organizer": anchor_message.speaker,
        "description": anchor_message.body[:500],
        "participants": participants,
        "options": options,
        "message_count": len(messages),
    }
    candidate = ExtractedCandidate(
        kind="decision",
        change_type="deliberate",
        title=title,
        owner=anchor_message.speaker,
        due_at=None,
        confidence=0.91,
        rule_id="discussion.deliberation-v1",
        evidence_fields={
            "event": anchor_message.body,
            "title": anchor_message.body,
            "owner": anchor_message.body,
        },
        evidence_message_indices={
            "event": anchor_index,
            "title": anchor_index,
            "owner": anchor_index,
        },
        decision_payload=payload,
    )
    return anchor_index, candidate
