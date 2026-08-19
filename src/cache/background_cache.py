from __future__ import annotations

import math
from pathlib import Path

import numpy as np

from ..cnmfe.background import imagej_bandpass, mean_std_projection_from_mmap
from .contract import (
    BACKGROUND_DIRNAME,
    BACKGROUND_DTYPE,
    BACKGROUND_LAYOUT,
    BACKGROUND_SOURCE_FILES,
)


_UINT16_MAX = int(np.iinfo(np.uint16).max)
_AUTO_SATURATED_PERCENT = 0.35


def _nearest_integer(value: float) -> int:
    """Match JavaScript ``Math.round`` for finite values."""

    return int(math.floor(float(value) + 0.5))


def _integer_ranges(
    *,
    finite_min: float,
    finite_max: float,
    auto_lower: float,
    auto_upper: float,
) -> tuple[dict[str, int], dict[str, int]]:
    range_lower = int(math.floor(finite_min))
    range_upper = int(math.ceil(finite_max))
    if range_upper <= range_lower:
        range_upper = range_lower + 1

    lower = min(max(_nearest_integer(auto_lower), range_lower), range_upper)
    upper = min(max(_nearest_integer(auto_upper), range_lower), range_upper)
    if upper <= lower:
        if lower < range_upper:
            upper = lower + 1
        else:
            lower = upper - 1

    return (
        {"lower": range_lower, "upper": range_upper},
        {"lower": lower, "upper": upper},
    )


def _auto_contrast_limits(
    finite_values: np.ndarray,
    *,
    finite_min: float,
    finite_max: float,
) -> tuple[float, float]:
    lower, upper = np.percentile(
        finite_values,
        [_AUTO_SATURATED_PERCENT, 100.0 - _AUTO_SATURATED_PERCENT],
    )
    lower = float(lower)
    upper = float(upper)
    if not math.isfinite(lower) or not math.isfinite(upper) or upper <= lower:
        lower = finite_min
        upper = finite_max
    return lower, upper


def _write_background_binary(
    *,
    root: Path,
    image: np.ndarray,
    key: str,
    label: str,
) -> dict[str, object]:
    values = np.asarray(image, dtype=np.float32)
    if values.ndim != 2:
        raise ValueError(f"Background {key} must be a rank-2 image: {values.shape}")

    if not np.all(np.isfinite(values)):
        raise ValueError(f"Background {key} must contain only finite values")
    finite_values = values.reshape(-1)

    finite_min = float(np.min(finite_values))
    finite_max = float(np.max(finite_values))
    auto_lower, auto_upper = _auto_contrast_limits(
        finite_values,
        finite_min=finite_min,
        finite_max=finite_max,
    )
    value_range, auto_range = _integer_ranges(
        finite_min=finite_min,
        finite_max=finite_max,
        auto_lower=auto_lower,
        auto_upper=auto_upper,
    )

    value_offset = finite_min
    if finite_max > finite_min:
        value_scale = (finite_max - finite_min) / _UINT16_MAX
        encoded_finite = np.rint(
            (finite_values.astype(np.float64, copy=False) - value_offset)
            / value_scale
        )
        encoded_finite = np.clip(encoded_finite, 0, _UINT16_MAX).astype(
            np.dtype(BACKGROUND_DTYPE),
            copy=False,
        )
    else:
        # All finite pixels decode exactly to ``value_offset`` from code zero.
        value_scale = 1.0
        encoded_finite = np.zeros(finite_values.shape, dtype=np.dtype(BACKGROUND_DTYPE))

    encoded = np.ascontiguousarray(
        encoded_finite.reshape(values.shape),
        dtype=np.dtype(BACKGROUND_DTYPE),
    )

    relative_file = BACKGROUND_SOURCE_FILES[key]
    output_path = root / relative_file
    output_path.parent.mkdir(parents=True, exist_ok=True)
    encoded.tofile(output_path)

    return {
        "key": key,
        "label": label,
        "file": relative_file,
        "dtype": BACKGROUND_DTYPE,
        "layout": BACKGROUND_LAYOUT,
        "value_offset": value_offset,
        "value_scale": float(value_scale),
        "value_range": value_range,
        "auto_range": auto_range,
    }


def write_background_cache(
    *,
    cache_save_fold: str | Path,
    mmap_load_path: str | Path,
    height: int,
    width: int,
    trace_length: int,
) -> list[dict[str, object]]:
    root = Path(cache_save_fold)
    (root / BACKGROUND_DIRNAME).mkdir(parents=True, exist_ok=True)

    source = Path(mmap_load_path).expanduser().resolve()
    mean_image, std_image = mean_std_projection_from_mmap(
        source,
        height=height,
        width=width,
        trace_length=trace_length,
    )

    mean_spec = _write_background_binary(
        root=root,
        image=mean_image,
        key="mean",
        label="Mean",
    )
    del mean_image

    std_spec = _write_background_binary(
        root=root,
        image=std_image,
        key="std",
        label="STD",
    )
    bandpass_image = imagej_bandpass(std_image)
    del std_image
    bandpass_spec = _write_background_binary(
        root=root,
        image=bandpass_image,
        key="bandpass",
        label="STD + Bandpass",
    )

    return [mean_spec, std_spec, bandpass_spec]
