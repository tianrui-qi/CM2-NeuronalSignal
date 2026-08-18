from __future__ import annotations

import math
from pathlib import Path
from typing import Any

import numpy as np
import scipy.ndimage
import scipy.sparse
import tqdm
from scipy.stats import norm as scipy_norm

from .cnmf import component_count, frame_rate_hz
from ..mmap import load_memmap_movie


METRIC_KEYS = (
    "snr",
    "r_value",
    "bl",
    "lam",
    "neurons_sn",
    "g_0",
    "g_1",
    "t_peak",
    "t_half",
)


def json_float_or_none(value: object) -> float | None:
    try:
        scalar = float(value)
    except (TypeError, ValueError):
        return None
    return scalar if np.isfinite(scalar) else None


def component_float_vector(value: Any, n_components: int) -> np.ndarray:
    if value is None:
        return np.full(n_components, np.nan, dtype=np.float64)
    arr = np.asarray(value, dtype=np.float64)
    if arr.ndim == 0:
        return np.full(n_components, float(arr), dtype=np.float64)
    arr = np.ravel(arr).astype(np.float64, copy=False)
    if arr.shape[0] != n_components:
        raise ValueError(f"Expected component vector of length {n_components}, got {arr.shape}")
    return arr


def component_g_matrix(value: Any, n_components: int) -> np.ndarray:
    if value is None:
        return np.empty((n_components, 0), dtype=np.float64)
    arr = np.asarray(value, dtype=np.float64)
    if arr.ndim == 0:
        return np.full((n_components, 1), float(arr), dtype=np.float64)
    if arr.ndim == 1:
        if arr.shape[0] == n_components:
            return arr.reshape(n_components, 1)
        return np.broadcast_to(arr.reshape(1, -1), (n_components, arr.shape[0])).copy()
    if arr.ndim == 2 and arr.shape[0] == n_components:
        return arr.astype(np.float64, copy=False)
    raise ValueError(f"Unsupported g shape: {arr.shape}")


def _roots_from_g(g0: float, g1: float) -> tuple[float, float]:
    disc = g0 * g0 + 4.0 * g1
    if disc <= 0.0:
        raise ValueError
    root = math.sqrt(disc)
    r1 = 0.5 * (g0 + root)
    r2 = 0.5 * (g0 - root)
    if not (0.0 < r1 < 1.0 and 0.0 < r2 < 1.0):
        raise ValueError
    return r1, r2


def _timing_from_g(g0: float, g1: float, dt_s: float) -> tuple[float, float]:
    r1, r2 = _roots_from_g(g0, g1)
    tau1 = -dt_s / math.log(r1)
    tau2 = -dt_s / math.log(r2)
    tau_fast, tau_slow = min(tau1, tau2), max(tau1, tau2)
    t_peak = tau_fast * tau_slow / (tau_slow - tau_fast) * math.log(tau_slow / tau_fast)

    def kernel(t_s: float) -> float:
        return math.exp(-t_s / tau_slow) - math.exp(-t_s / tau_fast)

    target = 0.5 * kernel(t_peak)
    lo = t_peak
    hi = t_peak + 20.0 * tau_slow
    while kernel(hi) > target:
        hi += 10.0 * tau_slow
        if hi > t_peak + 200.0 * tau_slow:
            raise RuntimeError
    for _ in range(120):
        mid = 0.5 * (lo + hi)
        if kernel(mid) > target:
            lo = mid
        else:
            hi = mid
    return 1000.0 * t_peak, 1000.0 * (0.5 * (lo + hi) - t_peak)


def component_timing_arrays(g_matrix: np.ndarray, dt_s: float) -> tuple[np.ndarray, np.ndarray]:
    n_components = int(g_matrix.shape[0])
    t_peak = np.full(n_components, np.nan, dtype=np.float64)
    t_half = np.full(n_components, np.nan, dtype=np.float64)
    if g_matrix.shape[1] < 2:
        return t_peak, t_half
    for idx in range(n_components):
        g0, g1 = float(g_matrix[idx, 0]), float(g_matrix[idx, 1])
        if not (np.isfinite(g0) and np.isfinite(g1)):
            continue
        try:
            t_peak[idx], t_half[idx] = _timing_from_g(g0, g1, dt_s)
        except Exception:
            pass
    return t_peak, t_half


def optional_component_vector(value: Any, n_components: int) -> np.ndarray | None:
    try:
        arr = np.asarray(value, dtype=np.float64)
    except (TypeError, ValueError):
        return None
    if arr.dtype == object:
        return None
    if arr.ndim == 0:
        if not np.isfinite(float(arr)):
            return None
        return np.full(n_components, float(arr), dtype=np.float64)
    arr = np.ravel(arr).astype(np.float64, copy=False)
    if arr.shape[0] != n_components or not np.any(np.isfinite(arr)):
        return None
    return arr


def component_quality_available(cnm: Any) -> bool:
    n_components = component_count(cnm)
    estimates = cnm.estimates
    return (
        optional_component_vector(getattr(estimates, "SNR_comp", None), n_components) is not None
        and optional_component_vector(getattr(estimates, "r_values", None), n_components) is not None
    )


def _param_value(cnm: Any, group: str, key: str, default: Any) -> Any:
    try:
        value = cnm.params.get(group, key)
        if value is not None:
            return value
    except Exception:
        pass
    try:
        group_value = getattr(cnm.params, group)
        value = group_value.get(key)
        if value is not None:
            return value
    except Exception:
        pass
    return default


def _baseline_removed_traces(traces: np.ndarray) -> np.ndarray:
    values = np.asarray(traces, dtype=np.float32).copy()
    n_components, n_frames = values.shape
    window = int(min(n_frames // 5, 800))
    if window <= 1:
        return values

    missing = int(math.ceil(n_frames / window) * window - n_frames)
    pad_before = int(math.floor(missing / 2.0))
    pad_after = int(math.ceil(missing / 2.0))
    padded = np.pad(values.T, ((pad_before, pad_after), (0, 0)), mode="reflect")
    padded_frames = int(padded.shape[0])
    baseline = np.reshape(padded, (window, padded_frames // window, n_components), order="F")
    baseline = np.percentile(baseline, 8, axis=0)
    baseline = scipy.ndimage.zoom(
        np.asarray(baseline, dtype=np.float32),
        [window, 1],
        order=3,
        mode="constant",
        cval=0.0,
        prefilter=True,
    )
    if pad_after == 0:
        values -= baseline.T
    else:
        values -= baseline[pad_before:-pad_after].T
    return values


def component_snr_values(cnm: Any) -> np.ndarray:
    from caiman.components_evaluation import compute_event_exceptionality

    c = np.asarray(cnm.estimates.C, dtype=np.float32)
    yra = getattr(cnm.estimates, "YrA", None)
    traces = c if yra is None else c + np.asarray(yra, dtype=np.float32)
    traces = _baseline_removed_traces(traces)

    frate = frame_rate_hz(cnm)
    decay_time = float(_param_value(cnm, "data", "decay_time", 1.0))
    n_samples = max(1, int(np.ceil(frate * decay_time)))
    fitness_raw, _, _, _ = compute_event_exceptionality(
        traces,
        robust_std=False,
        N=n_samples,
    )
    snr = -scipy_norm.ppf(np.exp(np.asarray(fitness_raw, dtype=np.float64) / n_samples))
    return np.where(np.isfinite(snr), snr, 0.0).astype(np.float64, copy=False)


def _spatial_overlap_by_component(a_csc: scipy.sparse.csc_matrix) -> tuple[scipy.sparse.csc_matrix, np.ndarray]:
    norms = np.sqrt(np.asarray(a_csc.power(2).sum(axis=0)).reshape(-1))
    overlap = (a_csc.T @ a_csc).tocsc()
    return overlap, norms


def _overlapping_components(
    overlap: scipy.sparse.csc_matrix,
    norms: np.ndarray,
    component_index: int,
    threshold: float,
) -> np.ndarray:
    norm_i = float(norms[component_index])
    if not np.isfinite(norm_i) or norm_i <= 0:
        return np.empty(0, dtype=np.int64)

    column = overlap.getcol(component_index)
    rows = column.indices.astype(np.int64, copy=False)
    values = np.asarray(column.data, dtype=np.float64)
    denom = norms[rows] * norm_i
    valid = denom > 0
    normalized = np.zeros_like(values, dtype=np.float64)
    normalized[valid] = values[valid] / denom[valid]
    keep = (rows != component_index) & (normalized > float(threshold))
    return rows[keep]


def component_r_values(cnm: Any, mmap_load_path: str | Path) -> np.ndarray:
    from caiman.components_evaluation import find_activity_intervals
    from scipy.stats import pearsonr

    yr, dims, _ = load_memmap_movie(mmap_load_path)
    n_components = component_count(cnm)
    if int(yr.shape[0]) != int(np.prod(dims)):
        raise ValueError(f"mmap/model dimension mismatch: mmap={yr.shape}, dims={dims}")

    c = np.asarray(cnm.estimates.C, dtype=np.float32)
    a_csc = cnm.estimates.A.tocsc().astype(np.float32, copy=False)
    if a_csc.shape[1] != n_components:
        raise ValueError(f"A/C component mismatch: A={a_csc.shape}, C={c.shape}")

    frate = frame_rate_hz(cnm)
    t_before = np.minimum(-2, np.floor(-5.0 / 30.0 * frate))
    t_after = np.maximum(5, np.ceil(25.0 / 30.0 * frate))
    loc = find_activity_intervals(c, Npeaks=10, tB=t_before, tA=t_after, thres=0.3)
    overlap, norms = _spatial_overlap_by_component(a_csc)

    r_values = np.zeros(n_components, dtype=np.float64)
    for idx in tqdm.trange(n_components, desc="quality(r_value)", unit="component", dynamic_ncols=True):
        if loc[idx] is None:
            continue

        column = a_csc.getcol(idx)
        positive = np.asarray(column.data > 0).reshape(-1)
        pixels = column.indices[positive].astype(np.int64, copy=False)
        footprint = np.asarray(column.data[positive], dtype=np.float64)
        if pixels.size < 3:
            r_values[idx] = 0.0
            continue

        sample_indexes = set(np.asarray(loc[idx], dtype=int).tolist())
        for neighbor in _overlapping_components(overlap, norms, idx, threshold=0.1):
            if loc[int(neighbor)] is not None:
                sample_indexes.difference_update(np.asarray(loc[int(neighbor)], dtype=int).tolist())
        if not sample_indexes:
            sample_indexes = set(np.asarray(loc[idx], dtype=int).tolist())

        frames = np.fromiter(sample_indexes, dtype=np.int64)
        if frames.size == 0:
            r_values[idx] = 0.0
            continue
        movie_rows = np.asarray(yr[pixels, :], dtype=np.float32)
        movie_rows[np.isnan(movie_rows)] = np.nanmean(movie_rows)
        mean_movie = np.mean(movie_rows[:, frames], axis=1, dtype=np.float64)
        value = float(pearsonr(mean_movie, footprint)[0])
        r_values[idx] = value if np.isfinite(value) else -1.0

    return r_values


def ensure_component_quality_metrics(cnm: Any, mmap_load_path: str | Path) -> bool:
    if component_quality_available(cnm):
        return False
    print("[cache] computing CaImAn component quality metrics: SNR_comp and r_values")
    cnm.estimates.SNR_comp = component_snr_values(cnm)
    cnm.estimates.r_values = component_r_values(cnm, mmap_load_path)
    return True


def metric_rows_from_model(
    *,
    cnm: Any,
) -> tuple[list[dict[str, str]], tuple[str, ...]]:
    n_components = component_count(cnm)
    estimates = cnm.estimates
    g_matrix = component_g_matrix(getattr(estimates, "g", None), n_components)
    t_peak, t_half = component_timing_arrays(g_matrix, dt_s=1.0 / frame_rate_hz(cnm))
    metric_values = {
        "snr": optional_component_vector(getattr(estimates, "SNR_comp", None), n_components),
        "r_value": optional_component_vector(getattr(estimates, "r_values", None), n_components),
        "bl": component_float_vector(getattr(estimates, "bl", None), n_components),
        "lam": component_float_vector(getattr(estimates, "lam", None), n_components),
        "neurons_sn": component_float_vector(getattr(estimates, "neurons_sn", None), n_components),
        "g_0": g_matrix[:, 0] if g_matrix.shape[1] > 0 else np.full(n_components, np.nan, dtype=np.float64),
        "g_1": g_matrix[:, 1] if g_matrix.shape[1] > 1 else np.full(n_components, np.nan, dtype=np.float64),
        "t_peak": t_peak,
        "t_half": t_half,
    }
    metric_keys = tuple(key for key in METRIC_KEYS if metric_values[key] is not None)

    rows: list[dict[str, str]] = []
    for idx in range(n_components):
        rows.append(
            {
                key: str(float(metric_values[key][idx]))
                for key in metric_keys
            }
        )
    return rows, metric_keys
