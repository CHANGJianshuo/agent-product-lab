from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from difflib import SequenceMatcher
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo


TZ = ZoneInfo("Asia/Shanghai")


@dataclass
class NormalizedMessage:
    speaker: str
    sent_at: str
    body: str
    line_start: int
    line_end: int


@dataclass
class ExtractedCandidate:
    kind: str
    change_type: str
    title: str | None
    owner: str | None
    due_at: str | None
    confidence: float
    rule_id: str
    evidence_fields: dict[str, str] = field(default_factory=dict)
    clarification_fields: list[str] = field(default_factory=list)
    target_task_id: int | None = None
    evidence_message_indices: dict[str, int] = field(default_factory=dict)
    decision_payload: dict[str, Any] | None = None


LINE_PATTERNS = [
    re.compile(r"^\s*\[(?P<time>[^\]]+)\]\s*(?P<speaker>[^:：]{1,40})[:：]\s*(?P<body>.+?)\s*$"),
    re.compile(
        r"^\s*(?P<time>\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?)\s*[|｜]\s*(?P<speaker>[^|｜]{1,40})\s*[|｜]\s*(?P<body>.+?)\s*$"
    ),
    re.compile(r"^\s*(?P<speaker>[^:：\n]{1,30})[:：]\s*(?P<body>.+?)\s*$"),
]


def _parse_datetime(value: Any, fallback: datetime) -> datetime:
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(value, TZ)
    if not value:
        return fallback
    raw = str(value).strip().replace("/", "-")
    raw = raw.replace("年", "-").replace("月", "-").replace("日", "")
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
        return parsed.replace(tzinfo=TZ) if parsed.tzinfo is None else parsed.astimezone(TZ)
    except ValueError:
        pass
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M", "%Y-%m-%d"):
        try:
            parsed = datetime.strptime(raw, fmt)
            return parsed.replace(tzinfo=TZ)
        except ValueError:
            continue
    return fallback


def normalize_messages(filename: str, content: str, imported_at: datetime | None = None) -> list[NormalizedMessage]:
    base = imported_at or datetime.now(TZ).replace(microsecond=0)
    suffix = Path(filename).suffix.lower()
    if suffix == ".json":
        return _normalize_json(content, base)
    if suffix not in {".txt", ".md"}:
        raise ValueError("仅支持 .txt、.md 或 .json 文件")
    return _normalize_text(content, base)


def _normalize_json(content: str, base: datetime) -> list[NormalizedMessage]:
    try:
        payload = json.loads(content)
    except json.JSONDecodeError as exc:
        raise ValueError(f"JSON 格式错误：第 {exc.lineno} 行 {exc.msg}") from exc
    if isinstance(payload, dict):
        payload = payload.get("messages", payload.get("records", payload.get("items")))
    if not isinstance(payload, list):
        raise ValueError("JSON 顶层应为数组，或包含 messages / records / items 数组")

    messages: list[NormalizedMessage] = []
    for index, item in enumerate(payload, start=1):
        if not isinstance(item, dict):
            continue
        speaker = item.get("speaker") or item.get("sender") or item.get("user") or item.get("name")
        body = item.get("text") or item.get("content") or item.get("message") or item.get("body")
        stamp = item.get("timestamp") or item.get("time") or item.get("sent_at") or item.get("datetime")
        if speaker is None or body is None:
            continue
        parsed = _parse_datetime(stamp, base + timedelta(seconds=index))
        messages.append(
            NormalizedMessage(
                speaker=str(speaker).strip(),
                sent_at=parsed.replace(microsecond=0).isoformat(),
                body=str(body).strip(),
                line_start=index,
                line_end=index,
            )
        )
    if not messages:
        raise ValueError("没有找到同时包含发言人和正文的 JSON 消息")
    return messages


def _normalize_text(content: str, base: datetime) -> list[NormalizedMessage]:
    messages: list[NormalizedMessage] = []
    for line_number, raw_line in enumerate(content.splitlines(), start=1):
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        match = next((pattern.match(line) for pattern in LINE_PATTERNS if pattern.match(line)), None)
        if match:
            values = match.groupdict()
            stamp = _parse_datetime(values.get("time"), base + timedelta(seconds=line_number))
            messages.append(
                NormalizedMessage(
                    speaker=values["speaker"].strip(" *@"),
                    sent_at=stamp.replace(microsecond=0).isoformat(),
                    body=values["body"].strip(),
                    line_start=line_number,
                    line_end=line_number,
                )
            )
        elif messages:
            messages[-1].body = f"{messages[-1].body}\n{line}"
            messages[-1].line_end = line_number
    if not messages:
        raise ValueError("未识别到消息。请使用“[时间] 发言人：内容”或“发言人：内容”格式")
    return messages


def _time_from_text(text: str) -> time:
    colon = re.search(r"(?<!\d)(\d{1,2})[:：](\d{2})", text)
    if colon:
        return time(min(int(colon.group(1)), 23), min(int(colon.group(2)), 59))
    chinese = re.search(r"(上午|下午|晚上)?\s*([零一二两三四五六七八九十\d]{1,3})\s*点(?:\s*(半|\d{1,2}\s*分))?", text)
    if chinese:
        raw_hour = chinese.group(2)
        number_map = {"零": 0, "一": 1, "二": 2, "两": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
        if raw_hour.isdigit():
            hour = int(raw_hour)
        elif raw_hour == "十":
            hour = 10
        elif raw_hour.startswith("十"):
            hour = 10 + number_map.get(raw_hour[-1], 0)
        elif raw_hour.endswith("十"):
            hour = number_map.get(raw_hour[0], 0) * 10
        elif "十" in raw_hour:
            tens, ones = raw_hour.split("十", 1)
            hour = number_map.get(tens, 0) * 10 + number_map.get(ones, 0)
        else:
            hour = number_map.get(raw_hour, 18)
        if (chinese.group(1) in {"下午", "晚上"} or "今晚" in text or "明晚" in text) and hour < 12:
            hour += 12
        minute = 30 if chinese.group(3) == "半" else 0
        if chinese.group(3) and chinese.group(3) != "半":
            minute = int(re.sub(r"\D", "", chinese.group(3)))
        return time(min(hour, 23), min(minute, 59))
    if "中午" in text:
        return time(12, 0)
    if "上午" in text:
        return time(11, 0)
    if "晚上" in text:
        return time(20, 0)
    return time(18, 0)


def parse_due_at(text: str, sent_at: str) -> str | None:
    base = datetime.fromisoformat(sent_at).astimezone(TZ)
    # Chat exports frequently insert spaces around Chinese date units (for
    # example ``9 月 10 日``).  Compacting whitespace also lets the
    # deterministic parser override inconsistent model conventions for
    # date-only deadlines.
    # Only compact around Chinese date units: removing every space would turn
    # ``2026-09-10 16:00`` into ``2026-09-1016:00`` and hide the time.
    text = re.sub(r"\s*([年月日])\s*", r"\1", text)
    target_date: date | None = None

    exact = re.search(r"(?:(\d{4})[-年/])?(\d{1,2})[-月/](\d{1,2})(?:日)?", text)
    if exact:
        year = int(exact.group(1) or base.year)
        try:
            target_date = date(year, int(exact.group(2)), int(exact.group(3)))
            if exact.group(1) is None and target_date < base.date() - timedelta(days=2):
                target_date = target_date.replace(year=year + 1)
        except ValueError:
            target_date = None
    else:
        iso = re.search(r"(?<!\d)(\d{4})-(\d{1,2})-(\d{1,2})(?!\d)", text)
        if iso:
            try:
                target_date = date(int(iso.group(1)), int(iso.group(2)), int(iso.group(3)))
            except ValueError:
                target_date = None

    if target_date is None:
        if "后天" in text:
            target_date = base.date() + timedelta(days=2)
        elif "明天" in text or "明晚" in text:
            target_date = base.date() + timedelta(days=1)
        elif "今天" in text or "今晚" in text:
            target_date = base.date()

    weekday_match = re.search(r"(下周|本周|这周|周)([一二三四五六日天])", text)
    if target_date is None and weekday_match:
        weekday = "一二三四五六日天".index(weekday_match.group(2))
        if weekday == 7:
            weekday = 6
        prefix = weekday_match.group(1)
        monday = base.date() - timedelta(days=base.weekday())
        if prefix == "下周":
            target_date = monday + timedelta(days=7 + weekday)
        elif prefix in {"本周", "这周"}:
            target_date = monday + timedelta(days=weekday)
        else:
            delta = (weekday - base.weekday()) % 7
            target_date = base.date() + timedelta(days=delta or 7)

    if target_date is None:
        return None
    return datetime.combine(target_date, _time_from_text(text), TZ).replace(microsecond=0).isoformat()


def _clean_title(text: str) -> str | None:
    cleaned = text.strip(" ，。！？；:：\t\n")
    cleaned = re.sub(
        r"^(?:麻烦|请|让)\s*@?[\u4e00-\u9fffA-Za-z0-9_-]{1,8}?(?=(?:今天|明天|后天|本周|这周|下周|周[一二三四五六日天]|\d|来|负责|跟进|处理|整理|准备|提交|完成|发布|修复))",
        "",
        cleaned,
    )
    cleaned = re.sub(r"^(?:那个|这个|关于|然后|另外|还有|麻烦|请|需要|要不|TODO\s*[:：]?|待办\s*[:：]?)", "", cleaned, flags=re.I)
    cleaned = re.sub(r"^(?:我|我们)(?:来|负责|会|跟进|处理|完成|整理|准备|提交|发布|修复)", "", cleaned)
    cleaned = re.sub(r"(?:我来(?:做|处理|跟进)?|我负责|我跟进|我处理|交给\S+|由\S+负责)$", "", cleaned)
    cleaned = re.sub(r"(?:请|麻烦)?@?[\u4e00-\u9fffA-Za-z0-9_-]{1,12}(?:来|负责|跟进|处理|完成)", "", cleaned, count=1)
    cleaned = re.sub(
        r"[，,]\s*(?:今天|明天|后天|今晚|明晚|本周|这周|下周|周[一二三四五六日天]|\d{1,2}月|\d{4}-).*$",
        "",
        cleaned,
    )
    cleaned = re.sub(
        r"(?:在)?(?:今天|明天|后天|今晚|明晚|本周[一二三四五六日天]?|这周[一二三四五六日天]?|下周[一二三四五六日天]?|周[一二三四五六日天]|\d{1,2}月\d{1,2}日|\d{4}-\d{1,2}-\d{1,2})(?:上午|下午|晚上|中午)?(?:[零一二两三四五六七八九十\d]{1,3}(?::\d{2}|点(?:半|\d{1,2}分)?))?(?:前|之前|完成|提交|给我|给你)?",
        "",
        cleaned,
    )
    cleaned = re.sub(r"(?:之前|以前|前|完成|搞定|处理好|上线|提交|给我|给你)[了吧呢]?$", "", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" ，。！？；:：")
    if not cleaned or cleaned in {"这个", "那个", "事情", "一下", "它"}:
        return None
    return cleaned[:80]


def _owner_from_text(text: str, speaker: str) -> str | None:
    if re.search(r"我(?:来|负责|会|跟进|处理|整理|准备|提交|发布|修复|完成)", text):
        return speaker
    patterns = [
        r"(?:请|麻烦|让)\s*@?(?P<name>[\u4e00-\u9fffA-Za-z0-9_-]{1,8}?)(?=(?:今天|明天|后天|本周|这周|下周|周[一二三四五六日天]|\d|来|负责|跟进|处理|整理|准备|提交|完成|发布|修复|$))",
        r"(?:交给|转给)\s*@?(?P<name>[\u4e00-\u9fffA-Za-z0-9_-]{1,12})",
        r"(?:^|[，。；\s])@?(?P<name>[\u4e00-\u9fffA-Za-z0-9_-]{1,12})\s*(?:来|负责|跟进|处理)",
        r"由\s*@?(?P<name>[\u4e00-\u9fffA-Za-z0-9_-]{1,12})\s*(?:负责|来做|处理|跟进)",
    ]
    for pattern in patterns:
        match = re.search(pattern, text)
        if match:
            name = match.group("name").strip()
            if name not in {"大家", "有人", "谁", "我", "我们"}:
                return speaker if name == "本人" else name
    return None


def _before_marker(text: str, markers: list[str]) -> str | None:
    indexes = [text.find(marker) for marker in markers if marker in text]
    if not indexes:
        return None
    return _clean_title(text[: min(indexes)])


def extract_candidates(message: NormalizedMessage) -> list[ExtractedCandidate]:
    text = message.body.strip()
    speaker = message.speaker
    due = parse_due_at(text, message.sent_at)

    # Status-changing rules run before creation rules to avoid duplicate tasks.
    if re.search(r"(?:取消|不用做了|不做了|先不做)", text):
        title = _before_marker(text, ["取消", "不用做了", "不做了", "先不做"])
        return [_candidate("task", "cancel", title, None, None, 0.94, "status.cancel", text, ["title"] if not title else [])]

    if re.search(r"(?:改到|改为|延期到|推迟到|顺延到)", text):
        title = _before_marker(text, ["改到", "改为", "延期到", "推迟到", "顺延到"])
        missing = (["title"] if not title else []) + (["due_at"] if not due else [])
        return [_candidate("task", "reschedule", title, None, due, 0.93, "status.reschedule", text, missing)]

    transfer = re.search(
        r"(?:交给|转给|改由|现在由)\s*@?(?P<name>[\u4e00-\u9fffA-Za-z0-9_-]{1,8}?)(?=(?:来|负责|跟进|处理|完成|整理|准备|提交|发布|修复|[，。；\s]|$))",
        text,
    )
    if transfer:
        title = _before_marker(text, ["交给", "转给", "改由", "现在由"])
        owner = transfer.group("name")
        missing = ["title"] if not title else []
        return [_candidate("task", "transfer", title, owner, None, 0.93, "status.transfer", text, missing)]

    completion_pattern = r"(?:(?:已经|已|刚刚)\s*(?:完成|搞定|处理好|做完|上线|提交)(?:了)?|(?:完成|搞定|处理好|做完|上线|提交)了)"
    if re.search(completion_pattern, text):
        marker_match = re.search(completion_pattern, text)
        prefix = text[: marker_match.start()] if marker_match else text
        suffix = text[marker_match.end() :] if marker_match else ""
        title = _clean_title(re.sub(r"我$", "", prefix)) or _clean_title(suffix)
        return [_candidate("task", "complete", title, speaker, None, 0.92, "status.complete", text, ["title"] if not title else [])]

    if re.search(r"(?:风险|可能延期|来不及|卡在|阻塞|受阻|有问题)", text):
        return [_candidate("risk", "record", _clean_title(text), speaker, due, 0.86, "event.risk", text, [])]

    if re.search(r"(?:还没定|尚未确定|需要大家一起决定|请大家选|大家投票|怎么选|选哪个|征集意见)", text):
        return [_candidate("decision", "deliberate", _clean_title(text), speaker, None, 0.84, "event.deliberation", text, [])]

    if re.search(r"(?:决定|确定|结论是|统一采用|最终用|就按)", text):
        return [_candidate("decision", "record", _clean_title(text), speaker, due, 0.88, "event.decision", text, [])]

    directed_request = re.search(
        r"(?:^|[，。；\s])(?:请|麻烦|让)\s*@?[\u4e00-\u9fffA-Za-z0-9_-]{1,8}?"
        r"(?=(?:今天|明天|后天|本周|这周|下周|周[一二三四五六日天]|\d|来|负责|跟进|处理|整理|准备|提交|完成|发布|修复))",
        text,
    )
    task_trigger = directed_request or re.search(
        r"(?:我(?:来|负责|会|跟进|处理|整理|准备|提交|发布|修复)|交给|负责|TODO|待办|需要\S{0,8}(?:完成|提交|整理|准备|发布|修复))",
        text,
        re.I,
    )
    hypothetical = re.search(r"(?:如果|假如|要不要|是否可以|是不是|建议可以|开玩笑)", text)
    if task_trigger and not hypothetical:
        owner = _owner_from_text(text, speaker)
        title = _clean_title(text)
        missing: list[str] = []
        if not title:
            missing.append("title")
        if not owner:
            missing.append("owner")
        if not due:
            missing.append("due_at")
        confidence = 0.9 if owner and due else 0.76
        return [_candidate("task", "create", title, owner, due, confidence, "task.commitment", text, missing)]
    return []


def _candidate(
    kind: str,
    change_type: str,
    title: str | None,
    owner: str | None,
    due_at: str | None,
    confidence: float,
    rule_id: str,
    quote: str,
    missing: list[str],
) -> ExtractedCandidate:
    evidence = {"event": quote}
    if title:
        evidence["title"] = quote
    if owner:
        evidence["owner"] = quote
    if due_at:
        evidence["due_at"] = quote
    return ExtractedCandidate(kind, change_type, title, owner, due_at, confidence, rule_id, evidence, missing)


def clarification_question(field_name: str, change_type: str = "create") -> str:
    if field_name == "owner":
        return "这件事由谁负责？"
    if field_name == "due_at":
        return "希望在什么具体日期和时间前完成？"
    if field_name == "title":
        return "具体需要完成或变更哪件事？"
    if field_name == "target_task_id":
        return "这条状态变化对应看板里的哪一个任务？"
    return "请补充这条事项缺失的信息。"


def title_similarity(left: str, right: str) -> float:
    def normalize(value: str) -> str:
        value = re.sub(r"(?:完成|处理|负责|跟进|任务|一下|相关|这个|那个|的)", "", value)
        return "".join(re.findall(r"[\u4e00-\u9fffA-Za-z0-9]", value)).lower()

    a, b = normalize(left), normalize(right)
    if not a or not b:
        return 0.0
    if a in b or b in a:
        return min(len(a), len(b)) / max(len(a), len(b)) * 0.35 + 0.65
    return SequenceMatcher(None, a, b).ratio()
