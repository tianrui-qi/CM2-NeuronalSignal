from __future__ import annotations

from pathlib import Path

import numpy as np

from .contract import TRACE_SOURCE_FILES


def write_trace_cache(
    cache_save_fold: str | Path,
    source_key: str,
    traces: np.ndarray,
    *,
    expected_shape: tuple[int, int],
) -> None:
    if source_key not in TRACE_SOURCE_FILES:
        raise KeyError(f"Unknown physical trace source: {source_key}")
    root = Path(cache_save_fold)
    root.mkdir(parents=True, exist_ok=True)
    trace_values = np.asarray(traces)
    if trace_values.ndim != 2:
        raise ValueError(
            f"Trace cache must be a rank-2 [component, frame] matrix: "
            f"source={source_key}, shape={trace_values.shape}"
        )
    if trace_values.shape != tuple(expected_shape):
        raise ValueError(
            f"Trace cache shape mismatch for {source_key}: "
            f"got {trace_values.shape}, expected {tuple(expected_shape)}"
        )
    little_endian_values = np.ascontiguousarray(trace_values, dtype=np.dtype("<f4"))
    little_endian_values.tofile(root / TRACE_SOURCE_FILES[source_key])
