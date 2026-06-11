from __future__ import annotations

import json
import logging
from pathlib import Path

from .build_cache import (
    BACKGROUND_DIRNAME,
    METADATA_FILE_NAME,
    POINTS_FILE_NAME,
    TRACE_SOURCE_FILES,
    build_cache,
)
from .server import create_app


def _source_signature(path: Path) -> dict[str, object]:
    stat = path.stat()
    return {
        "path": str(path.resolve()),
        "mtime_ns": int(stat.st_mtime_ns),
        "size": int(stat.st_size),
    }


def _optional_file(path: Path | None) -> Path | None:
    if path is None:
        return None
    resolved = path.expanduser().resolve()
    return resolved if resolved.is_file() else None


def _cache_matches_request(
    *,
    y_load_path: Path | None,
    model_load_path: Path,
    bg_load_path: Path | None,
    profile_load_path: Path | None,
    app_fold: Path,
) -> bool:
    metadata_path = app_fold / METADATA_FILE_NAME
    if not metadata_path.is_file():
        return False
    try:
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return False
    if metadata.get("cache_version") != 5:
        return False

    required_paths = [
        app_fold / POINTS_FILE_NAME,
        app_fold / BACKGROUND_DIRNAME / "background.png",
    ]
    trace_sources = metadata.get("trace_sources")
    if not isinstance(trace_sources, dict):
        return False
    for source_key in TRACE_SOURCE_FILES:
        spec = trace_sources.get(source_key)
        if not isinstance(spec, dict):
            return False
        filename = spec.get("file")
        if not isinstance(filename, str) or not filename:
            return False
        required_paths.append(app_fold / filename)
    if not all(path.is_file() and path.stat().st_size > 0 for path in required_paths):
        return False

    sources = metadata.get("sources")
    if not isinstance(sources, dict):
        return False
    if sources.get("model") != _source_signature(model_load_path):
        return False

    optional_sources = {
        "movie": y_load_path,
        "background": bg_load_path,
        "profile": profile_load_path,
    }
    for key, path in optional_sources.items():
        if path is None or key not in sources:
            continue
        if sources[key] != _source_signature(path):
            return False
    return True


def run_app(
    *,
    model_load_path: Path,
    y_load_path: Path | None,
    app_fold: Path,
    bg_load_path: Path | None = None,
    profile_load_path: Path | None = None,
    host: str = "127.0.0.1",
    port: int = 8765,
    debug: bool = False,
    force_rebuild: bool = False,
) -> None:
    logging.basicConfig(level=logging.WARNING, format="%(message)s")

    model_load_path = model_load_path.expanduser().resolve()
    y_load_path = y_load_path.expanduser().resolve() if y_load_path is not None else None
    bg_load_path = _optional_file(bg_load_path)
    profile_load_path = _optional_file(profile_load_path)
    app_fold = app_fold.expanduser().resolve()

    if force_rebuild or not _cache_matches_request(
        y_load_path=y_load_path,
        model_load_path=model_load_path,
        bg_load_path=bg_load_path,
        profile_load_path=profile_load_path,
        app_fold=app_fold,
    ):
        build_cache(
            model_load_path=model_load_path,
            y_load_path=y_load_path,
            app_fold=app_fold,
            bg_load_path=bg_load_path,
            profile_load_path=profile_load_path,
        )

    app = create_app(app_fold)
    app.run(host=host, port=port, debug=debug)
