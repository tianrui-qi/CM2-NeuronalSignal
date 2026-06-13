from __future__ import annotations

from pathlib import Path
from typing import Any

from ..cnmfe.quality import (
    ensure_component_quality_metrics,
    profile_rows_from_model,
    write_profile_csv,
    write_profile_json,
)


def build_profile(
    *,
    cnm: Any,
    cache_save_fold: str | Path,
    mmap_load_path: str | Path | None = None,
) -> tuple[list[dict[str, str]], tuple[str, ...], Path]:
    cache_root = Path(cache_save_fold)
    profile_path = cache_root / "profile.csv"
    profile_json_path = cache_root / "profile.json"

    if mmap_load_path is not None:
        ensure_component_quality_metrics(cnm, mmap_load_path)

    rows, metric_keys = profile_rows_from_model(cnm=cnm)

    write_profile_csv(profile_path, rows, metric_keys)
    write_profile_json(profile_json_path, rows, metric_keys)
    return rows, metric_keys, profile_path
