from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np

from .cnmf import baseline_values, fitted_traces, load_cnmf, residual_traces
from ..cache.manifest import TRACE_SOURCE_FILES


def trace_sources(cnm: Any) -> dict[str, np.ndarray]:
    c = fitted_traces(cnm)
    yra = residual_traces(cnm)
    return {
        "c": c,
        "c_plus_yra": c + yra,
    }


def trace_source(cnm: Any, source: str) -> np.ndarray:
    if source == "c_bl":
        c = fitted_traces(cnm)
        bl = baseline_values(cnm)
        return c if bl is None else c - bl[:, None]
    sources = trace_sources(cnm)
    if source not in sources:
        raise KeyError(f"Unknown trace source: {source}")
    return sources[source]


def trace_stats(traces: np.ndarray) -> dict[str, np.ndarray]:
    traces = np.asarray(traces, dtype=np.float32)
    return {
        "mean": np.nanmean(traces, axis=1, dtype=np.float64).astype(np.float32),
        "std": np.nanstd(traces, axis=1, dtype=np.float64).astype(np.float32),
        "p05": np.nanpercentile(traces, 5.0, axis=1).astype(np.float32),
        "p95": np.nanpercentile(traces, 95.0, axis=1).astype(np.float32),
    }


def neuron_trace(model_path: str | Path, neuron_id: int, source: str = "c") -> np.ndarray:
    cnm = load_cnmf(model_path)
    traces = trace_source(cnm, source)
    return np.asarray(traces[int(neuron_id)], dtype=np.float32)
