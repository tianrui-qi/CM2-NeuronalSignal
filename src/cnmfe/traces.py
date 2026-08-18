from __future__ import annotations

from typing import Any

import numpy as np

from .cnmf import fitted_traces, residual_traces


def trace_sources(cnm: Any) -> dict[str, np.ndarray]:
    c = fitted_traces(cnm)
    yra = residual_traces(cnm)
    return {
        "c": c,
        "c_plus_yra": c + yra,
    }
