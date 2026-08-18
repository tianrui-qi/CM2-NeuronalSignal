"""Public boundary for the canonical CM2 viewer-cache contract."""

from __future__ import annotations

from .spec import (
    BACKGROUND_DIRNAME,
    METADATA_FILE_NAME,
    POINTS_FILE_NAME,
    TRACE_SOURCE_FILES,
)
from .validation import validate_cache


__all__ = [
    "BACKGROUND_DIRNAME",
    "METADATA_FILE_NAME",
    "POINTS_FILE_NAME",
    "TRACE_SOURCE_FILES",
    "validate_cache",
]
