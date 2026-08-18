from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from flask import Flask, abort, send_from_directory


def register_cache_file_route(*, app: Flask, cache_root: Path) -> None:
    @app.route("/cache/<path:filename>")
    def cache_file(filename: str):
        response = send_from_directory(cache_root, filename)
        response.headers["Cache-Control"] = "no-store"
        return response


def register_health_route(
    *,
    app: Flask,
    cache_root: Path,
    validate_cache_fn: Callable[[Path], None],
) -> None:
    @app.route("/health")
    def health():
        try:
            validate_cache_fn(cache_root)
        except (FileNotFoundError, ValueError) as error:
            abort(503, description=str(error))
        return {"ok": True}
