from __future__ import annotations

import os
import shutil
from pathlib import Path
from typing import Any

import numpy as np
import scipy.sparse
from caiman.source_extraction.cnmf.cnmf import load_CNMF

from ..mmap import parse_encoded_mmap_name
from .ring import (
    COrderMmapRowReader,
    ring_radius_from_init,
    write_ring_model_hdf5,
)
from .resources import resolve_ring_pixel_batch_size


def run(
    mmap_load_path: str | Path,
    cnmfe_load_path: str | Path,
    init: dict[str, Any],
    caiman_temp: str | Path | None = None,
    pixel_batch_size: int | str | None = "auto",
) -> Path:
    mmap_path = Path(mmap_load_path).expanduser()
    hdf5_path = Path(cnmfe_load_path).expanduser()
    dims_raw, frames, order = parse_encoded_mmap_name(mmap_path)
    if len(dims_raw) != 2:
        raise ValueError(f"Expected 2D mmap for CNMF-E, got dims={dims_raw}: {mmap_path}")
    if order != "C":
        raise NotImplementedError(f"Streaming W attach currently expects C-order mmap, got {order}")
    dims = (int(dims_raw[0]), int(dims_raw[1]))
    yr = COrderMmapRowReader(mmap_path, n_pixels=dims[0] * dims[1], frames=frames)
    cnm = load_CNMF(str(hdf5_path), n_processes=1, dview=None)

    a_mat = cnm.estimates.A
    if scipy.sparse.issparse(a_mat):
        a_mat.eliminate_zeros()
        cnm.estimates.A = a_mat.astype(np.float32, copy=False)
    c_for_w = np.asarray(cnm.estimates.C + cnm.estimates.YrA, dtype=np.float32)
    radius = ring_radius_from_init(init)
    ssub = int(init.get("ssub_B", 1))
    batch_decision = resolve_ring_pixel_batch_size(
        pixel_batch_size,
        frames=frames,
        radius=radius,
        ssub=ssub,
    )
    print(
        "[attach_w] computing streaming ring W from saved CNMF-E; "
        f"dims={dims} components={cnm.estimates.A.shape[1]} radius={radius:g} ssub_B={ssub}",
        flush=True,
    )
    print(f"[attach_w] {batch_decision.reason}", flush=True)
    temp_dir = (
        Path(caiman_temp).expanduser()
        if caiman_temp
        else Path(f"{hdf5_path}.temp").expanduser()
    )
    temp_dir.mkdir(parents=True, exist_ok=True)
    tmp_path = temp_dir / f"{hdf5_path.name}.with_w.tmp.hdf5"
    if tmp_path.exists():
        tmp_path.unlink()
    shutil.copy2(hdf5_path, tmp_path)
    nnz, b0_shape = write_ring_model_hdf5(
        tmp_path,
        yr,
        cnm.estimates.A,
        c_for_w,
        dims,
        radius,
        temp_dir=temp_dir,
        ssub=ssub,
        pixel_batch_size=batch_decision.value,
    )
    os.replace(tmp_path, hdf5_path)
    print(
        "[attach_w] saved ring background into "
        f"{hdf5_path}; W_nnz={nnz} b0_shape={b0_shape}",
        flush=True,
    )
    return hdf5_path
