from __future__ import annotations

import os
import re
from pathlib import Path

import numpy as np
import tifffile
import tqdm
import zarr


MMAP_OFFSET = np.float32(0.0001)
ENCODED_MMAP_RE = re.compile(
    r".*_d1_(?P<d1>\d+)_d2_(?P<d2>\d+)_d3_(?P<d3>\d+)_"
    r"order_(?P<order>[CF])_frames_(?P<frames>\d+)\.mmap$"
)


def _tiff_shape_dtype(path: Path) -> tuple[int, int, int, np.dtype]:
    with tifffile.TiffFile(path) as tif:
        video = zarr.open(tif.aszarr(), mode="r")
        if video.ndim != 3:
            raise ValueError(f"Expected a TYX TIFF, got ndim={video.ndim}: {path}")
        return (
            int(video.shape[0]),
            int(video.shape[1]),
            int(video.shape[2]),
            np.dtype(video.dtype),
        )


def encoded_mmap_path(stem: str | Path, *, t: int, h: int, w: int, order: str = "C") -> Path:
    stem_path = Path(stem).expanduser()
    if stem_path.suffix == ".mmap":
        raise ValueError(f"mmap stem should not include .mmap suffix: {stem_path}")
    return stem_path.with_name(
        f"{stem_path.name}_d1_{int(h)}_d2_{int(w)}_d3_1_order_{order}_frames_{int(t)}.mmap"
    )


def parse_encoded_mmap_name(path: str | Path) -> tuple[tuple[int, ...], int, str]:
    mmap_path = Path(path)
    match = ENCODED_MMAP_RE.match(mmap_path.name)
    if match is None:
        raise ValueError(
            "Expected CaImAn encoded mmap filename like "
            "Y_d1_2692_d2_3548_d3_1_order_C_frames_1788.mmap: "
            f"{mmap_path}"
        )
    d1 = int(match.group("d1"))
    d2 = int(match.group("d2"))
    d3 = int(match.group("d3"))
    frames = int(match.group("frames"))
    order = match.group("order")
    dims = (d1, d2) if d3 == 1 else (d1, d2, d3)
    return dims, frames, order


def resolve_mmap_path(stem: str | Path) -> Path:
    stem_path = Path(stem).expanduser()
    parent = stem_path.parent if str(stem_path.parent) else Path(".")
    matches = sorted(parent.glob(f"{stem_path.name}_d1_*_d2_*_d3_*_order_*_frames_*.mmap"))
    if len(matches) != 1:
        raise FileNotFoundError(
            f"Expected exactly one encoded mmap for stem {stem_path}, found {len(matches)}."
        )
    return matches[0]


def _columns_per_write_block(h: int, w: int, t: int, write_block_mib: int) -> int:
    bytes_per_column = int(h) * int(t) * np.dtype(np.float32).itemsize
    target_bytes = max(1, int(write_block_mib)) * 1024 * 1024
    return max(1, min(int(w), target_bytes // max(1, bytes_per_column)))


def _write_row_block(handle: object, row0: int, frames: int, block: np.ndarray) -> None:
    itemsize = np.dtype(np.float32).itemsize
    contiguous = np.ascontiguousarray(block, dtype=np.float32)
    handle.seek(int(row0) * int(frames) * itemsize)
    handle.write(memoryview(contiguous).cast("B"))
    handle.flush()
    os.fsync(handle.fileno())


def load_memmap_movie(path: str | Path) -> tuple[np.memmap, tuple[int, int], int]:
    """Load a CaImAn encoded mmap using only the filename metadata."""

    mmap_path = Path(path).expanduser()
    dims, frames, order = parse_encoded_mmap_name(mmap_path)
    if len(dims) != 2:
        raise ValueError(f"Expected a 2D movie mmap, got dims={dims}: {mmap_path}")
    shape = (int(dims[0]) * int(dims[1]), frames)
    yr = np.memmap(str(mmap_path), dtype=np.float32, mode="r", shape=shape, order=order)
    return yr, (int(dims[0]), int(dims[1])), frames


def run(
    raw_load_path: str | Path,
    mmap_save_stem: str | Path,
    write_block_mib: int = 128,
) -> Path:
    raw_load_path = Path(raw_load_path).expanduser().resolve()
    t, h, w, dtype = _tiff_shape_dtype(raw_load_path)
    final_path = encoded_mmap_path(mmap_save_stem, t=t, h=h, w=w, order="C")
    final_path.parent.mkdir(parents=True, exist_ok=True)

    write_block_mib = max(1, int(write_block_mib))
    columns_per_block = _columns_per_write_block(h=h, w=w, t=t, write_block_mib=write_block_mib)
    block_mib = columns_per_block * h * t * np.dtype(np.float32).itemsize / 1024 / 1024
    print(
        f"[mmap] build {final_path} from {raw_load_path}; "
        f"shape={(t, h, w)} dtype={dtype} order=C columns_per_block={columns_per_block} "
        f"write_block={block_mib:.1f}MiB"
    )

    tmp_path = final_path.with_suffix(".tmp.mmap")
    if tmp_path.exists():
        tmp_path.unlink()
    expected_size = int(h) * int(w) * int(t) * np.dtype(np.float32).itemsize
    with tmp_path.open("w+b") as out:
        out.truncate(expected_size)
        with tifffile.TiffFile(raw_load_path) as tif:
            video = zarr.open(tif.aszarr(), mode="r")
            total_columns = (w + columns_per_block - 1) // columns_per_block
            with tqdm.tqdm(
                total=total_columns,
                desc="mmap(write)",
                unit="block",
                dynamic_ncols=True,
            ) as bar:
                for x0 in range(0, w, columns_per_block):
                    x1 = min(x0 + columns_per_block, w)
                    slab = np.asarray(video[:, :, x0:x1], dtype=np.float32)
                    slab += MMAP_OFFSET
                    yr_block = np.reshape(slab, (t, h * (x1 - x0)), order="F").T
                    _write_row_block(out, row0=x0 * h, frames=t, block=yr_block)
                    del yr_block
                    del slab
                    bar.update(1)

    os.replace(tmp_path, final_path)
    print(f"[mmap] saved {final_path}")
    return final_path
