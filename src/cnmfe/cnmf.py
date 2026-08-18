from __future__ import annotations

from contextlib import contextmanager, redirect_stderr, redirect_stdout
import os
from pathlib import Path
from typing import Any

import h5py
import numpy as np


@contextmanager
def silence_stdio():
    with open(os.devnull, "w", encoding="utf-8") as devnull:
        with redirect_stdout(devnull), redirect_stderr(devnull):
            yield


def load_cnmf(model_path: str | Path, *, quiet: bool = True) -> Any:
    from caiman.source_extraction.cnmf.cnmf import load_CNMF

    path = Path(model_path).expanduser().resolve()
    if quiet:
        with silence_stdio():
            return load_CNMF(str(path), n_processes=1, dview=None)
    return load_CNMF(str(path), n_processes=1, dview=None)


def model_dims(model_path: str | Path, cnm: Any) -> tuple[int, int]:
    dims = getattr(cnm.estimates, "dims", None)
    if dims is None:
        dims = cnm.params.data.get("dims")
    if dims is None:
        with h5py.File(Path(model_path), "r") as handle:
            if "dims" in handle:
                dims = handle["dims"][()]
            elif "params" in handle and "data" in handle["params"] and "dims" in handle["params"]["data"]:
                dims = handle["params"]["data"]["dims"][()]
    if dims is None:
        raise ValueError(f"Cannot infer model dimensions from {model_path}")
    values = tuple(int(x) for x in np.asarray(dims).reshape(-1).tolist())
    if len(values) < 2:
        raise ValueError(f"Expected at least 2 model dimensions, got {values}")
    return int(values[0]), int(values[1])


def frame_rate_hz(cnm: Any) -> float:
    for getter in (
        lambda: cnm.params.get("data", "fr"),
        lambda: cnm.params.data.get("fr"),
    ):
        try:
            value = getter()
            if value is not None:
                return float(value)
        except Exception:
            pass
    return 1.0


def component_count(cnm: Any) -> int:
    return int(cnm.estimates.C.shape[0])


def trace_length(cnm: Any) -> int:
    return int(cnm.estimates.C.shape[1])


def spatial_matrix(cnm: Any) -> Any:
    return cnm.estimates.A.tocsc()


def fitted_traces(cnm: Any) -> np.ndarray:
    return np.asarray(cnm.estimates.C, dtype=np.float32)


def residual_traces(cnm: Any) -> np.ndarray:
    c = fitted_traces(cnm)
    yra = getattr(cnm.estimates, "YrA", None)
    if yra is None:
        return np.zeros_like(c, dtype=np.float32)
    yra = np.asarray(yra, dtype=np.float32)
    if yra.shape != c.shape:
        raise ValueError(f"YrA/C shape mismatch: YrA={yra.shape}, C={c.shape}")
    return yra
