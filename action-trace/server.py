from __future__ import annotations

import argparse
import json
import mimetypes
import re
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from actiontrace.config import load_local_env
from actiontrace.decisions import (
    DecisionConflictError,
    DecisionNotFoundError,
    add_decision_option,
    add_decision_participant,
    analyze_decision_room,
    cast_decision_votes,
    create_decision_room,
    finalize_decision_room,
    promote_decision_candidate,
    seed_decision_demo,
)
from actiontrace.service import (
    ConflictError,
    NotFoundError,
    approve_candidate,
    bootstrap,
    clarify_candidate,
    export_tasks_ics,
    generate_report,
    get_state,
    import_conversation,
    reject_candidate,
    reset_demo,
    set_simulated_time,
    update_task,
)
from actiontrace.providers import ProviderError, provider_status


ROOT = Path(__file__).resolve().parent
STATIC_ROOT = ROOT / "static"
MAX_BODY = 6 * 1024 * 1024


def _required_positive_int(data: dict, field: str, label: str) -> int:
    value = data.get(field)
    if isinstance(value, bool):
        raise ValueError(f"{label}无效")
    try:
        parsed = int(value)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"{label}无效") from exc
    if parsed <= 0:
        raise ValueError(f"{label}无效")
    return parsed


class ConvergeHandler(BaseHTTPRequestHandler):
    server_version = "Converge/0.5"

    def log_message(self, fmt: str, *args: object) -> None:
        print(f"[Converge] {self.address_string()} - {fmt % args}")

    def _json(self, payload: object, status: int = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_json(self) -> dict:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError as exc:
            raise ValueError("Content-Length 无效") from exc
        if length <= 0 or length > MAX_BODY:
            raise ValueError("请求正文为空或超过 6 MB")
        raw = self.rfile.read(length)
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise ValueError("请求必须是 UTF-8 JSON") from exc
        if not isinstance(data, dict):
            raise ValueError("请求 JSON 顶层必须是对象")
        return data

    def _download(self, body: bytes, content_type: str, filename: str) -> None:
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        parsed_url = urlparse(self.path)
        path = parsed_url.path
        try:
            if path == "/api/health":
                status = provider_status()
                self._json(
                    {
                        "ok": True,
                        "service": "converge",
                        "version": "0.5.0",
                        "provider": {
                            "configured": status["configured"],
                            "mode": status["mode"],
                            "model": status["model"],
                        },
                    }
                )
            elif path == "/api/state":
                self._json(get_state())
            elif path == "/api/report":
                scope = parse_qs(parsed_url.query).get("scope", ["daily"])[0]
                self._json(generate_report(scope))
            elif path == "/api/export/tasks.ics":
                self._download(
                    export_tasks_ics().encode("utf-8"),
                    "text/calendar; charset=utf-8",
                    "converge-tasks.ics",
                )
            else:
                self._serve_static(path)
        except Exception as exc:  # Last-resort boundary for the local server.
            self._handle_error(exc)

    def do_POST(self) -> None:  # noqa: N802
        path = urlparse(self.path).path
        try:
            data = self._read_json()
            if path == "/api/import":
                result = import_conversation(
                    str(data.get("filename", "")),
                    str(data.get("content", "")),
                    str(data.get("extractor", "auto")),
                )
                self._json(result, HTTPStatus.CREATED)
                return
            if path == "/api/time":
                self._json(set_simulated_time(str(data.get("now", ""))))
                return
            if path == "/api/reset":
                self._json(reset_demo())
                return
            if path == "/api/decision-rooms/demo":
                self._json(seed_decision_demo(), HTTPStatus.CREATED)
                return
            if path == "/api/decision-rooms":
                self._json(create_decision_room(data), HTTPStatus.CREATED)
                return

            decision_match = re.fullmatch(
                r"/api/decision-rooms/(\d+)/(participants|options|analyze|votes|finalize)", path
            )
            if decision_match:
                room_id = int(decision_match.group(1))
                action = decision_match.group(2)
                if action == "participants":
                    self._json(add_decision_participant(room_id, data), HTTPStatus.CREATED)
                elif action == "options":
                    self._json(add_decision_option(room_id, data), HTTPStatus.CREATED)
                elif action == "analyze":
                    self._json(analyze_decision_room(room_id))
                elif action == "votes":
                    self._json(
                        cast_decision_votes(
                            room_id,
                            _required_positive_int(data, "participant_id", "参与者 ID"),
                            data.get("option_ids", []),
                        )
                    )
                else:
                    self._json(
                        finalize_decision_room(
                            room_id,
                            _required_positive_int(data, "option_id", "方案 ID"),
                            data.get("action_title"),
                            data.get("action_owner"),
                            data.get("action_due_at"),
                            data.get("decision_note"),
                            data.get("idempotency_key"),
                        )
                    )
                return

            match = re.fullmatch(r"/api/candidates/(\d+)/(clarify|approve|reject|continue-deliberation)", path)
            if match:
                candidate_id = int(match.group(1))
                action = match.group(2)
                if action == "clarify":
                    self._json(clarify_candidate(candidate_id, data.get("updates", {})))
                elif action == "approve":
                    self._json(
                        approve_candidate(candidate_id, data.get("edits", {}), data.get("idempotency_key"))
                    )
                elif action == "reject":
                    self._json(reject_candidate(candidate_id, data.get("idempotency_key")))
                else:
                    self._json(
                        promote_decision_candidate(
                            candidate_id,
                            data,
                            data.get("idempotency_key"),
                        ),
                        HTTPStatus.CREATED,
                    )
                return

            match = re.fullmatch(r"/api/tasks/(\d+)", path)
            if match:
                self._json(update_task(int(match.group(1)), data.get("updates", {})))
                return
            self._json({"error": "接口不存在"}, HTTPStatus.NOT_FOUND)
        except Exception as exc:
            self._handle_error(exc)

    def _serve_static(self, request_path: str) -> None:
        relative = request_path.lstrip("/") or "index.html"
        target = (STATIC_ROOT / relative).resolve()
        if STATIC_ROOT.resolve() not in target.parents and target != STATIC_ROOT.resolve():
            self._json({"error": "路径无效"}, HTTPStatus.BAD_REQUEST)
            return
        if not target.is_file():
            target = STATIC_ROOT / "index.html"
        body = target.read_bytes()
        mime = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", f"{mime}; charset=utf-8" if mime.startswith("text/") else mime)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def _handle_error(self, exc: Exception) -> None:
        if isinstance(exc, ValueError):
            status = HTTPStatus.BAD_REQUEST
        elif isinstance(exc, (ConflictError, DecisionConflictError)):
            status = HTTPStatus.CONFLICT
        elif isinstance(exc, (NotFoundError, DecisionNotFoundError)):
            status = HTTPStatus.NOT_FOUND
        elif isinstance(exc, ProviderError):
            status = HTTPStatus.BAD_GATEWAY
        else:
            status = HTTPStatus.INTERNAL_SERVER_ERROR
            print(f"[Converge] unhandled error: {exc!r}")
        self._json({"error": str(exc) or "服务暂时不可用"}, status)


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the Converge local MVP")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()
    load_local_env()
    bootstrap()
    server = ThreadingHTTPServer((args.host, args.port), ConvergeHandler)
    print(f"Converge is running at http://{args.host}:{args.port}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nConverge stopped")
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
