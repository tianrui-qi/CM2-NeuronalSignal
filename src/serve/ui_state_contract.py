from __future__ import annotations

import math
from collections.abc import Mapping
from typing import Any


_PERSISTED_UI_STATE_KEYS = frozenset(
    {
        "rois",
        "activeRoiId",
        "activeSignalSource",
        "activeTraceValueMode",
        "traceDfSpacingRaw",
        "traceDfPixelsPerKiloRaw",
        "traceDffSpacingPercent",
        "traceDffPixelsPerPercent",
        "heatmapRangeBySource",
        "activeBackgroundKey",
        "backgroundRanges",
        "activeBlueprintMetric",
        "blueprintColorRanges",
        "qcRanges",
        "regionPolygons",
        "openSections",
        "overlayWidth",
    }
)

_WORKFLOW_SECTION_KEYS = frozenset(
    {
        "background",
        "qc",
        "region",
        "roi",
        "temporalHeatmap",
        "temporalTrace",
    }
)

_JS_MAX_SAFE_INTEGER = (1 << 53) - 1


def _is_object(value: Any) -> bool:
    return isinstance(value, Mapping)


def _has_exact_keys(value: Mapping[str, Any], expected: frozenset[str]) -> bool:
    return len(value) == len(expected) and set(value) == expected


def _is_finite_number(value: Any) -> bool:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        return False
    try:
        return math.isfinite(float(value))
    except (OverflowError, ValueError):
        return False


def _is_safe_integer(value: Any) -> bool:
    return (
        _is_finite_number(value)
        and float(value).is_integer()
        and abs(value) <= _JS_MAX_SAFE_INTEGER
    )


def _is_optional_finite_range(value: Any) -> bool:
    if not _is_object(value):
        return False
    keys = set(value)
    return (
        1 <= len(keys) <= 2
        and keys <= {"min", "max"}
        and all(_is_finite_number(value[key]) for key in keys)
    )


def _is_bound_range_map(value: Any, *, nullable: bool) -> bool:
    if not _is_object(value):
        return False
    for metric_key, bounds in value.items():
        if not isinstance(metric_key, str) or not metric_key or not _is_object(bounds):
            return False
        if not _has_exact_keys(bounds, frozenset({"lower", "upper"})):
            return False
        if not all(
            _is_finite_number(bound) or (nullable and bound is None)
            for bound in (bounds["lower"], bounds["upper"])
        ):
            return False
    return True


def _is_background_range_map(value: Any) -> bool:
    if not _is_object(value):
        return False
    for background_key, bounds in value.items():
        if (
            not isinstance(background_key, str)
            or not background_key
            or not _is_object(bounds)
            or not _has_exact_keys(bounds, frozenset({"lower", "upper"}))
            or not _is_safe_integer(bounds["lower"])
            or not _is_safe_integer(bounds["upper"])
            or bounds["lower"] >= bounds["upper"]
        ):
            return False
    return True


def _is_roi_box(value: Any) -> bool:
    if value is None:
        return True
    return (
        _is_object(value)
        and _has_exact_keys(value, frozenset({"x", "y", "width", "height"}))
        and _is_finite_number(value["x"])
        and _is_finite_number(value["y"])
        and _is_finite_number(value["width"])
        and value["width"] > 0
        and _is_finite_number(value["height"])
        and value["height"] > 0
    )


def is_canonical_ui_state(value: Any) -> bool:
    """Return whether *value* is the one accepted persisted UI-state shape."""

    if not _is_object(value) or not _has_exact_keys(value, _PERSISTED_UI_STATE_KEYS):
        return False

    rois = value["rois"]
    if not isinstance(rois, list):
        return False

    roi_ids: set[str] = set()
    neuron_ids: set[int] = set()
    for roi in rois:
        if (
            not _is_object(roi)
            or not _has_exact_keys(
                roi, frozenset({"id", "name", "color", "box", "neuronIds"})
            )
            or not isinstance(roi["id"], str)
            or not roi["id"]
            or roi["id"] in roi_ids
            or not isinstance(roi["name"], str)
            or not roi["name"].strip()
            or not isinstance(roi["color"], str)
            or not roi["color"]
            or not _is_roi_box(roi["box"])
            or not isinstance(roi["neuronIds"], list)
        ):
            return False
        roi_ids.add(roi["id"])
        for neuron_id in roi["neuronIds"]:
            if not _is_safe_integer(neuron_id) or neuron_id in neuron_ids:
                return False
            neuron_ids.add(neuron_id)

    active_roi_id = value["activeRoiId"]
    if active_roi_id is not None and (
        not isinstance(active_roi_id, str) or active_roi_id not in roi_ids
    ):
        return False

    heatmap_ranges = value["heatmapRangeBySource"]
    if not _is_object(heatmap_ranges) or not all(
        isinstance(source_key, str)
        and bool(source_key)
        and _is_optional_finite_range(bounds)
        for source_key, bounds in heatmap_ranges.items()
    ):
        return False

    polygons = value["regionPolygons"]
    if not isinstance(polygons, list):
        return False
    for polygon in polygons:
        if not isinstance(polygon, list) or len(polygon) < 3:
            return False
        if not all(
            _is_object(point)
            and _has_exact_keys(point, frozenset({"x", "y"}))
            and _is_finite_number(point["x"])
            and _is_finite_number(point["y"])
            for point in polygon
        ):
            return False

    open_sections = value["openSections"]
    return (
        isinstance(value["activeSignalSource"], str)
        and value["activeSignalSource"] in {"c_bl", "c_bl_plus_yra"}
        and isinstance(value["activeTraceValueMode"], str)
        and value["activeTraceValueMode"] in {"df", "dff"}
        and _is_finite_number(value["traceDfSpacingRaw"])
        and _is_finite_number(value["traceDfPixelsPerKiloRaw"])
        and _is_finite_number(value["traceDffSpacingPercent"])
        and _is_finite_number(value["traceDffPixelsPerPercent"])
        and isinstance(value["activeBackgroundKey"], str)
        and bool(value["activeBackgroundKey"])
        and _is_background_range_map(value["backgroundRanges"])
        and isinstance(value["activeBlueprintMetric"], str)
        and bool(value["activeBlueprintMetric"])
        and _is_bound_range_map(value["blueprintColorRanges"], nullable=False)
        and _is_bound_range_map(value["qcRanges"], nullable=True)
        and _is_object(open_sections)
        and _has_exact_keys(open_sections, _WORKFLOW_SECTION_KEYS)
        and all(isinstance(open_sections[key], bool) for key in _WORKFLOW_SECTION_KEYS)
        and (
            value["overlayWidth"] is None
            or _is_finite_number(value["overlayWidth"])
        )
    )


def validate_ui_state(value: Any) -> None:
    """Raise a concise error when *value* is not a canonical UI state."""

    if not is_canonical_ui_state(value):
        raise ValueError("Viewer state does not match the canonical UI-state contract.")


__all__ = ["is_canonical_ui_state", "validate_ui_state"]
