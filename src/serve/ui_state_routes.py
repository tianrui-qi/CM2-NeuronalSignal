from __future__ import annotations

import json
import os
import secrets
from pathlib import Path
from tempfile import NamedTemporaryFile
from threading import Lock
from typing import Any

from flask import Flask, abort, jsonify, request

from .ui_state_contract import validate_ui_state


_MAX_UI_STATE_BYTES = 2_000_000
_JS_MAX_SAFE_INTEGER = (1 << 53) - 1


def _positive_query_integer(name: str) -> int:
    values = request.args.getlist(name)
    if len(values) != 1:
        abort(400, description=f"Exactly one {name} query value is required.")
    try:
        value = int(values[0], 10)
    except (TypeError, ValueError):
        abort(400, description=f"{name} must be a positive integer.")
    if value < 1 or value > _JS_MAX_SAFE_INTEGER:
        abort(400, description=f"{name} must be a positive safe integer.")
    return value


def _read_default_state(serve_path: Path) -> dict[str, Any] | None:
    try:
        if not serve_path.exists():
            return None
        if not serve_path.is_file():
            raise ValueError(f"Default profile path is not a file: {serve_path}")
        if serve_path.stat().st_size > _MAX_UI_STATE_BYTES:
            raise ValueError(f"Default profile is too large: {serve_path}")
        state = json.loads(serve_path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        raise ValueError(
            f"Failed to read default profile {serve_path}: {error}"
        ) from error
    validate_ui_state(state)
    return state


def _write_default_state(*, serve_path: Path, state: dict[str, Any]) -> None:
    serve_root = serve_path.parent
    tmp_path: Path | None = None
    try:
        serve_root.mkdir(parents=True, exist_ok=True)
        with NamedTemporaryFile(
            "w",
            encoding="utf-8",
            dir=serve_root,
            prefix=f".{serve_path.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            json.dump(state, handle, ensure_ascii=False, indent=2, sort_keys=True)
            handle.write("\n")
            handle.flush()
            os.fsync(handle.fileno())
            tmp_path = Path(handle.name)
        tmp_path.replace(serve_path)
    except OSError:
        if tmp_path is not None:
            try:
                tmp_path.unlink(missing_ok=True)
            except OSError:
                pass
        raise


def register_ui_state_routes(
    *,
    app: Flask,
    serve_path: Path,
    edit_default: bool,
) -> None:
    mode = "edit_default" if edit_default else "browser"
    storage_key = serve_path.stem
    write_lock = Lock()
    active_write_epoch: int | None = None
    last_write_revision = 0

    # Reject malformed tracked defaults at startup instead of letting each
    # browser silently fall back to a fresh viewer.
    _read_default_state(serve_path)

    @app.route("/api/ui-state", methods=["GET"])
    def ui_state_get():
        nonlocal active_write_epoch, last_write_revision
        try:
            with write_lock:
                default_state = _read_default_state(serve_path)
                if edit_default:
                    next_epoch = active_write_epoch
                    while next_epoch == active_write_epoch:
                        next_epoch = secrets.randbelow(_JS_MAX_SAFE_INTEGER) + 1
                    active_write_epoch = next_epoch
                    last_write_revision = 0
                    write_epoch = active_write_epoch
                else:
                    write_epoch = None
        except ValueError as error:
            abort(500, description=str(error))
        response = jsonify(
            {
                "ok": True,
                "mode": mode,
                "storageKey": storage_key,
                "defaultState": default_state,
                "writeEpoch": write_epoch,
            }
        )
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.route("/api/ui-state", methods=["POST", "PUT"])
    def ui_state_put():
        nonlocal last_write_revision
        if not edit_default:
            abort(405, description="Default-profile writes require edit_default=true.")
        write_epoch = _positive_query_integer("write_epoch")
        write_revision = _positive_query_integer("write_revision")
        if (
            request.content_length is not None
            and request.content_length > _MAX_UI_STATE_BYTES
        ):
            abort(413, description="Viewer state is too large.")
        payload = request.get_json(silent=True)
        try:
            validate_ui_state(payload)
        except ValueError as error:
            abort(400, description=str(error))
        with write_lock:
            if write_epoch != active_write_epoch:
                if request.method == "POST":
                    return {"ok": True, "ignored": True}
                abort(409, description="Another edit-default page owns this profile.")
            if write_revision <= last_write_revision:
                return {"ok": True, "ignored": True}
            try:
                _write_default_state(serve_path=serve_path, state=payload)
            except OSError as error:
                abort(500, description=f"Failed to write default profile: {error}")
            last_write_revision = write_revision
        return {"ok": True}


__all__ = ["register_ui_state_routes"]
