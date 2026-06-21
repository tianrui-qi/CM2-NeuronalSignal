from __future__ import annotations

from importlib.resources import files
from pathlib import Path

import json
from tempfile import NamedTemporaryFile

from flask import Flask, abort, jsonify, request, send_file, send_from_directory

from .cache.validators import validate_cache


def create_app(*, web_dir: str | Path, cache_load_fold: str | Path) -> Flask:
    web_root = Path(web_dir).expanduser().resolve()
    cache_root = Path(cache_load_fold).expanduser().resolve()
    cookie_root = cache_root / "cookie"
    ui_state_path = cookie_root / "ui_state.json"
    app = Flask(__name__, static_folder=None)

    @app.route("/")
    def index():
        return send_from_directory(web_root, "index.html")

    @app.route("/app.js")
    def app_js():
        return send_from_directory(web_root, "app.js")

    @app.route("/styles.css")
    def styles_css():
        return send_from_directory(web_root, "styles.css")

    @app.route("/js/<path:filename>")
    def js_file(filename: str):
        return send_from_directory(web_root / "js", filename)

    @app.route("/css/<path:filename>")
    def css_file(filename: str):
        return send_from_directory(web_root / "css", filename)

    @app.route("/assets/<path:filename>")
    def asset_file(filename: str):
        return send_from_directory(web_root / "assets", filename)

    @app.route("/cache/<path:filename>")
    def cache_file(filename: str):
        response = send_from_directory(cache_root, filename)
        response.headers["Cache-Control"] = "no-store"
        return response

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

    @app.route("/vendor/plotly.min.js")
    def plotly_vendor():
        path = files("plotly.package_data").joinpath("plotly.min.js")
        return send_file(path, mimetype="application/javascript")

    @app.route("/health")
    def health():
        try:
            validate_cache(cache_root)
        except (FileNotFoundError, ValueError) as error:
            abort(503, description=str(error))
        return {"ok": True}

    return app


def serve(
    *,
    web_dir: str | Path,
    cache_load_fold: str | Path,
    host: str = "127.0.0.1",
    port: int = 8765,
    debug: bool = False,
) -> None:
    cache_root = Path(cache_load_fold).expanduser().resolve()
    validate_cache(cache_root)
    app = create_app(web_dir=web_dir, cache_load_fold=cache_root)
    app.run(host=host, port=port, debug=debug)
