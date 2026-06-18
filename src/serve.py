from __future__ import annotations

from importlib.resources import files
from pathlib import Path

from flask import Flask, abort, send_file, send_from_directory

from .cache.validators import validate_cache


def create_app(*, web_dir: str | Path, cache_load_fold: str | Path) -> Flask:
    web_root = Path(web_dir).expanduser().resolve()
    cache_root = Path(cache_load_fold).expanduser().resolve()
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
