from __future__ import annotations

from pathlib import Path

import numpy as np
from scipy import fft as scipy_fft
from tqdm import tqdm

from ..mmap import load_memmap_movie


BACKGROUND_MMAP_BLOCK_MIB = 64
IMAGEJ_BANDPASS_FILTER_LARGE_DIAMETER_PX = 5.0
IMAGEJ_BANDPASS_FILTER_SMALL_DIAMETER_PX = 1.0


def mean_std_projection_from_mmap(
    mmap_load_path: str | Path,
    *,
    height: int,
    width: int,
    trace_length: int,
    block_mib: int = BACKGROUND_MMAP_BLOCK_MIB,
) -> tuple[np.ndarray, np.ndarray]:
    yr, dims, frames = load_memmap_movie(mmap_load_path)
    if dims != (height, width):
        raise ValueError(f"mmap dims {dims} do not match model dims {(height, width)}: {mmap_load_path}")
    if frames != trace_length:
        raise ValueError(f"mmap length {frames} does not match model trace length {trace_length}: {mmap_load_path}")

    bytes_per_pixel_trace = int(frames) * np.dtype(np.float32).itemsize
    target_bytes = max(1, int(block_mib)) * 1024 * 1024
    block_pixels = max(1, target_bytes // max(1, bytes_per_pixel_trace))
    d = int(height) * int(width)
    mean_out = np.empty(d, dtype=np.float32)
    std_out = np.empty(d, dtype=np.float32)
    for row0 in tqdm(range(0, d, block_pixels), desc="cache(background)", dynamic_ncols=True):
        row1 = min(row0 + block_pixels, d)
        block = np.asarray(yr[row0:row1, :], dtype=np.float32)
        mean_out[row0:row1] = block.mean(axis=1, dtype=np.float64)
        std_out[row0:row1] = block.std(axis=1, dtype=np.float64)
        del block
    return (
        mean_out.reshape((height, width), order="F"),
        std_out.reshape((height, width), order="F"),
    )


def _next_power_of_two_at_least(value: float) -> int:
    n = 2
    while n < value:
        n *= 2
    return n


def _reflect_indices(length: int, target_length: int, offset: int) -> np.ndarray:
    raw = np.arange(target_length, dtype=np.int64) - int(offset)
    period = 2 * int(length)
    mirrored = np.mod(raw, period)
    return np.where(mirrored < length, mirrored, period - 1 - mirrored).astype(np.int64)


def _tile_mirror_imagej(image_yx: np.ndarray, padded_size: int) -> tuple[np.ndarray, int, int]:
    height, width = image_yx.shape
    x0 = int(round((padded_size - width) / 2.0))
    y0 = int(round((padded_size - height) / 2.0))
    xi = _reflect_indices(width, padded_size, x0)
    yi = _reflect_indices(height, padded_size, y0)
    return image_yx[yi][:, xi], x0, y0


def _build_imagej_bandpass_filter(size: int) -> np.ndarray:
    rows = np.minimum(
        np.arange(size, dtype=np.float32),
        size - np.arange(size, dtype=np.float32),
    )
    cols = np.arange(size // 2 + 1, dtype=np.float32)
    scale_large = (2.0 * IMAGEJ_BANDPASS_FILTER_LARGE_DIAMETER_PX / float(size)) ** 2
    scale_small = (2.0 * IMAGEJ_BANDPASS_FILTER_SMALL_DIAMETER_PX / float(size)) ** 2
    radius_sq = rows[:, None] * rows[:, None] + cols[None, :] * cols[None, :]
    bandpass = (1.0 - np.exp(-radius_sq * scale_large)) * np.exp(-radius_sq * scale_small)
    bandpass[0, 0] = 1.0
    return bandpass.astype(np.float32, copy=False)


def imagej_bandpass(image_yx: np.ndarray) -> np.ndarray:
    image = np.asarray(image_yx, dtype=np.float32)
    if image.ndim != 2:
        raise ValueError(f"Expected a 2D image, got shape {image.shape}")
    height, width = image.shape
    padded_size = _next_power_of_two_at_least(1.5 * max(height, width))
    padded, x0, y0 = _tile_mirror_imagej(image, padded_size)
    spectrum = scipy_fft.rfft2(padded)
    spectrum *= _build_imagej_bandpass_filter(padded_size).astype(spectrum.real.dtype, copy=False)
    filtered = scipy_fft.irfft2(spectrum, s=padded.shape).astype(np.float32, copy=False)
    return filtered[y0 : y0 + height, x0 : x0 + width]
