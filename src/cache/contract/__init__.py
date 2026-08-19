"""Public boundary for the canonical CM2-NeuronalSignal viewer-cache contract."""

from __future__ import annotations

from .spec import (
    BACKGROUND_DTYPE,
    BACKGROUND_DIRNAME,
    BACKGROUND_LAYOUT,
    BACKGROUND_SOURCE_FILES,
    DFF_DENOMINATOR_DTYPE,
    DFF_DENOMINATOR_FILE_NAME,
    DFF_MIN_BASELINE_ABS,
    METADATA_FILE_NAME,
    POINTS_FILE_NAME,
    TEMPORAL_DIRNAME,
    TRACE_SOURCE_FILES,
)
from .validation import validate_cache


__all__ = [
    "BACKGROUND_DTYPE",
    "BACKGROUND_DIRNAME",
    "BACKGROUND_LAYOUT",
    "BACKGROUND_SOURCE_FILES",
    "DFF_DENOMINATOR_DTYPE",
    "DFF_DENOMINATOR_FILE_NAME",
    "DFF_MIN_BASELINE_ABS",
    "METADATA_FILE_NAME",
    "POINTS_FILE_NAME",
    "TEMPORAL_DIRNAME",
    "TRACE_SOURCE_FILES",
    "validate_cache",
]
