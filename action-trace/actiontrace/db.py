from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime
from pathlib import Path
from typing import Any, Iterable
from zoneinfo import ZoneInfo


TZ = ZoneInfo("Asia/Shanghai")
ROOT = Path(__file__).resolve().parent.parent


def utcish_now() -> str:
    """Return an ISO timestamp with the product timezone attached."""
    return datetime.now(TZ).replace(microsecond=0).isoformat()


def database_path() -> Path:
    # Keep the old environment name as a compatibility alias so existing
    # local databases and tests continue to work after the Converge rebrand.
    configured = os.environ.get("CONVERGE_DB_PATH") or os.environ.get("ACTIONTRACE_DB_PATH")
    return Path(configured).expanduser().resolve() if configured else ROOT / "data" / "actiontrace.db"


def connect(path: Path | None = None) -> sqlite3.Connection:
    target = path or database_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(target, timeout=10)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA foreign_keys = ON")
    connection.execute("PRAGMA journal_mode = WAL")
    return connection


SCHEMA = """
CREATE TABLE IF NOT EXISTS imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    filename TEXT NOT NULL,
    source_type TEXT NOT NULL,
    imported_at TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    extractor TEXT NOT NULL DEFAULT 'rules',
    model TEXT,
    latency_ms INTEGER,
    prompt_tokens INTEGER NOT NULL DEFAULT 0,
    completion_tokens INTEGER NOT NULL DEFAULT 0,
    extraction_error TEXT
);

CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
    ordinal INTEGER NOT NULL,
    speaker TEXT NOT NULL,
    sent_at TEXT NOT NULL,
    body TEXT NOT NULL,
    line_start INTEGER NOT NULL,
    line_end INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS candidates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    change_type TEXT NOT NULL DEFAULT 'create',
    title TEXT,
    owner TEXT,
    due_at TEXT,
    status TEXT NOT NULL,
    confidence REAL NOT NULL,
    rule_id TEXT NOT NULL,
    target_task_id INTEGER REFERENCES tasks(id),
    decision_payload TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS evidence (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    field_name TEXT NOT NULL,
    message_id INTEGER REFERENCES messages(id) ON DELETE CASCADE,
    quote TEXT NOT NULL,
    source_type TEXT NOT NULL,
    line_start INTEGER,
    line_end INTEGER
);

CREATE TABLE IF NOT EXISTS clarifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
    field_name TEXT NOT NULL,
    question TEXT NOT NULL,
    answer TEXT,
    resolved INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    resolved_at TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    owner TEXT NOT NULL,
    due_at TEXT NOT NULL,
    status TEXT NOT NULL,
    source_candidate_id INTEGER NOT NULL REFERENCES candidates(id),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approvals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    candidate_id INTEGER NOT NULL REFERENCES candidates(id),
    action TEXT NOT NULL,
    result TEXT NOT NULL,
    actor TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id INTEGER,
    payload TEXT NOT NULL,
    idempotency_key TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS decision_rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    scenario TEXT NOT NULL,
    description TEXT,
    organizer TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'collecting',
    selected_option_id INTEGER,
    action_task_id INTEGER REFERENCES tasks(id),
    source_candidate_id INTEGER REFERENCES candidates(id),
    decision_note TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finalized_at TEXT
);

CREATE TABLE IF NOT EXISTS decision_participants (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES decision_rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    budget_max REAL,
    budget_private INTEGER NOT NULL DEFAULT 0,
    max_distance_km REAL,
    earliest_time TEXT,
    latest_time TEXT,
    required_tags TEXT NOT NULL DEFAULT '[]',
    avoided_tags TEXT NOT NULL DEFAULT '[]',
    preferred_tags TEXT NOT NULL DEFAULT '[]',
    source_note TEXT,
    source_message_id INTEGER REFERENCES messages(id),
    source_line_start INTEGER,
    source_line_end INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(room_id, name)
);

CREATE TABLE IF NOT EXISTS decision_options (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES decision_rooms(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    cost_per_person REAL,
    distance_km REAL,
    available_time TEXT,
    tags TEXT NOT NULL DEFAULT '[]',
    source_note TEXT,
    source_message_id INTEGER REFERENCES messages(id),
    source_line_start INTEGER,
    source_line_end INTEGER,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(room_id, name)
);

CREATE TABLE IF NOT EXISTS decision_votes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id INTEGER NOT NULL REFERENCES decision_rooms(id) ON DELETE CASCADE,
    participant_id INTEGER NOT NULL REFERENCES decision_participants(id) ON DELETE CASCADE,
    option_id INTEGER NOT NULL REFERENCES decision_options(id) ON DELETE CASCADE,
    approved INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(participant_id, option_id)
);

CREATE INDEX IF NOT EXISTS idx_candidates_status ON candidates(status);
CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_events(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_decision_rooms_status ON decision_rooms(status);
CREATE INDEX IF NOT EXISTS idx_decision_participants_room ON decision_participants(room_id);
CREATE INDEX IF NOT EXISTS idx_decision_options_room ON decision_options(room_id);
CREATE INDEX IF NOT EXISTS idx_decision_votes_room ON decision_votes(room_id);
"""


def init_db(connection: sqlite3.Connection) -> None:
    connection.executescript(SCHEMA)
    # Lightweight forward-only migrations keep existing local MVP databases usable.
    _ensure_columns(
        connection,
        "imports",
        {
            "extractor": "TEXT NOT NULL DEFAULT 'rules'",
            "model": "TEXT",
            "latency_ms": "INTEGER",
            "prompt_tokens": "INTEGER NOT NULL DEFAULT 0",
            "completion_tokens": "INTEGER NOT NULL DEFAULT 0",
            "extraction_error": "TEXT",
        },
    )
    _ensure_columns(connection, "candidates", {"decision_payload": "TEXT"})
    _ensure_columns(
        connection,
        "decision_rooms",
        {"source_candidate_id": "INTEGER REFERENCES candidates(id)"},
    )
    evidence_columns = {
        "source_message_id": "INTEGER REFERENCES messages(id)",
        "source_line_start": "INTEGER",
        "source_line_end": "INTEGER",
    }
    _ensure_columns(connection, "decision_participants", evidence_columns)
    _ensure_columns(connection, "decision_options", evidence_columns)
    connection.execute(
        """
        CREATE UNIQUE INDEX IF NOT EXISTS idx_decision_rooms_source_candidate
        ON decision_rooms(source_candidate_id)
        WHERE source_candidate_id IS NOT NULL
        """
    )
    now = utcish_now()
    connection.execute(
        "INSERT OR IGNORE INTO settings(key, value, updated_at) VALUES ('simulated_now', ?, ?)",
        (now, now),
    )
    connection.commit()


def _ensure_columns(connection: sqlite3.Connection, table: str, columns: dict[str, str]) -> None:
    existing = {row["name"] for row in connection.execute(f"PRAGMA table_info({table})")}
    for name, definition in columns.items():
        if name not in existing:
            connection.execute(f"ALTER TABLE {table} ADD COLUMN {name} {definition}")


def row_to_dict(row: sqlite3.Row | None) -> dict[str, Any] | None:
    return dict(row) if row is not None else None


def rows_to_dicts(rows: Iterable[sqlite3.Row]) -> list[dict[str, Any]]:
    return [dict(row) for row in rows]


def audit(
    connection: sqlite3.Connection,
    event_type: str,
    actor: str,
    entity_type: str,
    entity_id: int | None,
    payload: dict[str, Any],
    idempotency_key: str | None = None,
) -> int:
    cursor = connection.execute(
        """
        INSERT INTO audit_events(
            event_type, actor, entity_type, entity_id, payload, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """,
        (
            event_type,
            actor,
            entity_type,
            entity_id,
            json.dumps(payload, ensure_ascii=False, sort_keys=True),
            idempotency_key,
            utcish_now(),
        ),
    )
    return int(cursor.lastrowid)
