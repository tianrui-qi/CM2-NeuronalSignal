from __future__ import annotations

import json
import logging
import math
from pathlib import Path

from ..cnmfe.cnmf import (
    component_count,
    frame_rate_hz,
    load_cnmf,
    model_dims,
    spatial_matrix,
    trace_length,
)
from ..cnmfe.quality import ensure_component_quality_metrics, metric_rows_from_model
from ..cnmfe.traces import trace_sources

from .background_cache import write_background_cache
from .contract import (
    BACKGROUND_DIRNAME,
    DFF_DENOMINATOR_DTYPE,
    DFF_DENOMINATOR_FILE_NAME,
    METADATA_FILE_NAME,
    POINTS_FILE_NAME,
    TEMPORAL_DIRNAME,
    TRACE_SOURCE_FILES,
)
from .contract.spec import (
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
    TIME_COORDINATE,
    TRACE_DTYPE,
    TRACE_LAYOUT,
)
from .dff_cache import (
    DFF_MIN_BASELINE_ABS,
    write_dff_denominator_cache,
)
from .points import build_points_payload, write_points
from .publisher import publish_cache_directory
from .trace_cache import write_trace_cache


def build_cache(
    *,
    mmap_load_path: str | Path,
    cnmfe_load_path: str | Path,
    cache_save_fold: str | Path,
) -> Path:
    model_path = Path(cnmfe_load_path).expanduser().resolve()
    mmap_path = Path(mmap_load_path).expanduser().resolve()
    cache_target = Path(cache_save_fold).expanduser()
    cache_root = cache_target.resolve()

    if not model_path.is_file():
        raise FileNotFoundError(f"Missing CNMF-E model: {model_path}")
    if not mmap_path.is_file():
        raise FileNotFoundError(f"Missing mmap file: {mmap_path}")

    logging.getLogger("caiman").setLevel(logging.WARNING)
    print(f"[cache] loading model {model_path}")
    cnm = load_cnmf(model_path)
    height, width = model_dims(model_path, cnm)
    n_components = component_count(cnm)
    n_frames = trace_length(cnm)
    fr_hz = frame_rate_hz(cnm)
    if not math.isfinite(fr_hz) or fr_hz <= 0:
        raise ValueError(
            f"Cannot build cache with non-positive or non-finite frame rate: {fr_hz}"
        )

    def build_staged_cache(staging_root: Path) -> None:
        (staging_root / BACKGROUND_DIRNAME).mkdir(parents=True)
        (staging_root / TEMPORAL_DIRNAME).mkdir()

        ensure_component_quality_metrics(cnm, mmap_path)
        rows, metric_keys = metric_rows_from_model(cnm=cnm)

        for source_key, traces in trace_sources(cnm).items():
            write_trace_cache(
                staging_root,
                source_key,
                traces,
                expected_shape=(n_components, n_frames),
            )
        write_dff_denominator_cache(
            cnm=cnm,
            mmap_load_path=mmap_path,
            cache_save_fold=staging_root,
            expected_shape=(n_components, n_frames),
        )

        points_payload = build_points_payload(
            a_csc=spatial_matrix(cnm),
            height=height,
            n_components=n_components,
            rows=rows,
            metric_keys=metric_keys,
        )
        write_points(staging_root / POINTS_FILE_NAME, points_payload)

        background_specs = write_background_cache(
            cache_save_fold=staging_root,
            mmap_load_path=mmap_path,
            height=height,
            width=width,
            trace_length=n_frames,
        )

        metadata = {
            "full_height": int(height),
            "full_width": int(width),
            "trace_length": int(n_frames),
            "frame_rate_hz": float(fr_hz),
            "neuron_count": int(n_components),
            "trace_sources": {
                "c": {
                    "file": TRACE_SOURCE_FILES["c"],
                    "dtype": TRACE_DTYPE,
                },
                "c_plus_yra": {
                    "file": TRACE_SOURCE_FILES["c_plus_yra"],
                    "dtype": TRACE_DTYPE,
                },
            },
            "dff": {
                "denominator_file": DFF_DENOMINATOR_FILE_NAME,
                "dtype": DFF_DENOMINATOR_DTYPE,
                "baseline_method": "median",
                "min_baseline_abs": float(DFF_MIN_BASELINE_ABS),
            },
            "backgrounds": background_specs,
            "default_background_key": "bandpass",
            "image": {
                "shape": [int(height), int(width)],
                "axis_order": IMAGE_AXIS_ORDER,
                "origin": IMAGE_ORIGIN,
                "x_direction": IMAGE_X_DIRECTION,
                "y_direction": IMAGE_Y_DIRECTION,
                "coordinate_indexing": COORDINATE_INDEXING,
                "pixel_flatten_order": PIXEL_FLATTEN_ORDER,
            },
            "traces": {
                "shape": [int(n_components), int(n_frames)],
                "layout": TRACE_LAYOUT,
                "dtype": TRACE_DTYPE,
            },
            "time": {
                "coordinate": TIME_COORDINATE,
                "frame_indexing": FRAME_INDEXING,
                "sample_rate_hz": float(fr_hz),
            },
            "selection": {
                "roi_bounds": ROI_BOUNDS,
                "qc_lower": QC_LOWER_BOUND,
                "qc_upper": QC_UPPER_BOUND,
                "region_boundary": REGION_BOUNDARY,
            },
        }
        (staging_root / METADATA_FILE_NAME).write_text(
            json.dumps(metadata, indent=2),
            encoding="utf-8",
        )

    publish_cache_directory(
        cache_target,
        build=build_staged_cache,
        protected_inputs=(model_path, mmap_path),
    )

    print(f"[cache] ready {cache_root}")
    return cache_root
