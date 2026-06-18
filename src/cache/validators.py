from __future__ import annotations

import json
from pathlib import Path

from .manifest import CACHE_VERSION, METADATA_FILE_NAME, POINTS_FILE_NAME, TRACE_SOURCE_FILES


def is_file(path: str | Path) -> bool:
    candidate = Path(path)
    return candidate.is_file() and candidate.stat().st_size > 0


def _require_positive_int(metadata: dict, key: str) -> int:
    value = metadata.get(key)
    if not isinstance(value, int) or value <= 0:
        raise ValueError(f"metadata.{key} must be a positive integer")
    return value


def _load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as file:
        payload = json.load(file)
    if not isinstance(payload, dict):
        raise ValueError(f"Cache JSON must be an object: {path}")
    return payload


def _validate_sequence_length(payload: dict, key: str, expected: int, *, context: str) -> None:
    value = payload.get(key)
    if not isinstance(value, list):
        raise ValueError(f"{context}.{key} must be a list")
    if len(value) != expected:
        raise ValueError(f"{context}.{key} length mismatch: got {len(value)}, expected {expected}")


def _validate_points_payload(points: dict, *, neuron_count: int) -> None:
    for key in ("id", "x", "y"):
        _validate_sequence_length(points, key, neuron_count, context="points")

    metrics = points.get("metrics")
    if not isinstance(metrics, dict):
        raise ValueError("points.metrics must be an object")
    for key, values in metrics.items():
        if not isinstance(values, list):
            raise ValueError(f"points.metrics.{key} must be a list")
        if len(values) != neuron_count:
            raise ValueError(
                f"points.metrics.{key} length mismatch: got {len(values)}, expected {neuron_count}"
            )

    trace_stats = points.get("trace_stats")
    if trace_stats is None:
        return
    if not isinstance(trace_stats, dict):
        raise ValueError("points.trace_stats must be an object")
    for source_key, source_stats in trace_stats.items():
        if not isinstance(source_stats, dict):
            raise ValueError(f"points.trace_stats.{source_key} must be an object")
        for stat_key, values in source_stats.items():
            if not isinstance(values, list):
                raise ValueError(f"points.trace_stats.{source_key}.{stat_key} must be a list")
            if len(values) != neuron_count:
                raise ValueError(
                    f"points.trace_stats.{source_key}.{stat_key} length mismatch: "
                    f"got {len(values)}, expected {neuron_count}"
                )


def _validate_trace_file(path: Path, *, source_key: str, neuron_count: int, trace_length: int) -> None:
    if not is_file(path):
        raise FileNotFoundError(f"Missing trace cache for {source_key}: {path}")
    expected_bytes = neuron_count * trace_length * 4
    actual_bytes = path.stat().st_size
    if actual_bytes != expected_bytes:
        raise ValueError(
            f"Trace cache byte size mismatch for {source_key}: "
            f"got {actual_bytes}, expected {expected_bytes}"
        )


def _validate_dff_metadata(metadata: dict, trace_source_keys: set[str]) -> None:
    dff = metadata.get("dff")
    if dff is None:
        return
    if not isinstance(dff, dict):
        raise ValueError("metadata.dff must be an object")
    projection_source = dff.get("projection_source")
    if projection_source is not None and projection_source not in trace_source_keys:
        raise ValueError(f"metadata.dff.projection_source is not a trace source: {projection_source}")
    if "min_baseline_abs" in dff and not isinstance(dff.get("min_baseline_abs"), (int, float)):
        raise ValueError("metadata.dff.min_baseline_abs must be numeric")


def validate_cache(cache_dir: str | Path) -> None:
    root = Path(cache_dir)
    metadata_path = root / METADATA_FILE_NAME
    if not is_file(metadata_path):
        raise FileNotFoundError(f"Missing cache metadata: {metadata_path}")
    metadata = _load_json(metadata_path)
    if metadata.get("cache_version") != CACHE_VERSION:
        raise ValueError(f"Unexpected cache version: {metadata.get('cache_version')}")
    neuron_count = _require_positive_int(metadata, "neuron_count")
    trace_length = _require_positive_int(metadata, "trace_length")
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
    trace_source_keys = set(trace_sources)
    for source_key, filename in TRACE_SOURCE_FILES.items():
        spec = trace_sources.get(source_key)
        if not isinstance(spec, dict):
            raise ValueError(f"Missing trace source metadata: {source_key}")
        if spec.get("file") != filename:
            raise ValueError(f"Trace source file mismatch for {source_key}")
        required.append(root / filename)
        _validate_trace_file(root / filename, source_key=source_key, neuron_count=neuron_count, trace_length=trace_length)
    _validate_dff_metadata(metadata, trace_source_keys)
    missing = [str(path) for path in required if not is_file(path)]
    if missing:
        raise FileNotFoundError(f"Incomplete cache files: {missing}")
    _validate_points_payload(_load_json(root / POINTS_FILE_NAME), neuron_count=neuron_count)
