from __future__ import annotations

import json
from pathlib import Path
from tempfile import NamedTemporaryFile

from flask import Flask, abort, jsonify, request


def register_ui_state_routes(*, app: Flask, cache_root: Path) -> None:
    cookie_root = cache_root / "cookie"
    ui_state_path = cookie_root / "ui_state.json"

    @app.route("/api/ui-state", methods=["GET"])
    def ui_state_get():
        if not cookie_root.exists() or not ui_state_path.exists():
            response = jsonify({"ok": True, "state": None})
            response.headers["Cache-Control"] = "no-store"
            return response
        try:
            state = json.loads(ui_state_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as error:
            abort(500, description=f"Failed to read viewer state: {error}")
        response = jsonify({"ok": True, "state": state})
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.route("/api/ui-state", methods=["POST", "PUT"])
    def ui_state_put():
        if request.content_length is not None and request.content_length > 2_000_000:
            abort(413, description="Viewer state is too large.")
        payload = request.get_json(silent=True)
        if not isinstance(payload, dict):
            abort(400, description="Viewer state must be a JSON object.")
        try:
            cookie_root.mkdir(parents=True, exist_ok=True)
            with NamedTemporaryFile(
                "w",
                encoding="utf-8",
                dir=cookie_root,
                prefix=".ui_state.",
                suffix=".tmp",
                delete=False,
            ) as handle:
                json.dump(payload, handle, ensure_ascii=False, indent=2, sort_keys=True)
                handle.write("\n")
                tmp_path = Path(handle.name)
            tmp_path.replace(ui_state_path)
        except OSError as error:
            abort(500, description=f"Failed to write viewer state: {error}")
        return {"ok": True}
