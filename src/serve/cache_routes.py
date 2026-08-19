from __future__ import annotations

from collections.abc import Callable
import json
from pathlib import Path

from flask import Flask, abort, send_from_directory

from ..cache.contract import METADATA_FILE_NAME, POINTS_FILE_NAME


def _declared_cache_files(cache_root: Path) -> frozenset[str]:
    metadata = json.loads(
        (cache_root / METADATA_FILE_NAME).read_text(encoding="utf-8")
    )
    files = {
        METADATA_FILE_NAME,
        POINTS_FILE_NAME,
        metadata["dff"]["denominator_file"],
    }
    files.update(spec["file"] for spec in metadata["trace_sources"].values())
    files.update(spec["file"] for spec in metadata["backgrounds"])
    return frozenset(files)


def register_cache_file_route(*, app: Flask, cache_root: Path) -> None:
    allowed_files = _declared_cache_files(cache_root)

    @app.route("/cache/<path:filename>")
    def cache_file(filename: str):
        if filename not in allowed_files:
            abort(404)
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
