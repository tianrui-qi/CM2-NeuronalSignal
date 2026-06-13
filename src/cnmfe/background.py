from __future__ import annotations

from pathlib import Path
from typing import Any

import numpy as np
from scipy import fft as scipy_fft
import tifffile
from tqdm import tqdm

from ..mmap import load_memmap_movie


BACKGROUND_CHUNK_FRAMES = 2
BACKGROUND_MMAP_BLOCK_MIB = 64
IMAGEJ_BANDPASS_FILTER_LARGE_DIAMETER_PX = 5.0
IMAGEJ_BANDPASS_FILTER_SMALL_DIAMETER_PX = 1.0


class TiffPageMovie:
    def __init__(
        self,
        path: str | Path,
        *,
        height: int,
        width: int,
        trace_length: int | None = None,
    ) -> None:
        self.path = Path(path)
        self._tif = tifffile.TiffFile(self.path)
        series = self._tif.series[0]
        shape = tuple(int(axis) for axis in series.shape)
        if len(shape) != 3:
            self.close()
            raise ValueError(f"Expected a 3D movie, got shape {shape}: {self.path}")
        if shape[1:] != (height, width):
            self.close()
            raise ValueError(f"Movie shape {shape} does not match model dims {(height, width)}: {self.path}")
        if trace_length is not None and shape[0] != trace_length:
            self.close()
            raise ValueError(f"Movie length {shape[0]} does not match model trace length {trace_length}: {self.path}")
        if len(self._tif.pages) < shape[0]:
            self.close()
            raise ValueError(f"TIFF page count is smaller than movie length: {self.path}")
        self.shape = shape
        self.dtype = np.dtype(series.dtype)

    def close(self) -> None:
        self._tif.close()

    def __getitem__(self, item: Any) -> np.ndarray:
        if isinstance(item, slice):
            start, stop, step = item.indices(self.shape[0])
            frames = [self._tif.pages[idx].asarray() for idx in range(start, stop, step)]
            if not frames:
                return np.empty((0, self.shape[1], self.shape[2]), dtype=self.dtype)
            return np.stack(frames, axis=0)
        if isinstance(item, int):
            if item < 0:
                item += self.shape[0]
            return self._tif.pages[item].asarray()
        raise TypeError(f"Unsupported TIFF movie index: {type(item).__name__}")


def movie_tyx_from_tif(
    y_load_path: str | Path,
    *,
    height: int,
    width: int,
    trace_length: int | None = None,
) -> np.ndarray:
    try:
        movie = tifffile.memmap(y_load_path)
    except ValueError:
        return TiffPageMovie(y_load_path, height=height, width=width, trace_length=trace_length)
    if movie.ndim == 2:
        raise ValueError(f"Expected a time series movie, got 2D image: {y_load_path}")
    if movie.ndim != 3:
        raise ValueError(f"Expected a 3D movie, got shape {movie.shape}: {y_load_path}")
    if movie.shape[1:] == (height, width) and (trace_length is None or movie.shape[0] == trace_length):
        return movie
    if movie.shape[:2] == (height, width) and (trace_length is None or movie.shape[2] == trace_length):
        return np.moveaxis(movie, 2, 0)
    raise ValueError(f"Movie shape {movie.shape} does not match model dims {(height, width)}: {y_load_path}")


def movie_tyx_from_mmap(
    mmap_load_path: str | Path,
    *,
    height: int,
    width: int,
    trace_length: int | None = None,
) -> np.ndarray:
    yr, dims, frames = load_memmap_movie(mmap_load_path)
    if dims != (height, width):
        raise ValueError(f"mmap dims {dims} do not match model dims {(height, width)}: {mmap_load_path}")
    if trace_length is not None and frames != trace_length:
        raise ValueError(
            f"mmap length {frames} does not match model trace length {trace_length}: {mmap_load_path}"
        )
    return yr.T.reshape((frames, height, width), order="F")


def std_projection_from_mmap(
    mmap_load_path: str | Path,
    *,
    height: int,
    width: int,
    trace_length: int,
    block_mib: int = BACKGROUND_MMAP_BLOCK_MIB,
) -> np.ndarray:
    yr, dims, frames = load_memmap_movie(mmap_load_path)
    if dims != (height, width):
        raise ValueError(f"mmap dims {dims} do not match model dims {(height, width)}: {mmap_load_path}")
    if frames != trace_length:
        raise ValueError(f"mmap length {frames} does not match model trace length {trace_length}: {mmap_load_path}")

    bytes_per_pixel_trace = int(frames) * np.dtype(np.float32).itemsize
    target_bytes = max(1, int(block_mib)) * 1024 * 1024
    block_pixels = max(1, target_bytes // max(1, bytes_per_pixel_trace))
    d = int(height) * int(width)
    out = np.empty(d, dtype=np.float32)
    for row0 in tqdm(range(0, d, block_pixels), desc="cache(background)", dynamic_ncols=True):
        row1 = min(row0 + block_pixels, d)
        block = np.asarray(yr[row0:row1, :], dtype=np.float32)
        out[row0:row1] = block.std(axis=1, dtype=np.float64)
        del block
    return out.reshape((height, width), order="F")


def std_projection(movie_tyx: np.ndarray) -> np.ndarray:
    try:
        n_frames = int(movie_tyx.shape[0])
        height = int(movie_tyx.shape[1])
        width = int(movie_tyx.shape[2])
        total = np.zeros((height, width), dtype=np.float64)
        total_sq = np.zeros((height, width), dtype=np.float64)
        for start in tqdm(range(0, n_frames, BACKGROUND_CHUNK_FRAMES), desc="cache(background)", dynamic_ncols=True):
            chunk = np.array(movie_tyx[start:start + BACKGROUND_CHUNK_FRAMES], dtype=np.float32, copy=True)
            total += chunk.sum(axis=0, dtype=np.float64)
            np.square(chunk, out=chunk)
            total_sq += chunk.sum(axis=0, dtype=np.float64)
        mean = total / max(n_frames, 1)
        variance = np.maximum(total_sq / max(n_frames, 1) - mean * mean, 0.0)
        return np.sqrt(variance).astype(np.float32)
    finally:
        close = getattr(movie_tyx, "close", None)
        if close is not None:
            close()


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


def imagej_auto_contrast_uint8(image: np.ndarray, saturated_percent: float = 0.35) -> np.ndarray:
    arr = np.asarray(image, dtype=np.float32)
    finite = arr[np.isfinite(arr)]
    if finite.size == 0:
        return np.zeros(arr.shape, dtype=np.uint8)
    lo = float(np.percentile(finite, saturated_percent))
    hi = float(np.percentile(finite, 100.0 - saturated_percent))
    if not np.isfinite(lo) or not np.isfinite(hi) or hi <= lo:
        lo = float(np.min(finite))
        hi = float(np.max(finite))
    if not np.isfinite(lo) or not np.isfinite(hi) or hi <= lo:
        return np.zeros(arr.shape, dtype=np.uint8)
    scaled = np.clip((arr - lo) / (hi - lo), 0.0, 1.0)
    return np.round(scaled * 255.0).astype(np.uint8)
