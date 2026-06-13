from __future__ import annotations

import os
from pathlib import Path
from typing import Any

import numpy as np
import omegaconf

from ..mmap import load_memmap_movie
from .patches import run_CNMF_patches_disk_backed


CNMFE_GROUPS = ("data", "patch", "init", "preprocess", "spatial", "temporal", "merging")
THREAD_ENV_KEYS = (
    "OMP_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
)


def _to_plain(value: Any) -> Any:
    if omegaconf.OmegaConf.is_config(value):
        return omegaconf.OmegaConf.to_container(value, resolve=True, throw_on_missing=True)
    return value


def _set_runtime_env(temp_path: Path) -> None:
    temp_path.mkdir(parents=True, exist_ok=True)
    os.environ["CAIMAN_TEMP"] = str(temp_path)
    for key in THREAD_ENV_KEYS:
        os.environ.setdefault(key, "1")


def build_params_dict(cfg: omegaconf.DictConfig | dict[str, Any], movie_path: Path) -> dict[str, Any]:
    cfg_dict = _to_plain(cfg)
    if not isinstance(cfg_dict, dict):
        raise TypeError("Fit config must be a mapping.")

    payload: dict[str, Any] = {}
    for group in CNMFE_GROUPS:
        group_value = cfg_dict.get(group)
        if group_value is None:
            continue
        payload[group] = dict(group_value)

    data_group = dict(payload.get("data", {}))
    data_group["fnames"] = [str(movie_path)]
    payload["data"] = data_group

    return payload


def _install_skip_full_fov_ring_w_patch(cnmf_module: Any, *, enabled: bool) -> Any:
    """Keep patch initialization at ``gnb=0`` while skipping dense full-FOV W."""

    original_run_cnmf_patches = cnmf_module.run_CNMF_patches

    def wrapped_run_cnmf_patches(*args: Any, **kwargs: Any) -> Any:
        if enabled:
            kwargs["gnb"] = 0
            result = run_CNMF_patches_disk_backed(*args, **kwargs)
        else:
            result = original_run_cnmf_patches(*args, **kwargs)
        if enabled:
            print("[fit] skipped dense CaImAn W recomputation; streaming W will be attached")
        return result

    cnmf_module.run_CNMF_patches = wrapped_run_cnmf_patches
    return original_run_cnmf_patches


def _restore_run_cnmf_patches(cnmf_module: Any, original_run_cnmf_patches: Any) -> None:
    cnmf_module.run_CNMF_patches = original_run_cnmf_patches


def _needs_streaming_ring_w(cfg: omegaconf.DictConfig) -> bool:
    init = _to_plain(cfg.init)
    patch = _to_plain(cfg.patch)
    if not isinstance(init, dict) or not isinstance(patch, dict):
        return False
    return (
        patch.get("rf") is not None
        and int(patch.get("nb_patch", 0)) == 0
        and bool(init.get("center_psf", False))
        and int(init.get("nb", 1)) == 0
        and init.get("ring_size_factor") is not None
    )


def run(
    mmap_load_path: str | Path,
    y_save_path: str | Path,
    data: dict[str, Any] | omegaconf.DictConfig,
    patch: dict[str, Any] | omegaconf.DictConfig,
    init: dict[str, Any] | omegaconf.DictConfig,
    preprocess: dict[str, Any] | omegaconf.DictConfig,
    spatial: dict[str, Any] | omegaconf.DictConfig,
    temporal: dict[str, Any] | omegaconf.DictConfig,
    merging: dict[str, Any] | omegaconf.DictConfig,
    caiman_temp: str | None = None,
) -> Path:
    y_save_path = Path(y_save_path).expanduser()
    y_save_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = (
        Path(caiman_temp).expanduser().resolve()
        if caiman_temp
        else Path(f"{y_save_path}.temp").expanduser().resolve()
    )

    _set_runtime_env(temp_path)
    mmap_path = Path(mmap_load_path).expanduser()

    import caiman
    import caiman.cluster
    from caiman.source_extraction import cnmf
    import caiman.source_extraction.cnmf.cnmf as cnmf_impl
    from caiman.source_extraction.cnmf import params

    yr, dims, t = load_memmap_movie(mmap_path)
    images = np.reshape(yr.T, [int(t), *list(dims)], order="F")
    if not isinstance(images, np.memmap):
        raise RuntimeError(f"CaImAn movie view is not a memmap: {mmap_path}")

    cfg = omegaconf.OmegaConf.create(
        {
            "data": _to_plain(data),
            "patch": _to_plain(patch),
            "init": _to_plain(init),
            "preprocess": _to_plain(preprocess),
            "spatial": _to_plain(spatial),
            "temporal": _to_plain(temporal),
            "merging": _to_plain(merging),
        }
    )
    opts = params.CNMFParams(params_dict=build_params_dict(cfg, mmap_path))
    opts.change_params(params_dict={"dims": dims, "border_pix": 0})
    needs_streaming_ring_w = _needs_streaming_ring_w(cfg)
    if needs_streaming_ring_w:
        opts.set("init", {"nb": 1})

    dview = None
    original_run_cnmf_patches = None
    try:
        _, dview, actual_processes = caiman.cluster.setup_cluster(
            backend="multiprocessing",
            n_processes=None,
        )
        print(
            f"[fit] fit CNMF-E from {mmap_path}; "
            f"images={images.shape} n_processes={actual_processes} (CaImAn auto)"
        )
        cnm = cnmf.CNMF(n_processes=actual_processes, dview=dview, Ain=None, params=opts)
        original_run_cnmf_patches = _install_skip_full_fov_ring_w_patch(
            cnmf_impl,
            enabled=needs_streaming_ring_w,
        )
        cnm.fit(images)
        cnm.estimates.optional_outputs = {}
        if needs_streaming_ring_w:
            cnm.params.set("init", {"nb": 0})
        tmp_path = temp_path / f"{y_save_path.name}.fit.tmp.hdf5"
        if tmp_path.exists():
            tmp_path.unlink()
        cnm.save(str(tmp_path))
        os.replace(tmp_path, y_save_path)
        print(f"[fit] saved {y_save_path}")
    finally:
        if original_run_cnmf_patches is not None:
            _restore_run_cnmf_patches(cnmf_impl, original_run_cnmf_patches)
        if dview is not None:
            caiman.stop_server(dview=dview)
    return y_save_path
