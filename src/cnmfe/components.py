from __future__ import annotations

from typing import Any

import numpy as np


def component_peak_xy(a_csc: Any, component_index: int, height: int) -> tuple[int, int]:
    start = int(a_csc.indptr[component_index])
    end = int(a_csc.indptr[component_index + 1])
    if end <= start:
        return 0, 0
    data = a_csc.data[start:end]
    indices = a_csc.indices[start:end]
    flat_index = int(indices[int(np.argmax(data))])
    return int(flat_index // height), int(flat_index % height)
