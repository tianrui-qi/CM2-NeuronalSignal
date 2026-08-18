from __future__ import annotations

from importlib.resources import files
from pathlib import Path

from flask import Flask, send_file, send_from_directory


def register_static_routes(*, app: Flask, web_root: Path) -> None:
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


def register_vendor_route(*, app: Flask) -> None:
    @app.route("/vendor/plotly.min.js")
    def plotly_vendor():
        path = files("plotly.package_data").joinpath("plotly.min.js")
        return send_file(path, mimetype="application/javascript")
