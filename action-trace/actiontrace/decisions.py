from __future__ import annotations

import json
import math
import sqlite3
from datetime import datetime
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo

from .db import audit, connect, init_db, utcish_now
from .discussion import redact_private_budget_text


TZ = ZoneInfo("Asia/Shanghai")
SCENARIOS = {"dining", "outing", "travel", "rent", "general"}


class DecisionConflictError(RuntimeError):
    pass


class DecisionNotFoundError(RuntimeError):
    pass


def _clean_text(value: Any, label: str, limit: int, required: bool = True) -> str | None:
    text = " ".join(str(value or "").split()).strip()
    if required and not text:
        raise ValueError(f"{label}不能为空")
    if len(text) > limit:
        raise ValueError(f"{label}不能超过 {limit} 个字符")
    return text or None


def _number(value: Any, label: str, maximum: float) -> float | None:
    if value in (None, ""):
        return None
    try:
        parsed = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label}必须是数字") from exc
    if not math.isfinite(parsed) or parsed <= 0 or parsed > maximum:
        raise ValueError(f"{label}超出有效范围")
    return round(parsed, 2)


def _clock(value: Any, label: str) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    try:
        parsed = datetime.strptime(text, "%H:%M")
    except ValueError as exc:
        raise ValueError(f"{label}必须使用 HH:MM 格式") from exc
    return parsed.strftime("%H:%M")


def _tags(value: Any) -> list[str]:
    if value in (None, ""):
        return []
    values = value if isinstance(value, list) else str(value).replace("，", ",").split(",")
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        tag = " ".join(str(raw).split()).strip(" ,，、#")
        normalized = tag.casefold()
        if not tag or normalized in seen:
            continue
        if len(tag) > 30:
            raise ValueError("单个标签不能超过 30 个字符")
        seen.add(normalized)
        result.append(tag)
    if len(result) > 20:
        raise ValueError("每组标签最多 20 个")
    return result


def _json_list(value: Any) -> list[str]:
    try:
        parsed = json.loads(value or "[]")
    except (TypeError, json.JSONDecodeError):
        return []
    return [str(item) for item in parsed] if isinstance(parsed, list) else []


def _room_or_404(connection: sqlite3.Connection, room_id: int) -> sqlite3.Row:
    row = connection.execute("SELECT * FROM decision_rooms WHERE id = ?", (room_id,)).fetchone()
    if not row:
        raise DecisionNotFoundError("决策室不存在")
    return row


def _ensure_editable(room: sqlite3.Row) -> None:
    if room["status"] == "decided":
        raise DecisionConflictError("该决策已经确认，不能再修改约束、方案或投票")


def _ensure_collecting(room: sqlite3.Row) -> None:
    _ensure_editable(room)
    if room["status"] != "collecting":
        raise DecisionConflictError("投票开始后约束与候选方案已经锁定")


def create_decision_room(payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("决策室参数必须是对象")
    title = _clean_text(payload.get("title"), "决策主题", 80)
    scenario = str(payload.get("scenario") or "general").strip().lower()
    if scenario not in SCENARIOS:
        raise ValueError("未知的决策场景")
    organizer = _clean_text(payload.get("organizer"), "主持人", 40)
    description = _clean_text(payload.get("description"), "背景说明", 500, required=False)
    now = utcish_now()
    with connect() as connection:
        init_db(connection)
        cursor = connection.execute(
            """
            INSERT INTO decision_rooms(title, scenario, description, organizer, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'collecting', ?, ?)
            """,
            (title, scenario, description, organizer, now, now),
        )
        room_id = int(cursor.lastrowid)
        audit(
            connection,
            "human.decision_room_created",
            "local-user",
            "decision_room",
            room_id,
            {"title": title, "scenario": scenario, "organizer": organizer},
        )
        connection.commit()
    return {"room_id": room_id, "status": "collecting"}


def add_decision_participant(room_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("参与者参数必须是对象")
    name = _clean_text(payload.get("name"), "参与者姓名", 40)
    budget = _number(payload.get("budget_max"), "预算上限", 10_000_000)
    distance = _number(payload.get("max_distance_km"), "最远距离", 100_000)
    earliest = _clock(payload.get("earliest_time"), "最早时间")
    latest = _clock(payload.get("latest_time"), "最晚时间")
    required = _tags(payload.get("required_tags"))
    avoided = _tags(payload.get("avoided_tags"))
    preferred = _tags(payload.get("preferred_tags"))
    overlap = {item.casefold() for item in required} & {item.casefold() for item in avoided}
    if overlap:
        raise ValueError("同一个标签不能同时是必须条件和避开条件")
    note = _clean_text(payload.get("source_note"), "约束原话", 500, required=False)
    private = 1 if payload.get("budget_private") in {True, 1, "1", "true", "on"} else 0
    now = utcish_now()
    with connect() as connection:
        init_db(connection)
        room = _room_or_404(connection, room_id)
        _ensure_collecting(room)
        try:
            cursor = connection.execute(
                """
                INSERT INTO decision_participants(
                    room_id, name, budget_max, budget_private, max_distance_km,
                    earliest_time, latest_time, required_tags, avoided_tags,
                    preferred_tags, source_note, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    room_id,
                    name,
                    budget,
                    private,
                    distance,
                    earliest,
                    latest,
                    json.dumps(required, ensure_ascii=False),
                    json.dumps(avoided, ensure_ascii=False),
                    json.dumps(preferred, ensure_ascii=False),
                    note,
                    now,
                    now,
                ),
            )
        except sqlite3.IntegrityError as exc:
            raise DecisionConflictError("该参与者已经在决策室中") from exc
        participant_id = int(cursor.lastrowid)
        connection.execute("UPDATE decision_rooms SET updated_at = ? WHERE id = ?", (now, room_id))
        audit(
            connection,
            "human.constraint_submitted",
            name,
            "decision_participant",
            participant_id,
            {
                "room_id": room_id,
                "budget_configured": budget is not None,
                "budget_private": bool(private),
                "distance_configured": distance is not None,
                "time_window_configured": bool(earliest or latest),
                "required_count": len(required),
                "avoided_count": len(avoided),
                "preferred_count": len(preferred),
            },
        )
        connection.commit()
    return {"room_id": room_id, "participant_id": participant_id}


def add_decision_option(room_id: int, payload: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("候选方案参数必须是对象")
    name = _clean_text(payload.get("name"), "方案名称", 80)
    cost = _number(payload.get("cost_per_person"), "人均费用", 10_000_000)
    distance = _number(payload.get("distance_km"), "距离", 100_000)
    available_time = _clock(payload.get("available_time"), "可用时间")
    tags = _tags(payload.get("tags"))
    note = _clean_text(payload.get("source_note"), "方案来源", 500, required=False)
    now = utcish_now()
    with connect() as connection:
        init_db(connection)
        room = _room_or_404(connection, room_id)
        _ensure_collecting(room)
        try:
            cursor = connection.execute(
                """
                INSERT INTO decision_options(
                    room_id, name, cost_per_person, distance_km, available_time,
                    tags, source_note, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    room_id,
                    name,
                    cost,
                    distance,
                    available_time,
                    json.dumps(tags, ensure_ascii=False),
                    note,
                    now,
                    now,
                ),
            )
        except sqlite3.IntegrityError as exc:
            raise DecisionConflictError("该方案已经存在") from exc
        option_id = int(cursor.lastrowid)
        connection.execute("UPDATE decision_rooms SET updated_at = ? WHERE id = ?", (now, room_id))
        audit(
            connection,
            "human.decision_option_added",
            "local-user",
            "decision_option",
            option_id,
            {"room_id": room_id, "name": name, "tag_count": len(tags)},
        )
        connection.commit()
    return {"room_id": room_id, "option_id": option_id}


def _minutes(value: str | None) -> int | None:
    if not value:
        return None
    hour, minute = value.split(":", 1)
    return int(hour) * 60 + int(minute)


def _within_window(value: str, earliest: str | None, latest: str | None) -> bool:
    current = _minutes(value)
    start = _minutes(earliest)
    end = _minutes(latest)
    if current is None:
        return False
    if start is not None and end is not None and start > end:
        return current >= start or current <= end
    return (start is None or current >= start) and (end is None or current <= end)


def _participant_from_row(row: sqlite3.Row) -> dict[str, Any]:
    result = dict(row)
    for field in ("required_tags", "avoided_tags", "preferred_tags"):
        result[field] = _json_list(result[field])
    result["budget_private"] = bool(result["budget_private"])
    return result


def _public_participant(participant: dict[str, Any]) -> dict[str, Any]:
    result = dict(participant)
    result["budget_configured"] = participant.get("budget_max") is not None
    if participant.get("budget_private"):
        result["budget_max"] = None
        result["source_note"] = redact_private_budget_text(result.get("source_note"))
    return result


def _option_from_row(row: sqlite3.Row) -> dict[str, Any]:
    result = dict(row)
    result["tags"] = _json_list(result["tags"])
    return result


def _participant_score(participant: dict[str, Any], option: dict[str, Any]) -> float:
    score = 50.0
    budget = participant.get("budget_max")
    cost = option.get("cost_per_person")
    if budget and cost is not None:
        score += 15 * max(0.0, min(1.0, (budget - cost) / budget))
    distance_max = participant.get("max_distance_km")
    distance = option.get("distance_km")
    if distance_max and distance is not None:
        score += 12 * max(0.0, min(1.0, (distance_max - distance) / distance_max))
    if participant.get("earliest_time") or participant.get("latest_time"):
        score += 5
    preferred = {item.casefold() for item in participant.get("preferred_tags", [])}
    option_tags = {item.casefold() for item in option.get("tags", [])}
    if preferred:
        score += 28 * len(preferred & option_tags) / len(preferred)
    if participant.get("required_tags"):
        score += 5
    return round(min(100.0, score), 1)


def _evaluate_option(participants: list[dict[str, Any]], option: dict[str, Any]) -> dict[str, Any]:
    violations: list[dict[str, Any]] = []
    scores: list[dict[str, Any]] = []
    option_tags = {item.casefold() for item in option.get("tags", [])}
    hard_checks = 0
    for participant in participants:
        reasons: list[str] = []
        budget = participant.get("budget_max")
        if budget is not None:
            hard_checks += 1
            cost = option.get("cost_per_person")
            if cost is None:
                reasons.append("缺少费用数据")
            elif cost > budget:
                reasons.append("超过其私密预算" if participant.get("budget_private") else f"超过预算 ¥{budget:g}")
        distance_max = participant.get("max_distance_km")
        if distance_max is not None:
            hard_checks += 1
            distance = option.get("distance_km")
            if distance is None:
                reasons.append("缺少距离数据")
            elif distance > distance_max:
                reasons.append(f"距离超过 {distance_max:g} km")
        earliest = participant.get("earliest_time")
        latest = participant.get("latest_time")
        if earliest or latest:
            hard_checks += 1
            available = option.get("available_time")
            if not available:
                reasons.append("缺少可用时间")
            elif not _within_window(available, earliest, latest):
                reasons.append(f"时间不在 {earliest or '00:00'}–{latest or '24:00'}")
        required = {item.casefold() for item in participant.get("required_tags", [])}
        if required:
            hard_checks += len(required)
            missing = sorted(required - option_tags)
            if missing:
                reasons.append("缺少必须条件：" + "、".join(missing))
        avoided = {item.casefold() for item in participant.get("avoided_tags", [])}
        if avoided:
            hard_checks += len(avoided)
            conflicts = sorted(avoided & option_tags)
            if conflicts:
                reasons.append("触发避开条件：" + "、".join(conflicts))
        if reasons:
            violations.append({"participant_id": participant["id"], "participant": participant["name"], "reasons": reasons})
        scores.append(
            {
                "participant_id": participant["id"],
                "participant": participant["name"],
                "score": 0.0 if reasons else _participant_score(participant, option),
            }
        )
    feasible = not violations
    valid_scores = [item["score"] for item in scores] if feasible else []
    return {
        "option_id": option["id"],
        "name": option["name"],
        "feasible": feasible,
        "violations": violations,
        "scores": scores,
        "min_score": round(min(valid_scores), 1) if valid_scores else 0.0,
        "average_score": round(sum(valid_scores) / len(valid_scores), 1) if valid_scores else 0.0,
        "hard_checks": hard_checks,
    }


def _dominates(left: dict[str, Any], right: dict[str, Any]) -> bool:
    left_scores = {item["participant_id"]: item["score"] for item in left["scores"]}
    right_scores = {item["participant_id"]: item["score"] for item in right["scores"]}
    if left_scores.keys() != right_scores.keys() or not left_scores:
        return False
    return all(left_scores[key] >= right_scores[key] for key in left_scores) and any(
        left_scores[key] > right_scores[key] for key in left_scores
    )


def _analysis_for_connection(connection: sqlite3.Connection, room_id: int) -> dict[str, Any]:
    _room_or_404(connection, room_id)
    participants = [
        _participant_from_row(row)
        for row in connection.execute(
            "SELECT * FROM decision_participants WHERE room_id = ? ORDER BY id", (room_id,)
        )
    ]
    options = [
        _option_from_row(row)
        for row in connection.execute("SELECT * FROM decision_options WHERE room_id = ? ORDER BY id", (room_id,))
    ]
    vote_rows = connection.execute(
        "SELECT participant_id, option_id FROM decision_votes WHERE room_id = ? AND approved = 1",
        (room_id,),
    ).fetchall()
    vote_counts: dict[int, int] = {}
    for row in vote_rows:
        vote_counts[int(row["option_id"])] = vote_counts.get(int(row["option_id"]), 0) + 1
    blockers: list[str] = []
    if len(participants) < 2:
        blockers.append("至少需要 2 位参与者")
    if len(options) < 2:
        blockers.append("至少需要 2 个候选方案")
    evaluated = [_evaluate_option(participants, option) for option in options]
    feasible = [item for item in evaluated if item["feasible"]]
    pareto_ids = {
        item["option_id"]
        for item in feasible
        if not any(
            other["option_id"] != item["option_id"] and _dominates(other, item)
            for other in feasible
        )
    }
    option_lookup = {option["id"]: option for option in options}
    for item in evaluated:
        item["pareto"] = item["option_id"] in pareto_ids
        item["vote_count"] = vote_counts.get(item["option_id"], 0)
        item["option"] = option_lookup[item["option_id"]]
        item["summary"] = (
            f"满足全部 {item['hard_checks']} 项硬约束；最低满意度 {item['min_score']:.1f}，"
            f"平均 {item['average_score']:.1f}；{item['vote_count']} 人认可。"
            if item["feasible"]
            else f"未通过硬约束：{sum(len(entry['reasons']) for entry in item['violations'])} 项冲突。"
        )
    ranked = sorted(
        evaluated,
        key=lambda item: (
            not item["pareto"],
            not item["feasible"],
            -item["vote_count"],
            -item["min_score"],
            -item["average_score"],
            item["option"].get("cost_per_person") or float("inf"),
            item["name"],
        ),
    )
    for index, item in enumerate([entry for entry in ranked if entry["pareto"]], start=1):
        item["pareto_rank"] = index
    recommendation = next((item for item in ranked if item["pareto"]), None)
    return {
        "ready": not blockers,
        "blockers": blockers,
        "participant_count": len(participants),
        "option_count": len(options),
        "feasible_count": len(feasible),
        "pareto_count": len(pareto_ids),
        "voter_count": len({int(row["participant_id"]) for row in vote_rows}),
        "results": ranked,
        "recommended_option_id": recommendation["option_id"] if recommendation else None,
    }


def list_decision_rooms() -> list[dict[str, Any]]:
    with connect() as connection:
        init_db(connection)
        room_rows = connection.execute("SELECT * FROM decision_rooms ORDER BY updated_at DESC, id DESC").fetchall()
        result: list[dict[str, Any]] = []
        for row in room_rows:
            room = dict(row)
            participants = [
                _participant_from_row(item)
                for item in connection.execute(
                    "SELECT * FROM decision_participants WHERE room_id = ? ORDER BY id", (row["id"],)
                )
            ]
            options = [
                _option_from_row(item)
                for item in connection.execute(
                    "SELECT * FROM decision_options WHERE room_id = ? ORDER BY id", (row["id"],)
                )
            ]
            votes = [
                dict(item)
                for item in connection.execute(
                    "SELECT participant_id, option_id, approved, updated_at FROM decision_votes WHERE room_id = ? ORDER BY participant_id, option_id",
                    (row["id"],),
                )
            ]
            room["participants"] = [_public_participant(item) for item in participants]
            room["options"] = options
            room["votes"] = votes
            room["analysis"] = _analysis_for_connection(connection, int(row["id"]))
            room["selected_option"] = next(
                (item for item in options if item["id"] == row["selected_option_id"]), None
            )
            room["source"] = None
            if row["source_candidate_id"]:
                source = connection.execute(
                    """
                    SELECT candidates.id AS candidate_id, imports.filename,
                           messages.line_start, messages.line_end, messages.body AS source_text
                    FROM candidates
                    JOIN messages ON messages.id = candidates.message_id
                    JOIN imports ON imports.id = messages.import_id
                    WHERE candidates.id = ?
                    """,
                    (row["source_candidate_id"],),
                ).fetchone()
                room["source"] = dict(source) if source else None
                if room["source"]:
                    room["source"]["source_text"] = redact_private_budget_text(
                        room["source"].get("source_text")
                    )
            result.append(room)
        return result


def promote_decision_candidate(
    candidate_id: int,
    payload: dict[str, Any] | None = None,
    idempotency_key: Any = None,
) -> dict[str, Any]:
    """Confirm an imported unresolved topic and turn it into a decision workspace."""

    data = payload or {}
    if not isinstance(data, dict):
        raise ValueError("协商参数必须是对象")
    key = str(idempotency_key or f"deliberation:{candidate_id}:{uuid4().hex}")[:160]
    now = utcish_now()
    with connect() as connection:
        init_db(connection)
        existing_room = connection.execute(
            """
            SELECT decision_rooms.id, decision_rooms.status,
                   (SELECT COUNT(*) FROM decision_participants
                    WHERE decision_participants.room_id = decision_rooms.id) AS participant_count,
                   (SELECT COUNT(*) FROM decision_options
                    WHERE decision_options.room_id = decision_rooms.id) AS option_count
            FROM decision_rooms
            WHERE source_candidate_id = ?
            """,
            (candidate_id,),
        ).fetchone()
        if existing_room:
            return {
                "candidate_id": candidate_id,
                "room_id": int(existing_room["id"]),
                "participant_count": int(existing_room["participant_count"]),
                "option_count": int(existing_room["option_count"]),
                "status": existing_room["status"],
                "idempotent_replay": True,
            }
        candidate = connection.execute(
            """
            SELECT candidates.*, messages.import_id, messages.speaker, messages.body,
                   imports.filename
            FROM candidates
            JOIN messages ON messages.id = candidates.message_id
            JOIN imports ON imports.id = messages.import_id
            WHERE candidates.id = ?
            """,
            (candidate_id,),
        ).fetchone()
        if not candidate:
            raise DecisionNotFoundError("待协商议题不存在")
        if candidate["kind"] != "decision" or candidate["change_type"] != "deliberate":
            raise DecisionConflictError("该候选不是需要继续协商的共同议题")
        if candidate["status"] == "rejected":
            raise DecisionConflictError("该议题已经被忽略")
        if candidate["status"] == "approved":
            raise DecisionConflictError("该议题已处理，但没有关联的协商空间")

        try:
            draft = json.loads(candidate["decision_payload"] or "{}")
        except (TypeError, json.JSONDecodeError):
            draft = {}
        draft = draft if isinstance(draft, dict) else {}
        title = _clean_text(data.get("title") or draft.get("title") or candidate["title"], "议题", 80)
        scenario = str(data.get("scenario") or draft.get("scenario") or "general").strip().lower()
        if scenario not in SCENARIOS:
            raise ValueError("未知的决策场景")
        organizer = _clean_text(
            data.get("organizer") or draft.get("organizer") or candidate["owner"] or candidate["speaker"],
            "主持人",
            40,
        )
        description = _clean_text(
            data.get("description") or draft.get("description") or candidate["body"],
            "背景说明",
            500,
            required=False,
        )
        room_cursor = connection.execute(
            """
            INSERT INTO decision_rooms(
                title, scenario, description, organizer, status, source_candidate_id,
                created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'collecting', ?, ?, ?)
            """,
            (title, scenario, description, organizer, candidate_id, now, now),
        )
        room_id = int(room_cursor.lastrowid)
        source_messages = {
            int(row["ordinal"]): row
            for row in connection.execute(
                "SELECT id, ordinal, line_start, line_end, body FROM messages WHERE import_id = ?",
                (candidate["import_id"],),
            )
        }

        participant_count = 0
        seen_people: set[str] = set()
        for raw in (draft.get("participants") if isinstance(draft.get("participants"), list) else [])[:50]:
            if not isinstance(raw, dict):
                continue
            try:
                name = _clean_text(raw.get("name"), "参与者姓名", 40)
                if name.casefold() in seen_people:
                    continue
                budget = _number(raw.get("budget_max"), "预算上限", 10_000_000)
                distance = _number(raw.get("max_distance_km"), "最远距离", 100_000)
                earliest = _clock(raw.get("earliest_time"), "最早时间")
                latest = _clock(raw.get("latest_time"), "最晚时间")
                required = _tags(raw.get("required_tags"))
                avoided = _tags(raw.get("avoided_tags"))
                preferred = _tags(raw.get("preferred_tags"))
                note = _clean_text(raw.get("source_note"), "约束原话", 500, required=False)
            except ValueError:
                continue
            if {item.casefold() for item in required} & {item.casefold() for item in avoided}:
                continue
            try:
                source = source_messages.get(int(raw.get("source_message_index")))
            except (TypeError, ValueError):
                source = None
            connection.execute(
                """
                INSERT INTO decision_participants(
                    room_id, name, budget_max, budget_private, max_distance_km,
                    earliest_time, latest_time, required_tags, avoided_tags,
                    preferred_tags, source_note, source_message_id, source_line_start,
                    source_line_end, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    room_id,
                    name,
                    budget,
                    1 if raw.get("budget_private") else 0,
                    distance,
                    earliest,
                    latest,
                    json.dumps(required, ensure_ascii=False),
                    json.dumps(avoided, ensure_ascii=False),
                    json.dumps(preferred, ensure_ascii=False),
                    note,
                    source["id"] if source else None,
                    source["line_start"] if source else raw.get("source_line_start"),
                    source["line_end"] if source else raw.get("source_line_end"),
                    now,
                    now,
                ),
            )
            participant_count += 1
            seen_people.add(name.casefold())

        option_count = 0
        seen_options: set[str] = set()
        for raw in (draft.get("options") if isinstance(draft.get("options"), list) else [])[:100]:
            if not isinstance(raw, dict):
                continue
            try:
                name = _clean_text(raw.get("name"), "方案名称", 80)
                if name.casefold() in seen_options:
                    continue
                cost = _number(raw.get("cost_per_person"), "人均费用", 10_000_000)
                distance = _number(raw.get("distance_km"), "距离", 100_000)
                available = _clock(raw.get("available_time"), "可用时间")
                tags = _tags(raw.get("tags"))
                note = _clean_text(raw.get("source_note"), "方案来源", 500, required=False)
            except ValueError:
                continue
            try:
                source = source_messages.get(int(raw.get("source_message_index")))
            except (TypeError, ValueError):
                source = None
            connection.execute(
                """
                INSERT INTO decision_options(
                    room_id, name, cost_per_person, distance_km, available_time,
                    tags, source_note, source_message_id, source_line_start,
                    source_line_end, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    room_id,
                    name,
                    cost,
                    distance,
                    available,
                    json.dumps(tags, ensure_ascii=False),
                    note,
                    source["id"] if source else None,
                    source["line_start"] if source else raw.get("source_line_start"),
                    source["line_end"] if source else raw.get("source_line_end"),
                    now,
                    now,
                ),
            )
            option_count += 1
            seen_options.add(name.casefold())

        approval_cursor = connection.execute(
            """
            INSERT INTO approvals(candidate_id, action, result, actor, idempotency_key, created_at)
            VALUES (?, 'continue_deliberation', 'decision_room_created', 'local-user', ?, ?)
            """,
            (candidate_id, key, now),
        )
        approval_id = int(approval_cursor.lastrowid)
        connection.execute(
            "UPDATE candidates SET status = 'approved', updated_at = ? WHERE id = ?",
            (now, candidate_id),
        )
        audit(
            connection,
            "human.deliberation_confirmed",
            "local-user",
            "candidate",
            candidate_id,
            {"approval_id": approval_id, "room_id": room_id},
            key,
        )
        audit(
            connection,
            "tool.discussion_routed",
            "system",
            "decision_room",
            room_id,
            {
                "candidate_id": candidate_id,
                "participants_prefilled": participant_count,
                "options_prefilled": option_count,
                "source_filename": candidate["filename"],
            },
            key,
        )
        connection.commit()
    return {
        "candidate_id": candidate_id,
        "room_id": room_id,
        "participant_count": participant_count,
        "option_count": option_count,
        "status": "collecting",
    }


def analyze_decision_room(room_id: int) -> dict[str, Any]:
    now = utcish_now()
    with connect() as connection:
        init_db(connection)
        room = _room_or_404(connection, room_id)
        _ensure_collecting(room)
        analysis = _analysis_for_connection(connection, room_id)
        if not analysis["ready"]:
            raise DecisionConflictError("；".join(analysis["blockers"]))
        connection.execute(
            "UPDATE decision_rooms SET status = 'voting', updated_at = ? WHERE id = ?",
            (now, room_id),
        )
        audit(
            connection,
            "tool.pareto_analyzed",
            "system",
            "decision_room",
            room_id,
            {
                "participants": analysis["participant_count"],
                "options": analysis["option_count"],
                "feasible": analysis["feasible_count"],
                "pareto": analysis["pareto_count"],
                "pareto_option_ids": [item["option_id"] for item in analysis["results"] if item["pareto"]],
            },
        )
        connection.commit()
    return {"room_id": room_id, "analysis": analysis}


def cast_decision_votes(room_id: int, participant_id: int, option_ids: Any) -> dict[str, Any]:
    if not isinstance(option_ids, list):
        raise ValueError("投票方案必须是数组")
    try:
        selected = {int(value) for value in option_ids}
    except (TypeError, ValueError) as exc:
        raise ValueError("投票方案 ID 无效") from exc
    now = utcish_now()
    with connect() as connection:
        init_db(connection)
        room = _room_or_404(connection, room_id)
        _ensure_editable(room)
        if room["status"] != "voting":
            raise DecisionConflictError("请先计算并记录 Pareto 方案，再开始投票")
        participant = connection.execute(
            "SELECT * FROM decision_participants WHERE id = ? AND room_id = ?",
            (participant_id, room_id),
        ).fetchone()
        if not participant:
            raise DecisionNotFoundError("参与者不属于该决策室")
        analysis = _analysis_for_connection(connection, room_id)
        if not analysis["ready"]:
            raise DecisionConflictError("当前还不能投票")
        pareto_ids = {item["option_id"] for item in analysis["results"] if item["pareto"]}
        if not selected <= pareto_ids:
            raise DecisionConflictError("只能对满足硬约束的 Pareto 方案投票")
        connection.execute(
            "DELETE FROM decision_votes WHERE room_id = ? AND participant_id = ?",
            (room_id, participant_id),
        )
        for option_id in sorted(selected):
            connection.execute(
                """
                INSERT INTO decision_votes(room_id, participant_id, option_id, approved, created_at, updated_at)
                VALUES (?, ?, ?, 1, ?, ?)
                """,
                (room_id, participant_id, option_id, now, now),
            )
        connection.execute(
            "UPDATE decision_rooms SET status = 'voting', updated_at = ? WHERE id = ?",
            (now, room_id),
        )
        audit(
            connection,
            "human.vote_submitted",
            participant["name"],
            "decision_room",
            room_id,
            {"participant_id": participant_id, "option_ids": sorted(selected)},
        )
        connection.commit()
    return {"room_id": room_id, "participant_id": participant_id, "option_ids": sorted(selected)}


def _validated_due(value: Any) -> str:
    raw = str(value or "").strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError("行动截止时间格式无效") from exc
    parsed = parsed.replace(tzinfo=TZ) if parsed.tzinfo is None else parsed.astimezone(TZ)
    return parsed.replace(microsecond=0).isoformat()


def finalize_decision_room(
    room_id: int,
    option_id: int,
    action_title: Any,
    action_owner: Any,
    action_due_at: Any,
    decision_note: Any,
    idempotency_key: Any,
) -> dict[str, Any]:
    note = _clean_text(decision_note, "决策说明", 500, required=False)
    key = str(idempotency_key or f"decision:{room_id}:{uuid4().hex}")[:160]
    with connect() as connection:
        init_db(connection)
        room = _room_or_404(connection, room_id)
        if room["status"] == "decided":
            if int(room["selected_option_id"] or 0) != int(option_id):
                raise DecisionConflictError("该决策室已经确认了其他方案")
            return {
                "room_id": room_id,
                "option_id": int(room["selected_option_id"]),
                "task_id": room["action_task_id"],
                "idempotent_replay": True,
            }
        option = connection.execute(
            "SELECT * FROM decision_options WHERE id = ? AND room_id = ?", (option_id, room_id)
        ).fetchone()
        if not option:
            raise DecisionNotFoundError("候选方案不属于该决策室")
        analysis = _analysis_for_connection(connection, room_id)
        selected_result = next(
            (item for item in analysis["results"] if item["option_id"] == option_id), None
        )
        if not selected_result or not selected_result["pareto"]:
            raise DecisionConflictError("最终方案必须来自满足全部硬约束的 Pareto 候选集")
        if analysis["voter_count"] < 1:
            raise DecisionConflictError("至少需要一位参与者先完成投票")

        title_text = _clean_text(action_title, "后续行动", 120, required=False)
        owner_text = _clean_text(action_owner, "行动负责人", 40, required=False)
        due_text = str(action_due_at or "").strip()
        create_action = bool(title_text or owner_text or due_text)
        if create_action and not (title_text and owner_text and due_text):
            raise ValueError("创建后续行动时，任务、负责人和截止时间必须同时填写")
        due_at = _validated_due(due_text) if create_action else None
        now = utcish_now()
        task_id: int | None = None
        if create_action:
            source_text = (
                f"「{room['title']}」最终选择「{option['name']}」。"
                f"{owner_text}负责{title_text}，截止 {due_at}。"
            )
            import_cursor = connection.execute(
                """
                INSERT INTO imports(
                    filename, source_type, imported_at, message_count, extractor, model,
                    latency_ms, prompt_tokens, completion_tokens
                ) VALUES (?, 'decision_room', ?, 1, 'deterministic', 'pareto-v1', 0, 0, 0)
                """,
                (f"决策室-{room_id}.md", now),
            )
            import_id = int(import_cursor.lastrowid)
            message_cursor = connection.execute(
                """
                INSERT INTO messages(import_id, ordinal, speaker, sent_at, body, line_start, line_end)
                VALUES (?, 1, ?, ?, ?, 1, 1)
                """,
                (import_id, room["organizer"], now, source_text),
            )
            message_id = int(message_cursor.lastrowid)
            candidate_cursor = connection.execute(
                """
                INSERT INTO candidates(
                    message_id, kind, change_type, title, owner, due_at, status,
                    confidence, rule_id, created_at, updated_at
                ) VALUES (?, 'task', 'create', ?, ?, ?, 'approved', 1.0, 'decision.pareto_vote', ?, ?)
                """,
                (message_id, title_text, owner_text, due_at, now, now),
            )
            candidate_id = int(candidate_cursor.lastrowid)
            for field_name in ("event", "title", "owner", "due_at"):
                connection.execute(
                    """
                    INSERT INTO evidence(
                        candidate_id, field_name, message_id, quote, source_type, line_start, line_end
                    ) VALUES (?, ?, ?, ?, 'decision_approval', 1, 1)
                    """,
                    (candidate_id, field_name, message_id, source_text),
                )
            task_cursor = connection.execute(
                """
                INSERT INTO tasks(title, owner, due_at, status, source_candidate_id, created_at, updated_at)
                VALUES (?, ?, ?, 'todo', ?, ?, ?)
                """,
                (title_text, owner_text, due_at, candidate_id, now, now),
            )
            task_id = int(task_cursor.lastrowid)
            connection.execute(
                """
                INSERT INTO approvals(candidate_id, action, result, actor, idempotency_key, created_at)
                VALUES (?, 'approve', 'decision_task_created', 'local-user', ?, ?)
                """,
                (candidate_id, key, now),
            )

        connection.execute(
            """
            UPDATE decision_rooms
            SET status = 'decided', selected_option_id = ?, action_task_id = ?,
                decision_note = ?, finalized_at = ?, updated_at = ?
            WHERE id = ?
            """,
            (option_id, task_id, note, now, now, room_id),
        )
        audit(
            connection,
            "human.decision_finalized",
            room["organizer"],
            "decision_room",
            room_id,
            {
                "option_id": option_id,
                "option_name": option["name"],
                "vote_count": selected_result["vote_count"],
                "min_score": selected_result["min_score"],
                "average_score": selected_result["average_score"],
                "task_id": task_id,
            },
            key,
        )
        if task_id:
            audit(
                connection,
                "tool.decision_to_action",
                "system",
                "task",
                task_id,
                {"room_id": room_id, "option_id": option_id},
                key,
            )
        connection.commit()
    return {"room_id": room_id, "option_id": option_id, "task_id": task_id, "status": "decided"}


def seed_decision_demo() -> dict[str, Any]:
    now = utcish_now()
    title = "周五团队聚餐"
    with connect() as connection:
        init_db(connection)
        existing = connection.execute(
            "SELECT id FROM decision_rooms WHERE title = ? AND status != 'decided' ORDER BY id DESC LIMIT 1",
            (title,),
        ).fetchone()
        if existing:
            return {"room_id": int(existing["id"]), "existing": True}
        room_cursor = connection.execute(
            """
            INSERT INTO decision_rooms(title, scenario, description, organizer, status, created_at, updated_at)
            VALUES (?, 'dining', '在预算、距离、时间和饮食要求之间找到所有人都能接受的聚餐方案。', '安然', 'collecting', ?, ?)
            """,
            (title, now, now),
        )
        room_id = int(room_cursor.lastrowid)
        participants = [
            ("小林", 150, 0, 5, "18:30", "20:30", [], ["花生"], ["川菜", "安静"], "人均 150 内，不能有花生，最好安静一点。"),
            ("安然", 160, 1, 3, "19:00", "21:00", ["素食可选"], [], ["清淡", "安静"], "预算私密；要有素食选项，离公司三公里内。"),
            ("阿哲", 130, 0, 6, "18:00", "21:00", [], [], ["烧烤", "热闹"], "人均别超过 130，我更喜欢热闹或烧烤。"),
        ]
        for name, budget, private, distance, earliest, latest, required, avoided, preferred, note in participants:
            connection.execute(
                """
                INSERT INTO decision_participants(
                    room_id, name, budget_max, budget_private, max_distance_km,
                    earliest_time, latest_time, required_tags, avoided_tags,
                    preferred_tags, source_note, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    room_id,
                    name,
                    budget,
                    private,
                    distance,
                    earliest,
                    latest,
                    json.dumps(required, ensure_ascii=False),
                    json.dumps(avoided, ensure_ascii=False),
                    json.dumps(preferred, ensure_ascii=False),
                    note,
                    now,
                    now,
                ),
            )
        options = [
            ("椒香小馆", 118, 2.4, "19:00", ["川菜", "素食可选", "安静"], "群友推荐，可订 19:00。"),
            ("河畔轻食", 128, 1.5, "19:30", ["清淡", "素食可选", "安静"], "步行可达，有独立包间。"),
            ("城南火锅", 138, 4.2, "19:00", ["火锅", "素食可选", "热闹"], "距离稍远，人均价格偏高。"),
            ("街角烧烤", 98, 6.2, "20:30", ["烧烤", "热闹"], "便宜，但没有确认素食选项。"),
        ]
        for name, cost, distance, available, tags, note in options:
            connection.execute(
                """
                INSERT INTO decision_options(
                    room_id, name, cost_per_person, distance_km, available_time,
                    tags, source_note, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    room_id,
                    name,
                    cost,
                    distance,
                    available,
                    json.dumps(tags, ensure_ascii=False),
                    note,
                    now,
                    now,
                ),
            )
        audit(
            connection,
            "tool.decision_demo_created",
            "system",
            "decision_room",
            room_id,
            {"participants": len(participants), "options": len(options)},
        )
        connection.commit()
    return {"room_id": room_id, "existing": False}
