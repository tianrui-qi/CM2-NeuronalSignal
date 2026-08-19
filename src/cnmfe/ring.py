from __future__ import annotations

from pathlib import Path
from typing import Any

import h5py
import numpy as np
import scipy.sparse
import tqdm
from skimage.morphology import disk

from caiman.utils.stats import pd_solve


DEFAULT_B0_BLOCK_MIB = 128
DEFAULT_HDF5_PIXEL_BATCH_SIZE = 64
DEFAULT_HDF5_CHUNK_NNZ = 1_000_000


class COrderMmapRowReader:
    """Read rows from a CaImAn C-order mmap without memory-mapping the file."""

    def __init__(self, path: str | Path, *, n_pixels: int, frames: int) -> None:
        self.path = Path(path).expanduser()
        self.n_pixels = int(n_pixels)
        self.frames = int(frames)
        self.dtype = np.dtype(np.float32)
        self.row_bytes = self.frames * self.dtype.itemsize
        expected_size = self.n_pixels * self.row_bytes
        actual_size = self.path.stat().st_size
        if actual_size != expected_size:
            raise ValueError(
                f"mmap size mismatch for {self.path}: expected {expected_size}, got {actual_size}"
            )

    @property
    def shape(self) -> tuple[int, int]:
        return self.n_pixels, self.frames

    def read_block(self, row0: int, row1: int) -> np.ndarray:
        row0 = int(row0)
        row1 = int(row1)
        if row0 < 0 or row1 < row0 or row1 > self.n_pixels:
            raise IndexError(f"Invalid row block [{row0}, {row1}) for {self.n_pixels} rows")
        count = row1 - row0
        with self.path.open("rb") as handle:
            handle.seek(row0 * self.row_bytes)
            payload = handle.read(count * self.row_bytes)
        if len(payload) != count * self.row_bytes:
            raise IOError(f"Short read from {self.path} at rows [{row0}, {row1})")
        return np.frombuffer(payload, dtype=self.dtype).reshape((count, self.frames)).copy()

    def read_rows(self, rows: np.ndarray) -> np.ndarray:
        rows = np.asarray(rows, dtype=np.int64)
        if rows.ndim != 1:
            raise ValueError(f"Expected 1D rows, got {rows.shape}")
        if len(rows) == 0:
            return np.empty((0, self.frames), dtype=np.float32)
        if rows[0] < 0 or rows[-1] >= self.n_pixels:
            raise IndexError(f"Rows outside movie bounds: {rows[0]}..{rows[-1]}")

        out = np.empty((len(rows), self.frames), dtype=np.float32)
        breaks = np.flatnonzero(np.diff(rows) != 1) + 1
        starts = np.concatenate(([0], breaks))
        stops = np.concatenate((breaks, [len(rows)]))
        with self.path.open("rb") as handle:
            for start, stop in zip(starts, stops):
                row0 = int(rows[start])
                count = int(stop - start)
                handle.seek(row0 * self.row_bytes)
                payload = handle.read(count * self.row_bytes)
                if len(payload) != count * self.row_bytes:
                    raise IOError(f"Short read from {self.path} at row {row0}")
                out[start:stop] = np.frombuffer(payload, dtype=self.dtype).reshape(
                    (count, self.frames)
                )
        return out


def _as_csr_float32(matrix: Any) -> scipy.sparse.csr_matrix:
    if scipy.sparse.issparse(matrix):
        return matrix.tocsr().astype(np.float32, copy=False)
    return scipy.sparse.csr_matrix(np.asarray(matrix, dtype=np.float32))


def _ring_offsets(radius: float, ssub: int) -> tuple[np.ndarray, np.ndarray]:
    scaled_radius = int(round(float(radius) / float(ssub)))
    ring = disk(scaled_radius + 1)
    ring[1:-1, 1:-1] -= disk(scaled_radius)
    coords = np.nonzero(ring)
    return (
        np.asarray(coords[0], dtype=np.int64) - scaled_radius - 1,
        np.asarray(coords[1], dtype=np.int64) - scaled_radius - 1,
    )


def _neighbor_candidates(
    pixels: np.ndarray,
    *,
    d1: int,
    d2: int,
    ring_dx: np.ndarray,
    ring_dy: np.ndarray,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    x = pixels % d1
    y = pixels // d1
    xx = x[:, None] + ring_dx[None, :]
    yy = y[:, None] + ring_dy[None, :]
    inside = (xx >= 0) & (xx < d1) & (yy >= 0) & (yy < d2)
    candidates = xx + yy * d1
    counts = inside.sum(axis=1).astype(np.int64, copy=False)
    return candidates.astype(np.int64, copy=False), inside, counts


def _build_indptr(
    *,
    d1: int,
    d2: int,
    ring_dx: np.ndarray,
    ring_dy: np.ndarray,
    pixel_batch_size: int,
) -> np.ndarray:
    n_pixels = int(d1) * int(d2)
    indptr = np.empty(n_pixels + 1, dtype=np.int64)
    indptr[0] = 0
    with tqdm.tqdm(
        total=n_pixels,
        desc="ring(count)",
        unit="px",
        dynamic_ncols=True,
    ) as bar:
        for start in range(0, n_pixels, pixel_batch_size):
            stop = min(start + pixel_batch_size, n_pixels)
            pixels = np.arange(start, stop, dtype=np.int64)
            _, _, counts = _neighbor_candidates(
                pixels,
                d1=d1,
                d2=d2,
                ring_dx=ring_dx,
                ring_dy=ring_dy,
            )
            indptr[start + 1 : stop + 1] = indptr[start] + np.cumsum(counts)
            bar.update(stop - start)
    return indptr


def _b0_block_rows(frames: int, block_mib: int) -> int:
    target_bytes = max(1, int(block_mib)) * 1024 * 1024
    bytes_per_row = int(frames) * np.dtype(np.float32).itemsize
    return max(1, target_bytes // max(1, bytes_per_row))


def compute_b0_streaming(
    yr: COrderMmapRowReader | np.memmap | np.ndarray,
    a_mat: scipy.sparse.spmatrix | np.ndarray,
    c_mat: np.ndarray,
    *,
    block_mib: int = DEFAULT_B0_BLOCK_MIB,
) -> np.ndarray:
    """Compute CaImAn ring-model b0 without materializing A*C."""

    a_csr = _as_csr_float32(a_mat)
    c = np.asarray(c_mat, dtype=np.float32)
    if c.ndim != 2:
        raise ValueError(f"Expected C as a 2D array, got {c.shape}")
    if a_csr.shape[1] != c.shape[0]:
        raise ValueError(f"A/C mismatch: A={a_csr.shape}, C={c.shape}")

    n_pixels, frames = int(yr.shape[0]), int(yr.shape[1])
    c_mean = c.mean(axis=1, dtype=np.float32)
    out = np.empty(n_pixels, dtype=np.float32)
    block_rows = _b0_block_rows(frames=frames, block_mib=block_mib)
    with tqdm.tqdm(
        total=n_pixels,
        desc="ring(b0)",
        unit="px",
        dynamic_ncols=True,
    ) as bar:
        for row0 in range(0, n_pixels, block_rows):
            row1 = min(row0 + block_rows, n_pixels)
            y_mean = np.asarray(_movie_block(yr, row0, row1).mean(axis=1), dtype=np.float32)
            ac_mean = np.asarray(a_csr[row0:row1, :].dot(c_mean), dtype=np.float32).reshape(-1)
            out[row0:row1] = y_mean - ac_mean
            bar.update(row1 - row0)
    return out


def _movie_rows(
    yr: COrderMmapRowReader | np.memmap | np.ndarray,
    rows: np.ndarray,
) -> np.ndarray:
    if isinstance(yr, COrderMmapRowReader):
        return yr.read_rows(rows)
    return np.asarray(yr[rows, :], dtype=np.float32)


def _movie_block(
    yr: COrderMmapRowReader | np.memmap | np.ndarray,
    row0: int,
    row1: int,
) -> np.ndarray:
    if isinstance(yr, COrderMmapRowReader):
        return yr.read_block(row0, row1)
    return np.asarray(yr[row0:row1, :], dtype=np.float32)


def _residual_rows(
    rows: np.ndarray,
    *,
    yr: COrderMmapRowReader | np.memmap | np.ndarray,
    a_csr: scipy.sparse.csr_matrix,
    c_mat: np.ndarray,
    b0: np.ndarray,
) -> np.ndarray:
    y_rows = _movie_rows(yr, rows)
    ac_rows = a_csr[rows, :].dot(c_mat).astype(np.float32, copy=False)
    return y_rows - ac_rows - b0[rows, None]


def _solve_ring_batch(
    pixels: np.ndarray,
    neighbors: np.ndarray,
    *,
    yr: COrderMmapRowReader | np.memmap | np.ndarray,
    a_csr: scipy.sparse.csr_matrix,
    c_mat: np.ndarray,
    b0: np.ndarray,
) -> np.ndarray:
    rows = np.concatenate((pixels, neighbors.reshape(-1)))
    unique_rows = np.unique(rows)
    residual = _residual_rows(rows=unique_rows, yr=yr, a_csr=a_csr, c_mat=c_mat, b0=b0)
    target = residual[np.searchsorted(unique_rows, pixels)]
    neighbor_residual = residual[np.searchsorted(unique_rows, neighbors.reshape(-1))]
    neighbor_residual = neighbor_residual.reshape((len(pixels), neighbors.shape[1], yr.shape[1]))
    return _solve_ring_weights_cpu(neighbor_residual, target)


def _solve_ring_weights_cpu(neighbor_residual: np.ndarray, target: np.ndarray) -> np.ndarray:
    gram = np.einsum("nkt,nlt->nkl", neighbor_residual, neighbor_residual, optimize=True)
    trace = np.trace(gram, axis1=1, axis2=2)
    diag = np.arange(gram.shape[1])
    gram[:, diag, diag] += trace[:, None] * 1e-5
    rhs = np.einsum("nkt,nt->nk", neighbor_residual, target, optimize=True)
    try:
        return np.linalg.solve(gram, rhs[..., None])[..., 0].astype(np.float32, copy=False)
    except np.linalg.LinAlgError:
        data = np.empty_like(rhs, dtype=np.float32)
        for row in range(len(rhs)):
            data[row] = pd_solve(gram[row], rhs[row]).astype(np.float32, copy=False)
        return data


def _store_group_as_csc(
    *,
    pixels: np.ndarray,
    neighbors: np.ndarray,
    weights: np.ndarray,
    cursor: np.ndarray,
    indices_out: np.memmap,
    data_out: np.memmap,
) -> None:
    count = neighbors.shape[1]
    flat_cols = neighbors.reshape(-1)
    flat_rows = np.repeat(pixels, count)
    flat_weights = weights.reshape(-1)

    order = np.argsort(flat_cols, kind="stable")
    cols = flat_cols[order]
    rows = flat_rows[order]
    vals = flat_weights[order]
    _, first, counts = np.unique(cols, return_index=True, return_counts=True)
    offsets = np.arange(len(cols), dtype=np.int64) - np.repeat(first, counts)
    dest = cursor[cols] + offsets

    indices_out[dest] = rows
    data_out[dest] = vals
    cursor[cols[first]] += counts


def _replace_dataset(group: h5py.Group, name: str, data: np.ndarray) -> None:
    if name in group:
        del group[name]
    group.create_dataset(name, data=data)


def _copy_memmap_to_dataset(
    source: np.memmap,
    target: h5py.Dataset,
    *,
    chunk_nnz: int,
) -> None:
    chunk_nnz = max(1, int(chunk_nnz))
    total = int(source.shape[0])
    with tqdm.tqdm(
        total=total,
        desc=f"hdf5({target.name.rsplit('/', 1)[-1]})",
        unit="nnz",
        dynamic_ncols=True,
    ) as bar:
        for start in range(0, total, chunk_nnz):
            stop = min(start + chunk_nnz, total)
            target[start:stop] = source[start:stop]
            bar.update(stop - start)


def write_ring_model_hdf5(
    hdf5_path: str | Path,
    yr: COrderMmapRowReader | np.memmap | np.ndarray,
    a_mat: scipy.sparse.spmatrix | np.ndarray,
    c_mat: np.ndarray,
    dims: tuple[int, int],
    radius: float,
    *,
    temp_dir: str | Path,
    ssub: int = 1,
    tsub: int = 1,
    pixel_batch_size: int = DEFAULT_HDF5_PIXEL_BATCH_SIZE,
    b0_block_mib: int = DEFAULT_B0_BLOCK_MIB,
    hdf5_chunk_nnz: int = DEFAULT_HDF5_CHUNK_NNZ,
) -> tuple[int, tuple[int, ...]]:
    """Write CaImAn-compatible ring ``W`` and ``b0`` directly into a CNMF hdf5.

    The file format matches CaImAn's ``save_dict_to_hdf5`` sparse encoding:
    ``estimates/W`` stores CSC ``data/indices/indptr/shape``. CaImAn's loader
    then reconstructs the matrix as CSC and converts ``W`` back to CSR.
    """

    if int(ssub) != 1 or int(tsub) != 1:
        raise NotImplementedError("HDF5 ring W writer currently supports ssub=1 and tsub=1.")

    hdf5_path = Path(hdf5_path).expanduser()
    temp_dir = Path(temp_dir).expanduser()
    temp_dir.mkdir(parents=True, exist_ok=True)
    d1, d2 = int(dims[0]), int(dims[1])
    n_pixels = d1 * d2
    if int(yr.shape[0]) != n_pixels:
        raise ValueError(f"Movie rows {yr.shape[0]} do not match dims {dims}.")

    a_csr = _as_csr_float32(a_mat)
    c = np.asarray(c_mat, dtype=np.float32)
    if a_csr.shape != (n_pixels, c.shape[0]):
        raise ValueError(f"A/C/dims mismatch: A={a_csr.shape}, C={c.shape}, dims={dims}.")

    pixel_batch_size = max(1, int(pixel_batch_size))
    ring_dx, ring_dy = _ring_offsets(radius=radius, ssub=ssub)
    b0 = compute_b0_streaming(yr, a_csr, c, block_mib=b0_block_mib)
    indptr64 = _build_indptr(
        d1=d1,
        d2=d2,
        ring_dx=ring_dx,
        ring_dy=ring_dy,
        pixel_batch_size=max(pixel_batch_size * 8, 8192),
    )
    nnz = int(indptr64[-1])
    index_dtype = np.int32 if nnz <= np.iinfo(np.int32).max else np.int64
    indptr = indptr64.astype(index_dtype, copy=False)
    cursor = indptr64[:-1].copy()

    data_path = temp_dir / "W_data.float32.tmp"
    indices_path = temp_dir / f"W_indices.{np.dtype(index_dtype).name}.tmp"
    for path in (data_path, indices_path):
        if path.exists():
            path.unlink()
    data_mm = np.memmap(data_path, dtype=np.float32, mode="w+", shape=(nnz,))
    indices_mm = np.memmap(indices_path, dtype=index_dtype, mode="w+", shape=(nnz,))

    with tqdm.tqdm(
        total=n_pixels,
        desc="ring(W->csc)",
        unit="px",
        dynamic_ncols=True,
    ) as bar:
        for start in range(0, n_pixels, pixel_batch_size):
            stop = min(start + pixel_batch_size, n_pixels)
            pixels = np.arange(start, stop, dtype=np.int64)
            candidates, inside, counts = _neighbor_candidates(
                pixels,
                d1=d1,
                d2=d2,
                ring_dx=ring_dx,
                ring_dy=ring_dy,
            )
            for count in np.unique(counts):
                count = int(count)
                if count == 0:
                    continue
                group_rows = np.flatnonzero(counts == count)
                group_pixels = pixels[group_rows]
                group_neighbors = candidates[group_rows][inside[group_rows]].reshape((-1, count))
                group_weights = _solve_ring_batch(
                    group_pixels,
                    group_neighbors,
                    yr=yr,
                    a_csr=a_csr,
                    c_mat=c,
                    b0=b0,
                )
                _store_group_as_csc(
                    pixels=group_pixels,
                    neighbors=group_neighbors,
                    weights=group_weights,
                    cursor=cursor,
                    indices_out=indices_mm,
                    data_out=data_mm,
                )
            bar.update(stop - start)

    expected_cursor = indptr64[1:]
    if not np.array_equal(cursor, expected_cursor):
        bad = np.flatnonzero(cursor != expected_cursor)[:10]
        raise RuntimeError(f"CSC W fill did not complete expected column counts; first bad columns={bad}")

    data_mm.flush()
    indices_mm.flush()

    with h5py.File(hdf5_path, "r+") as handle:
        estimates = handle["estimates"]
        _replace_dataset(estimates, "b0", b0.astype(np.float32, copy=False))
        if "W" in estimates:
            del estimates["W"]
        w_group = estimates.create_group("W")
        chunks = (min(int(hdf5_chunk_nnz), nnz),)
        data_ds = w_group.create_dataset("data", shape=(nnz,), dtype=np.float32, chunks=chunks)
        indices_ds = w_group.create_dataset("indices", shape=(nnz,), dtype=index_dtype, chunks=chunks)
        w_group.create_dataset("indptr", data=indptr)
        w_group.create_dataset("shape", data=np.asarray((n_pixels, n_pixels), dtype=np.int64))
        _copy_memmap_to_dataset(data_mm, data_ds, chunk_nnz=hdf5_chunk_nnz)
        _copy_memmap_to_dataset(indices_mm, indices_ds, chunk_nnz=hdf5_chunk_nnz)
        if "params/init/nb" in handle:
            handle["params/init/nb"][...] = 0

    del data_mm
    del indices_mm
    for path in (data_path, indices_path):
        if path.exists():
            path.unlink()
    return nnz, b0.shape


def ring_radius_from_init(init_params: dict[str, Any]) -> float:
    g_siz = init_params.get("gSiz")
    if g_siz is None:
        g_sig = init_params.get("gSig")
        if g_sig is None:
            raise ValueError("Need init.gSiz or init.gSig to compute ring radius.")
        g_siz = [2 * int(g_sig[0]) + 1]
    return float(init_params["ring_size_factor"]) * float(g_siz[0])
