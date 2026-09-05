from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any
from uuid import uuid4
from zoneinfo import ZoneInfo

from .db import audit, connect, init_db, rows_to_dicts, utcish_now
from .decisions import list_decision_rooms
from .discussion import extract_deliberation, redact_private_budget_text
from .parser import clarification_question, extract_candidates, normalize_messages, title_similarity
from .providers import (
    ExtractionMetadata,
    ExtractionResult,
    ProviderError,
    extract_with_deepseek,
    provider_status,
)


TZ = ZoneInfo("Asia/Shanghai")
ACTIVE_STATUSES = {"todo", "in_progress", "blocked"}


class ConflictError(RuntimeError):
    pass


class NotFoundError(RuntimeError):
    pass


def _redact_public_value(value: Any) -> Any:
    """Remove explicitly private budget values from every public text field."""

    if isinstance(value, dict):
        return {key: _redact_public_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_redact_public_value(item) for item in value]
    if isinstance(value, tuple):
        return tuple(_redact_public_value(item) for item in value)
    if isinstance(value, str):
        return redact_private_budget_text(value)
    return value


def bootstrap() -> None:
    with connect() as connection:
        init_db(connection)


def _candidate_dict(connection: sqlite3.Connection, row: sqlite3.Row) -> dict[str, Any]:
    result = dict(row)
    raw_draft = result.pop("decision_payload", None)
    try:
        parsed_draft = json.loads(raw_draft) if raw_draft else None
        result["decision_draft"] = parsed_draft if isinstance(parsed_draft, dict) else None
    except (TypeError, json.JSONDecodeError):
        result["decision_draft"] = None
    if result["decision_draft"]:
        for participant in result["decision_draft"].get("participants", []):
            if isinstance(participant, dict) and participant.get("budget_private"):
                participant["budget_configured"] = participant.get("budget_max") is not None
                participant["budget_max"] = None
                participant["source_note"] = redact_private_budget_text(participant.get("source_note"))
    result["source_text"] = redact_private_budget_text(result.get("source_text"))
    promoted = connection.execute(
        "SELECT id FROM decision_rooms WHERE source_candidate_id = ?", (row["id"],)
    ).fetchone()
    result["promoted_room_id"] = int(promoted["id"]) if promoted else None
    result["evidence"] = rows_to_dicts(
        connection.execute(
            "SELECT field_name, quote, source_type, line_start, line_end, message_id FROM evidence WHERE candidate_id = ? ORDER BY id",
            (row["id"],),
        )
    )
    for evidence in result["evidence"]:
        evidence["quote"] = redact_private_budget_text(evidence.get("quote"))
    result["clarifications"] = rows_to_dicts(
        connection.execute(
            "SELECT id, field_name, question, answer, resolved, created_at, resolved_at FROM clarifications WHERE candidate_id = ? ORDER BY id",
            (row["id"],),
        )
    )
    return result


def _read_simulated_now(connection: sqlite3.Connection) -> datetime:
    row = connection.execute("SELECT value FROM settings WHERE key = 'simulated_now'").fetchone()
    value = row["value"] if row else utcish_now()
    try:
        parsed = datetime.fromisoformat(value)
        return parsed.replace(tzinfo=TZ) if parsed.tzinfo is None else parsed.astimezone(TZ)
    except ValueError:
        return datetime.now(TZ).replace(microsecond=0)


def _task_health(task: dict[str, Any], now: datetime) -> str:
    if task["status"] in {"done", "cancelled"}:
        return task["status"]
    if task["status"] == "blocked":
        return "blocked"
    due = datetime.fromisoformat(task["due_at"])
    if due < now:
        return "overdue"
    if due <= now + timedelta(hours=48):
        return "due_soon"
    return "on_track"


def _reminder_queue(tasks: list[dict[str, Any]], now: datetime) -> list[dict[str, Any]]:
    queue: list[dict[str, Any]] = []
    for task in tasks:
        health = task["health"]
        if health not in {"overdue", "due_soon", "blocked"}:
            continue
        if health == "overdue":
            lead = "已逾期"
            priority = 1
        elif health == "blocked":
            lead = "处于阻塞状态"
            priority = 2
        else:
            hours = max(0, int((datetime.fromisoformat(task["due_at"]) - now).total_seconds() // 3600))
            lead = f"将在 {hours} 小时内到期"
            priority = 3
        queue.append(
            {
                "task_id": task["id"],
                "kind": health,
                "owner": task["owner"],
                "title": task["title"],
                "due_at": task["due_at"],
                "draft": f"提醒 @{task['owner']}：{task['title']} {lead}，请更新进展或说明阻塞。",
                "status": "draft",
                "priority": priority,
            }
        )
    return sorted(queue, key=lambda item: (item["priority"], item["due_at"]))


def _digest(
    tasks: list[dict[str, Any]],
    reminders: list[dict[str, Any]],
    candidates: list[dict[str, Any]],
    now: datetime,
    scope: str = "daily",
    decision_rooms: list[dict[str, Any]] | None = None,
) -> str:
    if scope == "weekly":
        period_start = now.date() - timedelta(days=now.weekday())
        period_end = period_start + timedelta(days=6)
        report_name = "闭环周报"
        period_label = f"{period_start.isoformat()} ~ {period_end.isoformat()}"
    else:
        report_name = "闭环日报"
        period_label = now.strftime("%Y-%m-%d")
    active = [task for task in tasks if task["status"] in ACTIVE_STATUSES]
    done = [task for task in tasks if task["status"] == "done"]
    lines = [
        f"# Converge {report_name} · {period_label}",
        "",
        f"> 当前 {len(active)} 项进行中，{len(done)} 项已完成，{len(reminders)} 项需要关注。",
        "",
    ]
    groups = [
        ("需要关注", [task for task in tasks if task["health"] in {"overdue", "blocked", "due_soon"}]),
        ("正常推进", [task for task in tasks if task["health"] == "on_track"]),
        ("已闭环", done),
    ]
    for heading, items in groups:
        lines.append(f"## {heading}")
        if not items:
            lines.append("- 暂无")
        for task in items:
            source = task.get("source_filename") or "未知来源"
            line = task.get("source_line_start") or "?"
            evidence = f"证据：{source} 第 {line} 行"
            lines.append(
                f"- [{task['status']}] {task['title']} · @{task['owner']} · {task['due_at'][:16].replace('T', ' ')}（{evidence}）"
            )
        lines.append("")
    accepted_context = [
        candidate
        for candidate in candidates
        if candidate["status"] == "approved"
        and candidate["kind"] in {"decision", "risk"}
        and candidate["change_type"] != "deliberate"
    ]
    lines.append("## 已确认的决策与风险")
    if not accepted_context:
        lines.append("- 暂无")
    for candidate in accepted_context:
        label = "决策" if candidate["kind"] == "decision" else "风险"
        lines.append(
            f"- [{label}] {candidate['title']}（证据：{candidate['filename']} 第 {candidate['line_start']} 行）"
        )
    lines.append("")
    lines.append("## 群体决策")
    rooms = decision_rooms or []
    if not rooms:
        lines.append("- 暂无")
    for room in rooms:
        if room["status"] == "decided" and room.get("selected_option"):
            task_ref = f"，后续 TASK-{room['action_task_id']:03d}" if room.get("action_task_id") else ""
            lines.append(
                f"- [已决策] {room['title']} → {room['selected_option']['name']}"
                f"（{room['analysis']['voter_count']} 人参与投票{task_ref}）"
            )
        else:
            lines.append(
                f"- [进行中] {room['title']} · {room['analysis']['participant_count']} 人 · "
                f"{room['analysis']['pareto_count']} 个 Pareto 方案"
            )
    lines.append("")
    lines.extend(["---", "本报告基于已审批任务生成；提醒仍为草稿，未向任何人发送。"])
    return "\n".join(lines)


def get_state() -> dict[str, Any]:
    with connect() as connection:
        init_db(connection)
        imports = rows_to_dicts(connection.execute("SELECT * FROM imports ORDER BY id DESC LIMIT 20"))
        messages = rows_to_dicts(
            connection.execute(
                """
                SELECT messages.*, imports.filename
                FROM messages JOIN imports ON imports.id = messages.import_id
                ORDER BY messages.id DESC LIMIT 120
                """
            )
        )
        for message in messages:
            message["body"] = redact_private_budget_text(message.get("body"))
        candidate_rows = connection.execute(
            """
            SELECT candidates.*, messages.speaker, messages.sent_at, messages.body AS source_text,
                   messages.line_start, messages.line_end, imports.filename
            FROM candidates
            JOIN messages ON messages.id = candidates.message_id
            JOIN imports ON imports.id = messages.import_id
            ORDER BY candidates.id DESC
            """
        ).fetchall()
        candidates = [_candidate_dict(connection, row) for row in candidate_rows]
        tasks = rows_to_dicts(
            connection.execute(
                """
                SELECT tasks.*, messages.line_start AS source_line_start,
                       messages.line_end AS source_line_end, messages.body AS source_text,
                       imports.filename AS source_filename
                FROM tasks
                JOIN candidates ON candidates.id = tasks.source_candidate_id
                JOIN messages ON messages.id = candidates.message_id
                JOIN imports ON imports.id = messages.import_id
                ORDER BY tasks.updated_at DESC, tasks.id DESC
                """
            )
        )
        now = _read_simulated_now(connection)
        for task in tasks:
            task["health"] = _task_health(task, now)
        reminders = _reminder_queue(tasks, now)
        decision_rooms = list_decision_rooms()
        audits = rows_to_dicts(connection.execute("SELECT * FROM audit_events ORDER BY id DESC LIMIT 150"))
        for item in audits:
            try:
                item["payload"] = json.loads(item["payload"])
            except (TypeError, json.JSONDecodeError):
                pass
        pending = sum(candidate["status"] in {"pending", "needs_clarification"} for candidate in candidates)
        provider = provider_status()
        latest_model_import = next((item for item in imports if item.get("extractor") == "deepseek"), None)
        provider["last_call"] = (
            {
                "model": latest_model_import.get("model"),
                "latency_ms": latest_model_import.get("latency_ms"),
                "prompt_tokens": latest_model_import.get("prompt_tokens", 0),
                "completion_tokens": latest_model_import.get("completion_tokens", 0),
                "imported_at": latest_model_import.get("imported_at"),
            }
            if latest_model_import
            else None
        )
        return _redact_public_value({
            "imports": imports,
            "messages": messages,
            "candidates": candidates,
            "tasks": tasks,
            "reminders": reminders,
            "audits": audits,
            "decision_rooms": decision_rooms,
            "simulated_now": now.replace(microsecond=0).isoformat(),
            "digest": _digest(tasks, reminders, candidates, now, decision_rooms=decision_rooms),
            "provider": provider,
            "stats": {
                "message_count": sum(item["message_count"] for item in imports),
                "pending_count": pending,
                "task_count": len(tasks),
                "attention_count": len(reminders),
                "decision_room_count": len(decision_rooms),
                "open_decision_count": sum(room["status"] != "decided" for room in decision_rooms),
                "model_tokens": sum(
                    int(item.get("prompt_tokens") or 0) + int(item.get("completion_tokens") or 0)
                    for item in imports
                ),
            },
        })


def generate_report(scope: str = "daily") -> dict[str, Any]:
    if scope not in {"daily", "weekly"}:
        raise ValueError("报告范围只能是 daily 或 weekly")
    state = get_state()
    now = datetime.fromisoformat(state["simulated_now"])
    return {
        "scope": scope,
        "generated_at": utcish_now(),
        "report": _digest(
            state["tasks"],
            state["reminders"],
            state["candidates"],
            now,
            scope,
            state["decision_rooms"],
        ),
    }


def _ics_escape(value: Any) -> str:
    return (
        str(value or "")
        .replace("\\", "\\\\")
        .replace("\n", "\\n")
        .replace(";", "\\;")
        .replace(",", "\\,")
    )


def _ics_utc(value: str) -> str:
    parsed = datetime.fromisoformat(value)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=TZ)
    return parsed.astimezone(ZoneInfo("UTC")).strftime("%Y%m%dT%H%M%SZ")


def export_tasks_ics() -> str:
    state = get_state()
    now_stamp = _ics_utc(utcish_now())
    status_map = {
        "todo": "NEEDS-ACTION",
        "in_progress": "IN-PROCESS",
        "blocked": "IN-PROCESS",
        "done": "COMPLETED",
        "cancelled": "CANCELLED",
    }
    lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Converge//Local MVP//ZH-CN",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
    ]
    for task in sorted(state["tasks"], key=lambda item: item["id"]):
        description = (
            f"负责人: {task['owner']} | 证据: {task.get('source_filename', '')} "
            f"第 {task.get('source_line_start', '?')} 行"
        )
        lines.extend(
            [
                "BEGIN:VTODO",
                f"UID:task-{task['id']}-v{task['version']}@converge.local",
                f"DTSTAMP:{now_stamp}",
                f"DUE:{_ics_utc(task['due_at'])}",
                f"SUMMARY:{_ics_escape(task['title'])}",
                f"DESCRIPTION:{_ics_escape(description)}",
                f"STATUS:{status_map.get(task['status'], 'NEEDS-ACTION')}",
            ]
        )
        if task["status"] == "done":
            lines.append(f"COMPLETED:{_ics_utc(task['updated_at'])}")
        lines.append("END:VTODO")
    lines.extend(["END:VCALENDAR", ""])
    return "\r\n".join(lines)


def _rule_extraction(messages: list[Any], fallback_reason: str | None = None) -> ExtractionResult:
    events = [
        (index, candidate)
        for index, message in enumerate(messages, start=1)
        for candidate in extract_candidates(message)
    ]
    return ExtractionResult(
        events,
        ExtractionMetadata(
            extractor="rules",
            model="baseline-rules-v1",
            latency_ms=0,
            fallback_reason=fallback_reason,
        ),
    )


def _with_deliberation(result: ExtractionResult, messages: list[Any]) -> ExtractionResult:
    draft = extract_deliberation(messages)
    if not draft:
        return result
    anchor_index, candidate = draft
    events = [
        (index, item)
        for index, item in result.events
        if not (index == anchor_index and item.kind == "decision")
    ]
    events.append((anchor_index, candidate))
    events.sort(key=lambda entry: entry[0])
    return ExtractionResult(events, result.metadata)


def _extract_conversation(messages: list[Any], requested: str | None) -> ExtractionResult:
    mode = (requested or provider_status()["mode"] or "auto").strip().lower()
    if mode not in {"auto", "rules", "deepseek"}:
        raise ValueError("抽取模式只能是 auto、rules 或 deepseek")
    if mode == "rules":
        return _with_deliberation(_rule_extraction(messages), messages)
    with connect() as connection:
        init_db(connection)
        current_tasks = rows_to_dicts(
            connection.execute(
                "SELECT id, title, owner, due_at, status FROM tasks ORDER BY updated_at DESC LIMIT 100"
            )
        )
    configured = provider_status()["configured"]
    if mode == "deepseek":
        if not configured:
            raise ProviderError("DeepSeek 尚未配置，请设置 DEEPSEEK_API_KEY")
        return _with_deliberation(extract_with_deepseek(messages, current_tasks), messages)
    if not configured:
        return _with_deliberation(
            _rule_extraction(messages, "未配置 DeepSeek，已使用规则 Baseline"), messages
        )
    try:
        return _with_deliberation(extract_with_deepseek(messages, current_tasks), messages)
    except ProviderError as exc:
        return _with_deliberation(_rule_extraction(messages, str(exc)[:300]), messages)


def import_conversation(filename: str, content: str, extractor: str | None = None) -> dict[str, Any]:
    if not filename or not content.strip():
        raise ValueError("文件名和内容不能为空")
    if len(content.encode("utf-8")) > 5 * 1024 * 1024:
        raise ValueError("单个文件不能超过 5 MB")
    messages = normalize_messages(filename, content)
    extraction = _extract_conversation(messages, extractor)
    metadata = extraction.metadata
    now = utcish_now()
    source_type = Path(filename).suffix.lower().lstrip(".")
    with connect() as connection:
        init_db(connection)
        cursor = connection.execute(
            """
            INSERT INTO imports(
                filename, source_type, imported_at, message_count, extractor, model,
                latency_ms, prompt_tokens, completion_tokens, extraction_error
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                Path(filename).name,
                source_type,
                now,
                len(messages),
                metadata.extractor,
                metadata.model,
                metadata.latency_ms,
                metadata.prompt_tokens,
                metadata.completion_tokens,
                metadata.fallback_reason,
            ),
        )
        import_id = int(cursor.lastrowid)
        candidate_count = 0
        message_records: dict[int, tuple[int, Any]] = {}
        for ordinal, message in enumerate(messages, start=1):
            cursor = connection.execute(
                """
                INSERT INTO messages(import_id, ordinal, speaker, sent_at, body, line_start, line_end)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (import_id, ordinal, message.speaker, message.sent_at, message.body, message.line_start, message.line_end),
            )
            message_id = int(cursor.lastrowid)
            message_records[ordinal] = (message_id, message)

        for message_index, extracted in extraction.events:
            record = message_records.get(message_index)
            if not record:
                continue
            message_id, message = record
            status = "needs_clarification" if extracted.clarification_fields else "pending"
            cursor = connection.execute(
                """
                INSERT INTO candidates(
                    message_id, kind, change_type, title, owner, due_at, status,
                    confidence, rule_id, target_task_id, decision_payload, created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    message_id,
                    extracted.kind,
                    extracted.change_type,
                    extracted.title,
                    extracted.owner,
                    extracted.due_at,
                    status,
                    extracted.confidence,
                    extracted.rule_id,
                    extracted.target_task_id,
                    json.dumps(extracted.decision_payload, ensure_ascii=False) if extracted.decision_payload else None,
                    now,
                    now,
                ),
            )
            candidate_id = int(cursor.lastrowid)
            candidate_count += 1
            for field_name, quote in extracted.evidence_fields.items():
                evidence_index = extracted.evidence_message_indices.get(field_name, message_index)
                evidence_message_id, evidence_message = message_records.get(evidence_index, record)
                connection.execute(
                    """
                    INSERT INTO evidence(
                        candidate_id, field_name, message_id, quote, source_type, line_start, line_end
                    ) VALUES (?, ?, ?, ?, 'message', ?, ?)
                    """,
                    (
                        candidate_id,
                        field_name,
                        evidence_message_id,
                        quote,
                        evidence_message.line_start,
                        evidence_message.line_end,
                    ),
                )
            for field_name in extracted.clarification_fields:
                connection.execute(
                    """
                    INSERT INTO clarifications(candidate_id, field_name, question, created_at)
                    VALUES (?, ?, ?, ?)
                    """,
                    (candidate_id, field_name, clarification_question(field_name, extracted.change_type), now),
                )
            audit(
                connection,
                "model.candidate_detected",
                metadata.model,
                "candidate",
                candidate_id,
                {
                    "rule_id": extracted.rule_id,
                    "confidence": extracted.confidence,
                    "kind": extracted.kind,
                    "change_type": extracted.change_type,
                    "missing_fields": extracted.clarification_fields,
                    "evidence_message_indices": extracted.evidence_message_indices,
                },
            )
        audit(
            connection,
            "model.extraction_completed" if not metadata.fallback_reason else "model.extraction_fallback",
            metadata.model,
            "import",
            import_id,
            {
                "extractor": metadata.extractor,
                "model": metadata.model,
                "latency_ms": metadata.latency_ms,
                "prompt_tokens": metadata.prompt_tokens,
                "completion_tokens": metadata.completion_tokens,
                "request_ids": list(metadata.request_ids),
                "finish_reasons": list(metadata.finish_reasons),
                "fallback_reason": metadata.fallback_reason,
                "message_count": len(messages),
                "candidate_count": candidate_count,
            },
        )
        audit(
            connection,
            "tool.import_conversation",
            "system",
            "import",
            import_id,
            {
                "filename": Path(filename).name,
                "messages": len(messages),
                "candidates": candidate_count,
                "extractor": metadata.extractor,
                "model": metadata.model,
            },
            f"import:{import_id}",
        )
        connection.commit()
    return {
        "import_id": import_id,
        "message_count": len(messages),
        "candidate_count": candidate_count,
        "deliberation_count": sum(
            candidate.change_type == "deliberate" for _, candidate in extraction.events
        ),
        "extractor": metadata.extractor,
        "model": metadata.model,
        "latency_ms": metadata.latency_ms,
        "prompt_tokens": metadata.prompt_tokens,
        "completion_tokens": metadata.completion_tokens,
        "fallback_reason": metadata.fallback_reason,
    }


def _candidate_or_404(connection: sqlite3.Connection, candidate_id: int) -> sqlite3.Row:
    row = connection.execute("SELECT * FROM candidates WHERE id = ?", (candidate_id,)).fetchone()
    if not row:
        raise NotFoundError("候选事项不存在")
    return row


def clarify_candidate(candidate_id: int, updates: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(updates, dict):
        raise ValueError("澄清内容必须是字段对象")
    allowed = {"title", "owner", "due_at", "target_task_id"}
    cleaned = {key: value for key, value in updates.items() if key in allowed and value not in (None, "")}
    if not cleaned:
        raise ValueError("没有可保存的澄清内容")
    for field_name in ("title", "owner"):
        if field_name in cleaned:
            cleaned[field_name] = str(cleaned[field_name]).strip()
            if not cleaned[field_name] or len(cleaned[field_name]) > (120 if field_name == "title" else 40):
                raise ValueError(f"{field_name} 长度无效")
    if "due_at" in cleaned:
        cleaned["due_at"] = _validated_datetime(str(cleaned["due_at"]), "截止时间")
    if "target_task_id" in cleaned:
        try:
            cleaned["target_task_id"] = int(cleaned["target_task_id"])
        except (TypeError, ValueError) as exc:
            raise ValueError("目标任务编号无效") from exc
    now = utcish_now()
    with connect() as connection:
        init_db(connection)
        row = _candidate_or_404(connection, candidate_id)
        if row["status"] in {"approved", "rejected"}:
            raise ConflictError("已处理的候选事项不能再修改")
        assignments = ", ".join(f"{key} = ?" for key in cleaned)
        connection.execute(
            f"UPDATE candidates SET {assignments}, updated_at = ? WHERE id = ?",
            (*cleaned.values(), now, candidate_id),
        )
        for field_name, value in cleaned.items():
            connection.execute(
                """
                UPDATE clarifications SET answer = ?, resolved = 1, resolved_at = ?
                WHERE candidate_id = ? AND field_name = ?
                """,
                (str(value), now, candidate_id, field_name),
            )
            connection.execute(
                """
                INSERT INTO evidence(candidate_id, field_name, quote, source_type)
                VALUES (?, ?, ?, 'user_confirmation')
                """,
                (candidate_id, field_name, str(value)),
            )
        unresolved = connection.execute(
            "SELECT COUNT(*) AS count FROM clarifications WHERE candidate_id = ? AND resolved = 0",
            (candidate_id,),
        ).fetchone()["count"]
        connection.execute(
            "UPDATE candidates SET status = ? WHERE id = ?",
            ("needs_clarification" if unresolved else "pending", candidate_id),
        )
        audit(connection, "human.clarification", "local-user", "candidate", candidate_id, cleaned)
        connection.commit()
    return {"candidate_id": candidate_id, "updated": cleaned}


def _best_task_match(connection: sqlite3.Connection, title: str | None) -> int | None:
    if not title:
        return None
    rows = connection.execute(
        "SELECT id, title FROM tasks WHERE status != 'cancelled' ORDER BY updated_at DESC"
    ).fetchall()
    scored = [(title_similarity(title, row["title"]), row["id"]) for row in rows]
    if not scored:
        return None
    score, task_id = max(scored)
    return int(task_id) if score >= 0.56 else None


def _duplicate_task_match(connection: sqlite3.Connection, title: str, owner: str) -> int | None:
    rows = connection.execute(
        "SELECT id, title, owner FROM tasks WHERE status != 'cancelled' ORDER BY updated_at DESC"
    ).fetchall()
    for row in rows:
        if row["owner"] == owner and title_similarity(title, row["title"]) >= 0.96:
            return int(row["id"])
    return None


def _validated_datetime(value: str, label: str) -> str:
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    try:
        parsed = datetime.fromisoformat(raw)
    except ValueError as exc:
        raise ValueError(f"{label}格式无效") from exc
    parsed = parsed.replace(tzinfo=TZ) if parsed.tzinfo is None else parsed.astimezone(TZ)
    return parsed.replace(microsecond=0).isoformat()


def approve_candidate(candidate_id: int, edits: dict[str, Any] | None, idempotency_key: str | None) -> dict[str, Any]:
    key = (idempotency_key or f"approve:{candidate_id}:{uuid4().hex}")[:160]
    edits = edits or {}
    if not isinstance(edits, dict):
        raise ValueError("编辑内容必须是字段对象")
    # Check before applying edits so a network retry with the same key is a true no-op.
    with connect() as connection:
        init_db(connection)
        existing = connection.execute(
            "SELECT * FROM approvals WHERE idempotency_key = ?", (key,)
        ).fetchone()
        if existing:
            return {"approval_id": existing["id"], "result": existing["result"], "idempotent_replay": True}
        prior = _candidate_or_404(connection, candidate_id)
        if prior["status"] == "approved":
            task = connection.execute(
                "SELECT id FROM tasks WHERE source_candidate_id = ?", (candidate_id,)
            ).fetchone()
            return {
                "candidate_id": candidate_id,
                "task_id": task["id"] if task else prior["target_task_id"],
                "idempotent_replay": True,
            }
        if prior["status"] == "rejected":
            raise ConflictError("该候选事项已被拒绝")
        if prior["kind"] == "decision" and prior["change_type"] == "deliberate":
            raise ConflictError("该议题需要进入协商流程，不能作为普通记录直接确认")
    if edits:
        clarify_candidate(candidate_id, edits)
    now = utcish_now()
    with connect() as connection:
        init_db(connection)
        existing = connection.execute(
            "SELECT * FROM approvals WHERE idempotency_key = ?", (key,)
        ).fetchone()
        if existing:
            return {"approval_id": existing["id"], "result": existing["result"], "idempotent_replay": True}
        candidate = _candidate_or_404(connection, candidate_id)
        if candidate["status"] == "approved":
            task = connection.execute(
                "SELECT id FROM tasks WHERE source_candidate_id = ?", (candidate_id,)
            ).fetchone()
            return {"candidate_id": candidate_id, "task_id": task["id"] if task else candidate["target_task_id"], "idempotent_replay": True}
        if candidate["status"] == "rejected":
            raise ConflictError("该候选事项已被拒绝")
        if candidate["kind"] == "decision" and candidate["change_type"] == "deliberate":
            raise ConflictError("该议题需要进入协商流程，不能作为普通记录直接确认")
        unresolved = connection.execute(
            "SELECT field_name FROM clarifications WHERE candidate_id = ? AND resolved = 0",
            (candidate_id,),
        ).fetchall()
        if unresolved:
            fields = "、".join(row["field_name"] for row in unresolved)
            raise ConflictError(f"请先补全：{fields}")

        result = "recorded"
        task_id: int | None = None
        if candidate["kind"] == "task" and candidate["change_type"] == "create":
            if not candidate["title"] or not candidate["owner"] or not candidate["due_at"]:
                raise ConflictError("新任务必须包含动作、负责人和截止时间")
            task_id = _duplicate_task_match(connection, candidate["title"], candidate["owner"])
            if task_id:
                connection.execute("UPDATE candidates SET target_task_id = ? WHERE id = ?", (task_id, candidate_id))
                result = "duplicate_linked"
            else:
                cursor = connection.execute(
                    """
                    INSERT INTO tasks(title, owner, due_at, status, source_candidate_id, created_at, updated_at)
                    VALUES (?, ?, ?, 'todo', ?, ?, ?)
                    """,
                    (candidate["title"], candidate["owner"], candidate["due_at"], candidate_id, now, now),
                )
                task_id = int(cursor.lastrowid)
                result = "task_created"
        elif candidate["kind"] == "task":
            task_id = candidate["target_task_id"] or _best_task_match(connection, candidate["title"])
            if not task_id:
                raise ConflictError("没有找到可安全匹配的原任务，请在候选卡片中选择目标任务")
            task = connection.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
            if not task:
                raise ConflictError("目标任务不存在")
            updates: dict[str, Any] = {"updated_at": now}
            change = candidate["change_type"]
            if change == "complete":
                updates["status"] = "done"
            elif change == "cancel":
                updates["status"] = "cancelled"
            elif change == "reschedule":
                if not candidate["due_at"]:
                    raise ConflictError("改期必须补充新的截止时间")
                updates["due_at"] = candidate["due_at"]
            elif change == "transfer":
                if not candidate["owner"]:
                    raise ConflictError("转交必须补充新的负责人")
                updates["owner"] = candidate["owner"]
            assignments = ", ".join(f"{field_name} = ?" for field_name in updates)
            connection.execute(
                f"UPDATE tasks SET {assignments}, version = version + 1 WHERE id = ?",
                (*updates.values(), task_id),
            )
            connection.execute("UPDATE candidates SET target_task_id = ? WHERE id = ?", (task_id, candidate_id))
            result = {
                "complete": "task_completed",
                "cancel": "task_cancelled",
                "reschedule": "task_rescheduled",
                "transfer": "task_transferred",
            }.get(change, "task_updated")

        cursor = connection.execute(
            """
            INSERT INTO approvals(candidate_id, action, result, actor, idempotency_key, created_at)
            VALUES (?, 'approve', ?, 'local-user', ?, ?)
            """,
            (candidate_id, result, key, now),
        )
        approval_id = int(cursor.lastrowid)
        connection.execute("UPDATE candidates SET status = 'approved', updated_at = ? WHERE id = ?", (now, candidate_id))
        audit(
            connection,
            "human.approved",
            "local-user",
            "candidate",
            candidate_id,
            {"approval_id": approval_id, "result": result},
            key,
        )
        audit(
            connection,
            "tool.commit_approved_action",
            "system",
            "task" if task_id else candidate["kind"],
            task_id or candidate_id,
            {"candidate_id": candidate_id, "result": result},
            key,
        )
        connection.commit()
        return {"approval_id": approval_id, "candidate_id": candidate_id, "task_id": task_id, "result": result}


def reject_candidate(candidate_id: int, idempotency_key: str | None) -> dict[str, Any]:
    key = (idempotency_key or f"reject:{candidate_id}:{uuid4().hex}")[:160]
    now = utcish_now()
    with connect() as connection:
        init_db(connection)
        existing = connection.execute("SELECT * FROM approvals WHERE idempotency_key = ?", (key,)).fetchone()
        if existing:
            return {"approval_id": existing["id"], "idempotent_replay": True}
        candidate = _candidate_or_404(connection, candidate_id)
        if candidate["status"] == "approved":
            raise ConflictError("已确认的事项不能再拒绝")
        if candidate["status"] == "rejected":
            return {"candidate_id": candidate_id, "idempotent_replay": True}
        cursor = connection.execute(
            """
            INSERT INTO approvals(candidate_id, action, result, actor, idempotency_key, created_at)
            VALUES (?, 'reject', 'candidate_rejected', 'local-user', ?, ?)
            """,
            (candidate_id, key, now),
        )
        connection.execute("UPDATE candidates SET status = 'rejected', updated_at = ? WHERE id = ?", (now, candidate_id))
        audit(connection, "human.rejected", "local-user", "candidate", candidate_id, {}, key)
        connection.commit()
        return {"approval_id": cursor.lastrowid, "candidate_id": candidate_id}


def update_task(task_id: int, updates: dict[str, Any]) -> dict[str, Any]:
    if not isinstance(updates, dict):
        raise ValueError("任务更新必须是字段对象")
    allowed = {"title", "owner", "due_at", "status"}
    cleaned = {key: value for key, value in updates.items() if key in allowed and value not in (None, "")}
    if "status" in cleaned and cleaned["status"] not in {"todo", "in_progress", "blocked", "done", "cancelled"}:
        raise ValueError("未知的任务状态")
    if not cleaned:
        raise ValueError("没有可更新字段")
    for field_name in ("title", "owner"):
        if field_name in cleaned:
            cleaned[field_name] = str(cleaned[field_name]).strip()
            if not cleaned[field_name] or len(cleaned[field_name]) > (120 if field_name == "title" else 40):
                raise ValueError(f"{field_name} 长度无效")
    if "due_at" in cleaned:
        cleaned["due_at"] = _validated_datetime(str(cleaned["due_at"]), "截止时间")
    now = utcish_now()
    with connect() as connection:
        init_db(connection)
        old = connection.execute("SELECT * FROM tasks WHERE id = ?", (task_id,)).fetchone()
        if not old:
            raise NotFoundError("任务不存在")
        assignments = ", ".join(f"{key} = ?" for key in cleaned)
        connection.execute(
            f"UPDATE tasks SET {assignments}, updated_at = ?, version = version + 1 WHERE id = ?",
            (*cleaned.values(), now, task_id),
        )
        audit(
            connection,
            "human.task_updated",
            "local-user",
            "task",
            task_id,
            {"before": {key: old[key] for key in cleaned}, "after": cleaned},
        )
        connection.commit()
    return {"task_id": task_id, "updated": cleaned}


def set_simulated_time(value: str) -> dict[str, Any]:
    normalized = _validated_datetime(str(value), "时间")
    now = utcish_now()
    with connect() as connection:
        init_db(connection)
        connection.execute(
            """
            INSERT INTO settings(key, value, updated_at) VALUES ('simulated_now', ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
            """,
            (normalized, now),
        )
        audit(connection, "tool.simulated_clock", "local-user", "settings", None, {"simulated_now": normalized})
        connection.commit()
    return {"simulated_now": normalized}


def reset_demo() -> dict[str, Any]:
    with connect() as connection:
        init_db(connection)
        # Candidate updates point to tasks while tasks point back to their source
        # candidate, so break the optional side of the cycle before clearing.
        connection.execute("UPDATE candidates SET target_task_id = NULL")
        for table in (
            "decision_votes",
            "decision_options",
            "decision_participants",
            "decision_rooms",
            "audit_events",
            "approvals",
            "clarifications",
            "evidence",
            "tasks",
            "candidates",
            "messages",
            "imports",
        ):
            connection.execute(f"DELETE FROM {table}")
        now = utcish_now()
        connection.execute("UPDATE settings SET value = ?, updated_at = ? WHERE key = 'simulated_now'", (now, now))
        connection.commit()
    return {"reset": True}
