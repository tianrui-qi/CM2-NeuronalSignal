from __future__ import annotations

import os
import pickle
import shutil
import time
from copy import deepcopy
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import scipy.ndimage
import scipy.sparse
import tqdm
from sklearn.decomposition import NMF

from caiman.cluster import extract_patch_coordinates
from caiman.source_extraction.cnmf.map_reduce import cnmf_patches


def _patch_cache_root(*, reuse: bool) -> Path:
    root = Path(os.environ.get("CAIMAN_TEMP", ".")).expanduser().resolve() / "patch_results"
    if root.exists() and not reuse:
        shutil.rmtree(root)
    root.mkdir(parents=True, exist_ok=True)
    return root


def _cnmf_patches_indexed(payload: tuple[int, tuple[Any, ...]]) -> tuple[int, Any]:
    patch_id, args = payload
    return patch_id, cnmf_patches(args)


def _iter_patch_results(dview: Any, args_in: list[tuple[Any, ...]]) -> Iterable[tuple[int, Any]]:
    indexed_args = list(enumerate(args_in))
    if dview is not None and hasattr(dview, "imap_unordered"):
        yield from dview.imap_unordered(_cnmf_patches_indexed, indexed_args, chunksize=1)
        return
    if dview is not None and hasattr(dview, "map_sync"):
        for result in dview.map_sync(_cnmf_patches_indexed, indexed_args):
            yield result
        return
    for patch_id, args in indexed_args:
        yield patch_id, cnmf_patches(args)


def _deduplicate_patch(fff: list[Any], patch_id: int, patch_center: tuple[float, ...], patch_centers: list[tuple[float, ...]]) -> list[Any]:
    idx_, shapes, a_mat, _, c_mat, _, s_mat, bl, c1, neurons_sn, g, _, _, yra = fff
    a_mat = a_mat.tocsc()
    keep: list[int] = []
    centers = np.asarray(patch_centers)
    for col in range(a_mat.shape[-1]):
        neuron_center = (
            np.array(scipy.ndimage.center_of_mass(a_mat[:, col].toarray().reshape(shapes, order="F")))
            - np.array(shapes) / 2.0
            + np.array(patch_center)
        )
        if np.argmin([np.linalg.norm(neuron_center - center) for center in centers]) == patch_id:
            keep.append(col)

    a_mat = a_mat[:, keep]
    fff[2] = a_mat
    fff[4] = c_mat[keep]
    if s_mat is not None:
        fff[6] = s_mat[keep]
        fff[7] = bl[keep]
        fff[8] = c1[keep]
        fff[9] = neurons_sn[keep]
        fff[10] = g[keep]
    fff[-1] = yra[keep]
    return fff


def _save_patch(path: Path, payload: Any) -> None:
    with path.open("wb") as handle:
        pickle.dump(payload, handle, protocol=pickle.HIGHEST_PROTOCOL)


def _load_patch(path: Path) -> Any:
    with path.open("rb") as handle:
        return pickle.load(handle)


def _make_memmap(path: Path, shape: tuple[int, ...]) -> np.memmap:
    return np.memmap(str(path), dtype=np.float32, mode="w+", shape=shape)


def _append_sparse_column(
    *,
    column: scipy.sparse.spmatrix,
    idx_global: np.ndarray,
    data_parts: list[np.ndarray],
    index_parts: list[np.ndarray],
    indptr: list[int],
) -> bool:
    coo = column.tocoo()
    if coo.nnz == 0 or coo.data.sum() <= 0:
        return False
    data = np.asarray(coo.data, dtype=np.float32)
    rows = np.asarray(idx_global[coo.row], dtype=np.int64)
    data_parts.append(data)
    index_parts.append(rows)
    indptr.append(len(data))
    return True


def run_CNMF_patches_disk_backed(
    file_name: str,
    shape: tuple[int, ...],
    params: Any,
    gnb: int = 1,
    dview: Any = None,
    memory_fact: float = 1,
    border_pix: int = 0,
    low_rank_background: bool | None = True,
    del_duplicates: bool = False,
    indices: list[slice] = [slice(None)] * 3,
) -> tuple[Any, ...]:
    """Memory-bounded replacement for CaImAn's ``run_CNMF_patches``.

    The numerical patch fits are still delegated to CaImAn's ``cnmf_patches``.
    The difference is aggregation: results are streamed to disk instead of
    collected into one large in-memory ``file_res`` list.
    """

    dims = shape[:-1]
    d = int(np.prod(dims))
    t = int(shape[-1])

    rf = params.get("patch", "rf")
    rf = 16 if rf is None else rf
    rfs = [rf] * len(dims) if np.isscalar(rf) else rf

    stride = params.get("patch", "stride")
    stride = 4 if stride is None else stride
    strides = [stride] * len(dims) if np.isscalar(stride) else stride

    params_copy = deepcopy(params)
    npx_per_proc = np.prod(rfs) // memory_fact
    params_copy.set("preprocess", {"n_pixels_per_process": npx_per_proc})
    params_copy.set("spatial", {"n_pixels_per_process": npx_per_proc})
    params_copy.set("temporal", {"n_pixels_per_process": npx_per_proc})

    idx_flat, idx_2d = extract_patch_coordinates(
        dims, rfs, strides, border_pix=border_pix, indices=indices[1:]
    )
    args_in = []
    patch_centers = []
    for idx_, id_2d in zip(idx_flat, idx_2d):
        args_in.append((file_name, idx_, id_2d, params_copy))
        if del_duplicates:
            patch_mask = np.zeros(d, dtype=bool)
            patch_mask[idx_] = 1
            patch_centers.append(scipy.ndimage.center_of_mass(patch_mask.reshape(dims, order="F")))

    reuse_patch_results = os.environ.get("CM2_REUSE_PATCH_RESULTS") == "1"
    cache_root = _patch_cache_root(reuse=reuse_patch_results)
    patch_paths: list[Path | None] = [None] * len(args_in)
    count = 0
    count_bgr = 0
    start_time = time.time()
    if reuse_patch_results:
        existing = sorted(cache_root.glob("patch_*.pkl"))
        if len(existing) != len(args_in):
            raise RuntimeError(
                "CM2_REUSE_PATCH_RESULTS=1 but patch result count does not match: "
                f"found {len(existing)}, expected {len(args_in)}"
            )
        print(f"[fit] reusing {len(existing)} patch result files from {cache_root}", flush=True)
        with tqdm.tqdm(total=len(args_in), desc="cnmfe(count)", unit="patch", dynamic_ncols=True) as bar:
            for patch_id, patch_path in enumerate(existing):
                fff = _load_patch(patch_path)
                a_mat = fff[2].tocsc()
                count += int(np.sum(a_mat.sum(0) > 0))
                count_bgr += int(fff[3].shape[-1])
                patch_paths[patch_id] = patch_path
                bar.update(1)
    else:
        with tqdm.tqdm(total=len(args_in), desc="cnmfe(patches)", unit="patch", dynamic_ncols=True) as bar:
            for patch_id, fff in _iter_patch_results(dview, args_in):
                if fff is None:
                    bar.update(1)
                    continue
                if del_duplicates:
                    fff = _deduplicate_patch(fff, patch_id, patch_centers[patch_id], patch_centers)

                a_mat = fff[2].tocsc()
                count += int(np.sum(a_mat.sum(0) > 0))
                count_bgr += int(fff[3].shape[-1])
                patch_path = cache_root / f"patch_{patch_id:06d}.pkl"
                _save_patch(patch_path, fff)
                patch_paths[patch_id] = patch_path
                bar.update(1)

    print(
        "[fit] patch fits complete; "
        f"patches={len(args_in)} components_before_merge={count} "
        f"background_components={count_bgr} elapsed_s={time.time() - start_time:.1f}",
        flush=True,
    )

    nb_patch = params.get("patch", "nb_patch")
    c_tot = _make_memmap(cache_root / "C_tot.float32.mmap", (count, t))
    s_tot = _make_memmap(cache_root / "S_tot.float32.mmap", (count, t)) if params.get("init", "center_psf") else None
    yra_tot = _make_memmap(cache_root / "YrA_tot.float32.mmap", (count, t))
    f_tot = np.zeros((max(0, len(args_in) * nb_patch), t), dtype=np.float32)
    mask = np.zeros(d, dtype=np.uint8)
    sn_tot = np.zeros((d))

    f_list: list[Any] = []
    bl_list: list[Any] = []
    c1_list: list[Any] = []
    neurons_sn_list: list[Any] = []
    g_list: list[Any] = []
    idx_list: list[Any] = []
    id_patch_tot: list[int] = []
    shapes_tot: list[Any] = []
    b_data_parts: list[np.ndarray] = []
    b_index_parts: list[np.ndarray] = []
    b_indptr_counts = [0]
    a_data_parts: list[np.ndarray] = []
    a_index_parts: list[np.ndarray] = []
    a_indptr_counts = [0]

    count = 0
    count_bgr_seen = 0
    empty = 0
    with tqdm.tqdm(total=len(patch_paths), desc="cnmfe(embed)", unit="patch", dynamic_ncols=True) as bar:
        for patch_id, patch_path in enumerate(patch_paths):
            if patch_path is None:
                empty += 1
                bar.update(1)
                continue
            fff = _load_patch(patch_path)
            idx_, shapes, a_mat, b_mat, c_mat, f_mat, s_mat, bl, c1, neurons_sn, g, sn, _, yra = fff
            a_mat = a_mat.tocsc()
            if np.isnan(a_mat.data).sum() > 0:
                raise RuntimeError("found nans in A, cannot continue")

            sn_tot[idx_] = sn
            f_list.append(f_mat)
            bl_list.append(bl)
            c1_list.append(c1)
            neurons_sn_list.append(neurons_sn)
            g_list.append(g)
            idx_list.append(idx_)
            shapes_tot.append(shapes)
            mask[idx_] += 1

            if scipy.sparse.issparse(b_mat):
                b_csc = scipy.sparse.csc_matrix(b_mat)
                b_data_parts.append(np.asarray(b_csc.data, dtype=np.float32))
                b_indptr_counts.extend((b_csc.indptr[1:] - b_csc.indptr[:-1]).astype(np.int64).tolist())
                b_index_parts.append(np.asarray(idx_[b_csc.indices], dtype=np.int64))
            else:
                for col in range(b_mat.shape[-1]):
                    b_data_parts.append(np.asarray(b_mat[:, col], dtype=np.float32))
                    b_index_parts.append(np.asarray(idx_, dtype=np.int64))
                    b_indptr_counts.append(len(idx_))
            count_bgr_seen += int(b_mat.shape[-1])
            if nb_patch >= 0:
                f_tot[patch_id * nb_patch : (patch_id + 1) * nb_patch] = f_mat
            else:
                f_tot = np.concatenate([f_tot, f_mat])

            for col in range(a_mat.shape[-1]):
                if _append_sparse_column(
                    column=a_mat[:, col],
                    idx_global=idx_,
                    data_parts=a_data_parts,
                    index_parts=a_index_parts,
                    indptr=a_indptr_counts,
                ):
                    c_tot[count, :] = c_mat[col, :]
                    if s_tot is not None:
                        s_tot[count, :] = s_mat[col, :]
                    yra_tot[count, :] = yra[col, :]
                    id_patch_tot.append(patch_id)
                    count += 1
            bar.update(1)

    if count_bgr_seen > 0:
        idx_tot_b = np.concatenate(b_index_parts) if b_index_parts else np.array([], dtype=np.int64)
        b_data = np.concatenate(b_data_parts) if b_data_parts else np.array([], dtype=np.float32)
        idx_ptr_b = np.cumsum(np.asarray(b_indptr_counts, dtype=np.int64))
        b_tot_matrix = scipy.sparse.csc_matrix((b_data, idx_tot_b, idx_ptr_b), shape=(d, count_bgr_seen))
    else:
        b_data = np.array([], dtype=np.float32)
        b_tot_matrix = scipy.sparse.csc_matrix((d, count_bgr_seen), dtype=np.float32)

    if a_index_parts:
        idx_tot_a = np.concatenate(a_index_parts)
        a_data = np.concatenate(a_data_parts)
        idx_ptr_a = np.cumsum(np.asarray(a_indptr_counts, dtype=np.int64))
    else:
        idx_tot_a = np.array([], dtype=np.int64)
        a_data = np.array([], dtype=np.float32)
        idx_ptr_a = np.array([0], dtype=np.int64)
    a_tot_matrix = scipy.sparse.csc_matrix((a_data, idx_tot_a, idx_ptr_a), shape=(d, count), dtype=np.float32)

    c_tot.flush()
    yra_tot.flush()
    if s_tot is not None:
        s_tot.flush()

    c_out = c_tot[:count, :]
    yra_out = yra_tot[:count, :]
    f_tot = f_tot[:count_bgr_seen]
    optional_outputs = {
        "b_tot": b_data,
        "f_tot": f_list,
        "bl_tot": bl_list,
        "c1_tot": c1_list,
        "neurons_sn_tot": neurons_sn_list,
        "g_tot": g_list,
        "S_tot": s_tot[:count, :] if s_tot is not None else None,
        "idx_tot": idx_list,
        "shapes_tot": shapes_tot,
        "id_patch_tot": id_patch_tot,
        "B": b_tot_matrix,
        "F": f_tot,
        "mask": mask,
    }

    im = scipy.sparse.csr_matrix(
        (1.0 / (mask + np.finfo(np.float32).eps), (np.arange(d), np.arange(d))),
        dtype=np.float32,
    )
    if not del_duplicates:
        a_tot_matrix = im.dot(a_tot_matrix)

    if count_bgr_seen == 0:
        b_out = None
        f_out = None
    elif low_rank_background is None:
        b_out = im.dot(b_tot_matrix)
        f_out = f_tot
    elif low_rank_background:
        b_tot_matrix = im.dot(b_tot_matrix)
        bm = b_tot_matrix
        model = NMF(n_components=gnb, verbose=False, init="nndsvdar", tol=1e-10, max_iter=100, shuffle=False, random_state=1)
        nan_components = np.any(np.isnan(f_tot), axis=1)
        f_fit = f_tot[~nan_components, :]
        model.fit(np.maximum(f_fit, 0))
        bm = bm[:, ~nan_components]
        f_out = np.atleast_2d(model.components_.squeeze())
        for _ in range(100):
            f_out /= np.sqrt((f_out**2).sum(1)[:, None]) + np.finfo(np.float32).eps
            try:
                b_out = np.fmax(bm.dot(f_fit.dot(f_out.T)).dot(np.linalg.inv(f_out.dot(f_out.T))), 0)
            except np.linalg.LinAlgError:
                b_out = np.fmax(scipy.linalg.lstsq(f_out.T, f_fit.T)[0].T, 0)
            try:
                f_out = np.linalg.solve(b_out.T.dot(b_out), (bm.T.dot(b_out)).T.dot(f_fit))
            except np.linalg.LinAlgError:
                f_out = scipy.linalg.lstsq(b_out, bm.toarray())[0].dot(f_fit)
        n_b = np.ravel(np.sqrt((b_out**2).sum(0)))
        b_out /= n_b + np.finfo(np.float32).eps
        b_out = np.asarray(b_out, dtype=np.float32)
        f_out *= n_b[:, None]
    else:
        raise NotImplementedError("Disk-backed patch aggregation does not support low_rank_background=False yet.")

    print(
        "[fit] embedded patch results; "
        f"components={count} empty_patches={empty} A_nnz={a_tot_matrix.nnz}",
        flush=True,
    )
    return a_tot_matrix, c_out, yra_out, b_out, f_out, sn_tot, optional_outputs
