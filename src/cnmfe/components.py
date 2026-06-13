from __future__ import annotations

from typing import Any

import numpy as np
from scipy import ndimage as ndi


def component_peak_xy(a_csc: Any, component_index: int, height: int) -> tuple[int, int]:
    start = int(a_csc.indptr[component_index])
    end = int(a_csc.indptr[component_index + 1])
    if end <= start:
        return 0, 0
    data = a_csc.data[start:end]
    indices = a_csc.indices[start:end]
    flat_index = int(indices[int(np.argmax(data))])
    return int(flat_index // height), int(flat_index % height)


def component_peaks_xy(a_csc: Any, height: int, n_components: int) -> tuple[np.ndarray, np.ndarray]:
    xs = np.zeros(n_components, dtype=np.int32)
    ys = np.zeros(n_components, dtype=np.int32)
    for idx in range(n_components):
        xs[idx], ys[idx] = component_peak_xy(a_csc, idx, height)
    return xs, ys


def component_outline(spatial: Any, height: int) -> tuple[np.ndarray, np.ndarray, int, int]:
    flat_idx = spatial.indices.astype(np.int64, copy=False)
    weights = spatial.data.astype(np.float32, copy=False)
    if flat_idx.size == 0:
        raise ValueError("Component has no spatial support.")
    ys = flat_idx % height
    xs = flat_idx // height
    peak = int(np.argmax(weights))
    peak_y, peak_x = int(ys[peak]), int(xs[peak])
    y_min = int(np.min(ys))
    y_max = int(np.max(ys)) + 1
    x_min = int(np.min(xs))
    x_max = int(np.max(xs)) + 1
    local_y = ys - y_min
    local_x = xs - x_min
    peak_y_local = peak_y - y_min
    peak_x_local = peak_x - x_min
    mask = np.zeros((y_max - y_min, x_max - x_min), dtype=bool)
    mask[local_y, local_x] = weights >= float(np.max(weights)) * 0.2
    if not mask[peak_y_local, peak_x_local]:
        mask[peak_y_local, peak_x_local] = True
    labeled, _ = ndi.label(mask)
    peak_label = int(labeled[peak_y_local, peak_x_local])
    if peak_label > 0:
        mask = labeled == peak_label
    eroded = ndi.binary_erosion(mask, structure=np.ones((3, 3), dtype=bool))
    outline = mask & ~eroded
    if not np.any(outline):
        outline[peak_y_local, peak_x_local] = True
    outline_y, outline_x = np.nonzero(outline)
    return (outline_y + y_min).astype(np.int32), (outline_x + x_min).astype(np.int32), peak_y, peak_x
