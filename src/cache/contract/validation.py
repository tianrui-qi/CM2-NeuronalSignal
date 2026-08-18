"""Validate the canonical CM2 viewer-cache contract.

This validator owns the Python-side wire-shape checks plus cross-file
equalities, coordinate bounds, trace-row ownership, artifact presence, and
binary byte lengths.
"""

from __future__ import annotations

import json
import math
from pathlib import Path

from .spec import (
    COORDINATE_INDEXING,
    FRAME_INDEXING,
    IMAGE_AXIS_ORDER,
    IMAGE_ORIGIN,
    IMAGE_X_DIRECTION,
    IMAGE_Y_DIRECTION,
    PIXEL_FLATTEN_ORDER,
    QC_LOWER_BOUND,
    QC_UPPER_BOUND,
    REGION_BOUNDARY,
    ROI_BOUNDS,
    METADATA_FILE_NAME,
    POINTS_FILE_NAME,
    TIME_COORDINATE,
    TRACE_DTYPE,
    TRACE_LAYOUT,
    TRACE_SOURCE_FILES,
)


METADATA_KEYS = (
    "full_height",
    "full_width",
    "trace_length",
    "frame_rate_hz",
    "neuron_count",
    "trace_sources",
    "dff",
    "backgrounds",
    "default_background_key",
    "image",
    "traces",
    "time",
    "selection",
)
POINTS_KEYS = ("id", "trace_row", "x", "y", "metrics")
BACKGROUND_KEYS = ("key", "file", "label")
TRACE_SOURCE_KEYS = ("file", "dtype")
DFF_KEYS = ("projection_source", "baseline_method", "min_baseline_abs")


def is_file(path: str | Path) -> bool:
    candidate = Path(path)
    return candidate.is_file() and candidate.stat().st_size > 0


def _artifact_path(root: Path, filename: str, *, context: str) -> Path:
    relative = Path(filename)
    if (
        relative.is_absolute()
        or "\\" in filename
        or any(part in ("", ".", "..") for part in relative.parts)
    ):
        raise ValueError(f"{context} must be a safe relative cache path")
    candidate = root / relative
    resolved_root = root.resolve()
    resolved_candidate = candidate.resolve()
    if resolved_candidate == resolved_root or resolved_root not in resolved_candidate.parents:
        raise ValueError(f"{context} must stay within the cache directory")
    if candidate.is_symlink():
        raise ValueError(f"{context} must not be a symlink")
    return candidate


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
    _require_exact_keys(points, POINTS_KEYS, context="points")
    for key in ("id", "trace_row", "x", "y"):
        _validate_sequence_length(points, key, neuron_count, context="points")

    metrics = points.get("metrics")
    if (
        not isinstance(metrics, dict)
        or not metrics
        or any(not isinstance(key, str) or not key for key in metrics)
    ):
        raise ValueError("points.metrics must be a non-empty object with non-empty string keys")
    for key, values in metrics.items():
        if not isinstance(values, list):
            raise ValueError(f"points.metrics.{key} must be a list")
        if len(values) != neuron_count:
            raise ValueError(
                f"points.metrics.{key} length mismatch: got {len(values)}, expected {neuron_count}"
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


def _require_exact_object(payload: dict, key: str, *, context: str) -> dict:
    value = payload.get(key)
    if not isinstance(value, dict):
        raise ValueError(f"{context}.{key} must be an object")
    return value


def _require_exact_list(payload: dict, key: str, *, context: str) -> list:
    value = payload.get(key)
    if not isinstance(value, list):
        raise ValueError(f"{context}.{key} must be a list")
    return value


def _require_exact_value(payload: dict, key: str, expected: object, *, context: str) -> None:
    value = payload.get(key)
    if value != expected:
        raise ValueError(f"{context}.{key} must be {expected!r}")


def _require_exact_keys(payload: dict, expected: tuple[str, ...], *, context: str) -> None:
    if set(payload) != set(expected):
        raise ValueError(f"{context} must contain exactly {', '.join(expected)}")


def _is_json_integer(value: object) -> bool:
    """Match JavaScript integer semantics after JSON decoding."""

    if isinstance(value, bool):
        return False
    if isinstance(value, int):
        return True
    return isinstance(value, float) and math.isfinite(value) and value.is_integer()


def _require_positive_int(metadata: dict, key: str) -> int:
    value = metadata.get(key)
    if not _is_json_integer(value) or value <= 0:
        raise ValueError(f"metadata.{key} must be a positive integer")
    return int(value)


def _validate_nullable_number_columns(
    payload: object,
    *,
    expected: int,
    context: str,
) -> None:
    if not isinstance(payload, dict):
        raise ValueError(f"{context} must be an object")
    for key, values in payload.items():
        if not isinstance(values, list):
            raise ValueError(f"{context}.{key} must be a list")
        if len(values) != expected:
            raise ValueError(
                f"{context}.{key} length mismatch: got {len(values)}, expected {expected}"
            )
        if any(
            value is not None
            and (
                isinstance(value, bool)
                or not isinstance(value, (int, float))
                or not math.isfinite(float(value))
            )
            for value in values
        ):
            raise ValueError(f"{context}.{key} must contain finite numbers or null")


def _validate_scientific_contract(
    metadata: dict,
    points: dict,
    *,
    neuron_count: int,
    trace_length: int,
) -> None:
    full_height = _require_positive_int(metadata, "full_height")
    full_width = _require_positive_int(metadata, "full_width")

    frame_rate_hz = metadata.get("frame_rate_hz")
    if (
        isinstance(frame_rate_hz, bool)
        or not isinstance(frame_rate_hz, (int, float))
        or not math.isfinite(float(frame_rate_hz))
        or float(frame_rate_hz) <= 0
    ):
        raise ValueError("metadata.frame_rate_hz must be a positive finite number")

    image = _require_exact_object(metadata, "image", context="metadata")
    _require_exact_keys(
        image,
        (
            "shape",
            "axis_order",
            "origin",
            "x_direction",
            "y_direction",
            "coordinate_indexing",
            "pixel_flatten_order",
        ),
        context="metadata.image",
    )
    image_shape = _require_exact_list(image, "shape", context="metadata.image")
    if (
        len(image_shape) != 2
        or any(not _is_json_integer(value) for value in image_shape)
        or image_shape != [full_height, full_width]
    ):
        raise ValueError(
            "metadata.image.shape must match [metadata.full_height, metadata.full_width]"
        )
    _require_exact_value(image, "axis_order", IMAGE_AXIS_ORDER, context="metadata.image")
    _require_exact_value(image, "origin", IMAGE_ORIGIN, context="metadata.image")
    _require_exact_value(image, "x_direction", IMAGE_X_DIRECTION, context="metadata.image")
    _require_exact_value(image, "y_direction", IMAGE_Y_DIRECTION, context="metadata.image")
    _require_exact_value(
        image,
        "coordinate_indexing",
        COORDINATE_INDEXING,
        context="metadata.image",
    )
    _require_exact_value(
        image,
        "pixel_flatten_order",
        PIXEL_FLATTEN_ORDER,
        context="metadata.image",
    )

    traces = _require_exact_object(metadata, "traces", context="metadata")
    _require_exact_keys(
        traces,
        ("shape", "layout", "dtype"),
        context="metadata.traces",
    )
    trace_shape = _require_exact_list(traces, "shape", context="metadata.traces")
    if (
        len(trace_shape) != 2
        or any(not _is_json_integer(value) for value in trace_shape)
        or trace_shape != [neuron_count, trace_length]
    ):
        raise ValueError(
            "metadata.traces.shape must match [metadata.neuron_count, metadata.trace_length]"
        )
    _require_exact_value(traces, "layout", TRACE_LAYOUT, context="metadata.traces")
    _require_exact_value(traces, "dtype", TRACE_DTYPE, context="metadata.traces")

    time = _require_exact_object(metadata, "time", context="metadata")
    _require_exact_keys(
        time,
        ("coordinate", "frame_indexing", "sample_rate_hz"),
        context="metadata.time",
    )
    _require_exact_value(time, "coordinate", TIME_COORDINATE, context="metadata.time")
    _require_exact_value(
        time,
        "frame_indexing",
        FRAME_INDEXING,
        context="metadata.time",
    )
    sample_rate_hz = time.get("sample_rate_hz")
    if (
        isinstance(sample_rate_hz, bool)
        or not isinstance(sample_rate_hz, (int, float))
        or not math.isfinite(float(sample_rate_hz))
        or float(sample_rate_hz) <= 0
    ):
        raise ValueError("metadata.time.sample_rate_hz must be a positive finite number")
    if float(sample_rate_hz) != float(frame_rate_hz):
        raise ValueError("metadata.time.sample_rate_hz must match metadata.frame_rate_hz")

    selection = _require_exact_object(metadata, "selection", context="metadata")
    _require_exact_keys(
        selection,
        ("roi_bounds", "qc_lower", "qc_upper", "region_boundary"),
        context="metadata.selection",
    )
    _require_exact_value(selection, "roi_bounds", ROI_BOUNDS, context="metadata.selection")
    _require_exact_value(selection, "qc_lower", QC_LOWER_BOUND, context="metadata.selection")
    _require_exact_value(selection, "qc_upper", QC_UPPER_BOUND, context="metadata.selection")
    _require_exact_value(
        selection,
        "region_boundary",
        REGION_BOUNDARY,
        context="metadata.selection",
    )

    trace_rows = points.get("trace_row")
    if not isinstance(trace_rows, list):
        raise ValueError("points.trace_row must be a list")
    if len(trace_rows) != neuron_count:
        raise ValueError(
            f"points.trace_row length mismatch: got {len(trace_rows)}, expected {neuron_count}"
        )
    if any(
        not _is_json_integer(value)
        or value < 0
        or value >= neuron_count
        for value in trace_rows
    ):
        raise ValueError(
            "points.trace_row must contain integer rows in [0, metadata.neuron_count)"
        )
    if len(set(trace_rows)) != neuron_count:
        raise ValueError("points.trace_row must be a permutation of all trace rows")

    neuron_ids = points.get("id")
    if any(
        not _is_json_integer(value)
        or not -(2**53 - 1) <= value <= 2**53 - 1
        for value in neuron_ids
    ):
        raise ValueError("points.id must contain safe integers")
    if len(set(neuron_ids)) != neuron_count:
        raise ValueError("points.id must contain unique neuron identifiers")

    for coordinate_key in ("x", "y"):
        coordinates = points[coordinate_key]
        if any(not _is_json_integer(value) for value in coordinates):
            raise ValueError(f"points.{coordinate_key} must contain integer coordinates")
    if any(value < 0 or value >= full_width for value in points["x"]):
        raise ValueError("points.x must stay within zero-based image width")
    if any(value < 0 or value >= full_height for value in points["y"]):
        raise ValueError("points.y must stay within zero-based image height")

    _validate_nullable_number_columns(
        points.get("metrics"),
        expected=neuron_count,
        context="points.metrics",
    )

    dff = _require_exact_object(metadata, "dff", context="metadata")
    _require_exact_keys(dff, DFF_KEYS, context="metadata.dff")
    if dff.get("projection_source") != "ybg_projection":
        raise ValueError("metadata.dff.projection_source must be 'ybg_projection'")
    if dff.get("baseline_method") != "median":
        raise ValueError("metadata.dff.baseline_method must be 'median'")
    min_baseline_abs = dff.get("min_baseline_abs")
    if (
        isinstance(min_baseline_abs, bool)
        or not isinstance(min_baseline_abs, (int, float))
        or not math.isfinite(float(min_baseline_abs))
        or float(min_baseline_abs) <= 0
    ):
        raise ValueError("metadata.dff.min_baseline_abs must be positive and finite")


def _validate_cache_directory(root: Path, metadata: dict) -> None:
    _require_exact_keys(metadata, METADATA_KEYS, context="metadata")
    neuron_count = _require_positive_int(metadata, "neuron_count")
    trace_length = _require_positive_int(metadata, "trace_length")
    required = [_artifact_path(root, POINTS_FILE_NAME, context="points file")]

    backgrounds = metadata.get("backgrounds")
    if not isinstance(backgrounds, list) or not backgrounds:
        raise ValueError("metadata.backgrounds must be a non-empty list")
    background_keys = set()
    for spec in backgrounds:
        if not isinstance(spec, dict):
            raise ValueError("metadata.backgrounds entries must be objects")
        key = spec.get("key")
        filename = spec.get("file")
        label = spec.get("label")
        _require_exact_keys(spec, BACKGROUND_KEYS, context="metadata.backgrounds entry")
        if not isinstance(key, str) or not key:
            raise ValueError("background metadata is missing key")
        if not isinstance(filename, str) or not filename:
            raise ValueError(f"background metadata is missing file: {key}")
        if not isinstance(label, str) or not label:
            raise ValueError(f"background metadata is missing label: {key}")
        if key in background_keys:
            raise ValueError(f"background keys must be unique: {key}")
        background_keys.add(key)
        required.append(
            _artifact_path(
                root,
                filename,
                context=f"metadata.backgrounds[{key}].file",
            )
        )
    default_background_key = metadata.get("default_background_key")
    if default_background_key not in background_keys:
        raise ValueError(f"default background is missing from backgrounds: {default_background_key}")

    trace_sources = metadata.get("trace_sources")
    if not isinstance(trace_sources, dict):
        raise ValueError("metadata.trace_sources must be an object")
    if set(trace_sources) != set(TRACE_SOURCE_FILES):
        raise ValueError(
            "metadata.trace_sources must contain exactly "
            "c, c_plus_yra, and ybg_projection"
        )
    for source_key, filename in TRACE_SOURCE_FILES.items():
        spec = trace_sources.get(source_key)
        if not isinstance(spec, dict):
            raise ValueError(f"Missing trace source metadata: {source_key}")
        _require_exact_keys(
            spec,
            TRACE_SOURCE_KEYS,
            context=f"metadata.trace_sources.{source_key}",
        )
        if spec.get("file") != filename:
            raise ValueError(f"Trace source file mismatch for {source_key}")
        if spec.get("dtype") != TRACE_DTYPE:
            raise ValueError(f"Trace source dtype mismatch for {source_key}")
        trace_path = _artifact_path(
            root,
            filename,
            context=f"metadata.trace_sources.{source_key}.file",
        )
        required.append(trace_path)
        _validate_trace_file(
            trace_path,
            source_key=source_key,
            neuron_count=neuron_count,
            trace_length=trace_length,
        )
    missing = [str(path) for path in required if not is_file(path)]
    if missing:
        raise FileNotFoundError(f"Incomplete cache files: {missing}")
    points = _load_json(_artifact_path(root, POINTS_FILE_NAME, context="points file"))
    _validate_points_payload(points, neuron_count=neuron_count)
    _validate_scientific_contract(
        metadata,
        points,
        neuron_count=neuron_count,
        trace_length=trace_length,
    )


def validate_cache(cache_dir: str | Path) -> None:
    root = Path(cache_dir)
    if root.is_symlink() or not root.is_dir():
        raise ValueError(f"Cache root must be a regular directory: {root}")
    metadata_path = _artifact_path(root, METADATA_FILE_NAME, context="metadata file")
    if not is_file(metadata_path):
        raise FileNotFoundError(f"Missing cache metadata: {metadata_path}")
    metadata = _load_json(metadata_path)
    _validate_cache_directory(root, metadata)
