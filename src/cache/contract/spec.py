"""Canonical CM2-NeuronalSignal viewer-cache wire specification."""

from __future__ import annotations


POINTS_FILE_NAME = "point.json"
METADATA_FILE_NAME = "metadata.json"
BACKGROUND_DIRNAME = "background"
TEMPORAL_DIRNAME = "temporal"
TRACE_SOURCE_FILES = {
    "c": f"{TEMPORAL_DIRNAME}/c.float32",
    "c_plus_yra": f"{TEMPORAL_DIRNAME}/c_plus_yra.float32",
}
DFF_DENOMINATOR_FILE_NAME = f"{TEMPORAL_DIRNAME}/f.float64"
BACKGROUND_SOURCE_FILES = {
    "mean": f"{BACKGROUND_DIRNAME}/mean.uint16",
    "std": f"{BACKGROUND_DIRNAME}/std.uint16",
    "bandpass": f"{BACKGROUND_DIRNAME}/bandpass.uint16",
}

IMAGE_AXIS_ORDER = "YX"
IMAGE_ORIGIN = "top_left"
IMAGE_X_DIRECTION = "right"
IMAGE_Y_DIRECTION = "down"
COORDINATE_INDEXING = "zero_based"
PIXEL_FLATTEN_ORDER = "F"

TRACE_LAYOUT = "component_major"
TRACE_DTYPE = "<f4"
DFF_DENOMINATOR_DTYPE = "<f8"
DFF_MIN_BASELINE_ABS = 1e-6
BACKGROUND_DTYPE = "<u2"
BACKGROUND_LAYOUT = "row_major"

TIME_COORDINATE = "frame"
FRAME_INDEXING = "zero_based"

ROI_BOUNDS = "half_open"
QC_LOWER_BOUND = "inclusive"
QC_UPPER_BOUND = "exclusive"
REGION_BOUNDARY = "inclusive"
