"""Canonical CM2 viewer-cache wire specification."""

from __future__ import annotations


POINTS_FILE_NAME = "points.json"
METADATA_FILE_NAME = "metadata.json"
BACKGROUND_DIRNAME = "backgrounds"
TRACE_SOURCE_FILES = {
    "c": "traces_c.float32.bin",
    "c_plus_yra": "traces_c_plus_yra.float32.bin",
    "ybg_projection": "traces_ybg_projection.float32.bin",
}

IMAGE_AXIS_ORDER = "YX"
IMAGE_ORIGIN = "top_left"
IMAGE_X_DIRECTION = "right"
IMAGE_Y_DIRECTION = "down"
COORDINATE_INDEXING = "zero_based"
PIXEL_FLATTEN_ORDER = "F"

TRACE_LAYOUT = "component_major"
TRACE_DTYPE = "<f4"

TIME_COORDINATE = "frame"
FRAME_INDEXING = "zero_based"

ROI_BOUNDS = "half_open"
QC_LOWER_BOUND = "inclusive"
QC_UPPER_BOUND = "exclusive"
REGION_BOUNDARY = "inclusive"
