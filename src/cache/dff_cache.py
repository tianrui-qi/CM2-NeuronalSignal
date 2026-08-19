from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
import scipy.sparse
import tqdm

from ..cnmfe.cnmf import fitted_traces, residual_traces, spatial_matrix
from ..cnmfe.ring import COrderMmapRowReader
from ..mmap import parse_encoded_mmap_name
from .contract import (
    DFF_DENOMINATOR_DTYPE,
    DFF_DENOMINATOR_FILE_NAME,
    DFF_MIN_BASELINE_ABS,
)


def _available_memory_bytes() -> int:
    try:
        import psutil

        return int(psutil.virtual_memory().available)
    except Exception:
        return 8 * 1024 * 1024 * 1024


def _max_needed_rows(frames: int) -> int:
    available = _available_memory_bytes()
    target_bytes = min(max(int(available * 0.05), 128 * 1024 * 1024), 512 * 1024 * 1024)
    # Each needed movie row is represented as Y, A*C, and residual during the block.
    return max(256, int(target_bytes // (max(1, int(frames)) * np.dtype(np.float32).itemsize * 3)))


def _initial_active_rows_per_block(frames: int) -> int:
    return max(512, min(4096, _max_needed_rows(frames) // 4))


def _w_rows_with_bounded_neighbors(
    w_csr: scipy.sparse.csr_matrix,
    active_rows: np.ndarray,
    start: int,
    *,
    frames: int,
) -> tuple[int, scipy.sparse.csr_matrix, np.ndarray]:
    max_needed = _max_needed_rows(frames)
    min_rows = 128
    stop = min(len(active_rows), start + _initial_active_rows_per_block(frames))
    while True:
        rows = active_rows[start:stop]
        w_rows = w_csr[rows, :].tocsr()
        needed = np.unique(w_rows.indices)
        if needed.size <= max_needed or len(rows) <= min_rows:
            return stop, w_rows, needed.astype(np.int64, copy=False)
        stop = start + max(min_rows, len(rows) // 2)


def _background_projection(cnm: Any, mmap_load_path: str | Path) -> np.ndarray:
    mmap_path = Path(mmap_load_path).expanduser()
    dims, frames, order = parse_encoded_mmap_name(mmap_path)
    if len(dims) != 2 or order != "C":
        raise ValueError(f"Expected a 2D C-order encoded mmap, got dims={dims}, order={order}: {mmap_path}")

    n_pixels = int(dims[0]) * int(dims[1])
    reader = COrderMmapRowReader(mmap_path, n_pixels=n_pixels, frames=int(frames))
    a_csr = spatial_matrix(cnm).tocsr().astype(np.float32, copy=False)
    if a_csr.shape[0] != n_pixels:
        raise ValueError(f"A/mmap dimension mismatch: A={a_csr.shape}, mmap_pixels={n_pixels}")

    w = getattr(cnm.estimates, "W", None)
    b0 = getattr(cnm.estimates, "b0", None)
    if w is None or b0 is None:
        raise ValueError("CNMF-E model must contain estimates.W and estimates.b0 to build MATLAB-style DF/F cache.")
    w_csr = w.tocsr().astype(np.float32, copy=False)
    b0 = np.asarray(b0, dtype=np.float32).reshape(-1)
    if w_csr.shape != (n_pixels, n_pixels) or b0.size != n_pixels:
        raise ValueError(f"W/b0 dimension mismatch: W={w_csr.shape}, b0={b0.shape}, pixels={n_pixels}")

    c_for_background = fitted_traces(cnm) + residual_traces(cnm)
    n_components = int(c_for_background.shape[0])
    active_rows = np.flatnonzero(np.diff(a_csr.indptr) > 0).astype(np.int64, copy=False)
    norm_sq = np.asarray(a_csr.power(2).sum(axis=0)).reshape(-1).astype(np.float32, copy=False)
    projection = np.zeros((n_components, int(frames)), dtype=np.float32)

    with tqdm.tqdm(total=len(active_rows), desc="cache(dff F0)", unit="px", dynamic_ncols=True) as bar:
        start = 0
        while start < len(active_rows):
            stop, w_rows, needed = _w_rows_with_bounded_neighbors(
                w_csr,
                active_rows,
                start,
                frames=int(frames),
            )
            rows = active_rows[start:stop]
            if needed.size:
                y_needed = reader.read_rows(needed)
                ac_needed = a_csr[needed, :].dot(c_for_background).astype(np.float32, copy=False)
                residual = y_needed - ac_needed
                residual -= b0[needed, None]

                local_indices = np.searchsorted(needed, w_rows.indices).astype(np.int32, copy=False)
                w_local = scipy.sparse.csr_matrix(
                    (w_rows.data, local_indices, w_rows.indptr.copy()),
                    shape=(len(rows), len(needed)),
                )
                background_rows = w_local.dot(residual).astype(np.float32, copy=False)
            else:
                background_rows = np.zeros((len(rows), int(frames)), dtype=np.float32)
            background_rows += b0[rows, None]
            projection += np.asarray(a_csr[rows, :].T.dot(background_rows), dtype=np.float32)
            bar.update(len(rows))
            start = stop

    valid_norm = norm_sq > 0
    projection[valid_norm] /= norm_sq[valid_norm, None]
    projection[~valid_norm] = np.nan
    return projection


def finite_row_medians(projection: np.ndarray) -> np.ndarray:
    """Return JS-equivalent medians of finite float32 values in each row."""

    values = np.asarray(projection, dtype=np.float32)
    if values.ndim != 2:
        raise ValueError(f"DF/F projection must be rank-2: {values.shape}")

    medians = np.full(values.shape[0], np.nan, dtype=np.float64)
    for row_index, row in enumerate(values):
        finite = np.asarray(row[np.isfinite(row)], dtype=np.float32)
        if finite.size == 0:
            continue
        finite.sort()
        middle = int(finite.size // 2)
        if finite.size % 2:
            medians[row_index] = float(finite[middle])
        else:
            medians[row_index] = (
                float(finite[middle - 1]) + float(finite[middle])
            ) / 2.0
    return medians


def write_dff_denominator_cache(
    *,
    cnm: Any,
    mmap_load_path: str | Path,
    cache_save_fold: str | Path,
    expected_shape: tuple[int, int],
) -> None:
    background_projection = _background_projection(cnm, mmap_load_path)
    if background_projection.shape != tuple(expected_shape):
        raise ValueError(
            "DF/F projection shape mismatch: "
            f"got {background_projection.shape}, expected {tuple(expected_shape)}"
        )
    denominators = np.ascontiguousarray(
        finite_row_medians(background_projection),
        dtype=np.dtype(DFF_DENOMINATOR_DTYPE),
    )
    output_path = Path(cache_save_fold) / DFF_DENOMINATOR_FILE_NAME
    output_path.parent.mkdir(parents=True, exist_ok=True)
    denominators.tofile(output_path)
