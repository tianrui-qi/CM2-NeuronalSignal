from __future__ import annotations

import json
import logging
import shutil
from pathlib import Path

from ..cnmfe.cnmf import (
    component_count,
    frame_rate_hz,
    load_cnmf,
    model_dims,
    spatial_matrix,
    trace_length,
)
from ..cnmfe.traces import TRACE_SOURCE_FILES, trace_sources

from .background_cache import write_background_cache
from .dff_cache import DFF_MIN_BASELINE_ABS, YBG_PROJECTION_SOURCE_KEY, write_ybg_projection_trace_cache
from .manifest import BACKGROUND_DIRNAME, CACHE_VERSION, METADATA_FILE_NAME, POINTS_FILE_NAME, source_signature
from .points import build_points_payload, write_points
from .profile import build_profile
from .trace_cache import write_trace_cache
from .validators import validate_cache


def build_cache(
    *,
    mmap_load_path: str | Path,
    cnmfe_load_path: str | Path,
    cache_save_fold: str | Path,
) -> Path:
    model_path = Path(cnmfe_load_path).expanduser().resolve()
    mmap_path = Path(mmap_load_path).expanduser().resolve()
    cache_root = Path(cache_save_fold).expanduser().resolve()

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

    if cache_root.exists():
        shutil.rmtree(cache_root)
    cache_root.mkdir(parents=True)
    (cache_root / BACKGROUND_DIRNAME).mkdir(parents=True)

    rows, metric_keys, _ = build_profile(
        cnm=cnm,
        cache_save_fold=cache_root,
        mmap_load_path=mmap_path,
    )

    trace_stats_by_source = {}
    for source_key, traces in trace_sources(cnm).items():
        trace_stats_by_source.update(write_trace_cache(cache_root, source_key, traces))
    trace_stats_by_source.update(
        write_ybg_projection_trace_cache(
            cnm=cnm,
            mmap_load_path=mmap_path,
            cache_save_fold=cache_root,
        )
    )

    points_payload = build_points_payload(
        a_csc=spatial_matrix(cnm),
        height=height,
        n_components=n_components,
        rows=rows,
        metric_keys=metric_keys,
        trace_stats_by_source=trace_stats_by_source,
    )
    write_points(cache_root / POINTS_FILE_NAME, points_payload)

    background_specs = write_background_cache(
        cache_save_fold=cache_root,
        mmap_load_path=mmap_path,
        height=height,
        width=width,
        trace_length=n_frames,
    )

    sources = {
        "model": source_signature(model_path),
        "mmap": source_signature(mmap_path),
    }

    metadata = {
        "cache_version": CACHE_VERSION,
        "full_height": int(height),
        "full_width": int(width),
        "trace_length": int(n_frames),
        "frame_rate_hz": float(fr_hz),
        "neuron_count": int(n_components),
        "metric_keys": list(metric_keys),
        "trace_sources": {
            "c": {
                "file": TRACE_SOURCE_FILES["c"],
                "label": "C",
                "description": "CNMF-E fitted temporal trace",
                "dtype": "float32",
            },
            "c_plus_yra": {
                "file": TRACE_SOURCE_FILES["c_plus_yra"],
                "label": "C + YrA",
                "description": "CNMF-E fitted temporal trace plus YrA residual",
                "dtype": "float32",
            },
            YBG_PROJECTION_SOURCE_KEY: {
                "file": TRACE_SOURCE_FILES[YBG_PROJECTION_SOURCE_KEY],
                "label": "projected Ybg",
                "description": "CNMF-E ring background projected into each neuron's trace space",
                "dtype": "float32",
            },
        },
        "dff": {
            "projection_source": YBG_PROJECTION_SOURCE_KEY,
            "baseline_method": "median",
            "min_baseline_abs": float(DFF_MIN_BASELINE_ABS),
            "description": "DF/F is computed in the browser with MATLAB CNMF-E style: C - bl or C - bl + YrA divided by the median of projected Ybg.",
        },
        "points_file": POINTS_FILE_NAME,
        "backgrounds": background_specs,
        "default_background_key": "bandpass",
        "sources": sources,
    }
    (cache_root / METADATA_FILE_NAME).write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    validate_cache(cache_root)

    print(f"[cache] ready {cache_root}")
    return cache_root
