from __future__ import annotations

from pathlib import Path

import numpy as np
from tqdm import tqdm

from ..cnmfe.components import component_peak_xy
from ..cnmfe.quality import json_float_or_none


def build_points_payload(
    *,
    a_csc,
    height: int,
    n_components: int,
    rows: list[dict[str, str]],
    metric_keys: tuple[str, ...],
) -> dict[str, object]:
    xs = np.zeros(n_components, dtype=np.int32)
    ys = np.zeros(n_components, dtype=np.int32)
    for idx in tqdm(range(n_components), desc="cache(points)", dynamic_ncols=True):
        xs[idx], ys[idx] = component_peak_xy(a_csc, idx, height=height)

    return {
        "id": list(range(n_components)),
        "trace_row": list(range(n_components)),
        "x": xs.astype(int).tolist(),
        "y": ys.astype(int).tolist(),
        "metrics": {
            key: [json_float_or_none(row.get(key)) for row in rows]
            for key in metric_keys
        },
    }


def write_points(path: str | Path, payload: dict[str, object]) -> None:
    import json

    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(payload, separators=(",", ":")), encoding="utf-8")
