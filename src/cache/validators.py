from __future__ import annotations

import json
from pathlib import Path

from ..cnmfe.traces import TRACE_SOURCE_FILES

from .manifest import CACHE_VERSION, METADATA_FILE_NAME, POINTS_FILE_NAME


def is_file(path: str | Path) -> bool:
    candidate = Path(path)
    return candidate.is_file() and candidate.stat().st_size > 0


def validate_cache(cache_dir: str | Path) -> None:
    root = Path(cache_dir)
    metadata_path = root / METADATA_FILE_NAME
    if not is_file(metadata_path):
        raise FileNotFoundError(f"Missing cache metadata: {metadata_path}")
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    if metadata.get("cache_version") != CACHE_VERSION:
        raise ValueError(f"Unexpected cache version: {metadata.get('cache_version')}")
    required = [root / POINTS_FILE_NAME]

    backgrounds = metadata.get("backgrounds")
    if not isinstance(backgrounds, list) or not backgrounds:
        raise ValueError("metadata.backgrounds must be a non-empty list")
    background_keys = set()
    for spec in backgrounds:
        if not isinstance(spec, dict):
            raise ValueError("metadata.backgrounds entries must be objects")
        key = spec.get("key")
        filename = spec.get("file")
        if not isinstance(key, str) or not key:
            raise ValueError("background metadata is missing key")
        if not isinstance(filename, str) or not filename:
            raise ValueError(f"background metadata is missing file: {key}")
        background_keys.add(key)
        required.append(root / filename)
    default_background_key = metadata.get("default_background_key")
    if default_background_key not in background_keys:
        raise ValueError(f"default background is missing from backgrounds: {default_background_key}")

    trace_sources = metadata.get("trace_sources")
    if not isinstance(trace_sources, dict):
        raise ValueError("metadata.trace_sources must be an object")
    for source_key, filename in TRACE_SOURCE_FILES.items():
        spec = trace_sources.get(source_key)
        if not isinstance(spec, dict):
            raise ValueError(f"Missing trace source metadata: {source_key}")
        if spec.get("file") != filename:
            raise ValueError(f"Trace source file mismatch for {source_key}")
        required.append(root / filename)
    missing = [str(path) for path in required if not is_file(path)]
    if missing:
        raise FileNotFoundError(f"Incomplete cache files: {missing}")
