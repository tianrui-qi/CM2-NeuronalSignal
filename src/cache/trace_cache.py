from __future__ import annotations

from pathlib import Path

import numpy as np

from ..cnmfe.traces import TRACE_SOURCE_FILES, trace_stats


def write_trace_cache(cache_save_fold: str | Path, source_key: str, traces: np.ndarray) -> dict[str, dict[str, np.ndarray]]:
    if source_key not in TRACE_SOURCE_FILES:
        raise KeyError(f"Unknown physical trace source: {source_key}")
    root = Path(cache_save_fold)
    root.mkdir(parents=True, exist_ok=True)
    traces = np.ascontiguousarray(traces, dtype=np.float32)
    traces.tofile(root / TRACE_SOURCE_FILES[source_key])
    return {source_key: trace_stats(traces)}
