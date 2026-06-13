import os

THREAD_ENV_KEYS = (
    "OMP_NUM_THREADS",
    "OPENBLAS_NUM_THREADS",
    "MKL_NUM_THREADS",
    "NUMEXPR_NUM_THREADS",
    "VECLIB_MAXIMUM_THREADS",
)


def _set_default_math_threads() -> None:
    for key in THREAD_ENV_KEYS:
        os.environ.setdefault(key, "1")


_set_default_math_threads()

import shutil
import subprocess
import sys
from pathlib import Path

import hydra
import omegaconf

from src.cnmfe import attach_w
from src.cnmfe import fit


PHASE_ENV = "CM2_CNMFE_PHASE"


def _temp_dir_for(cnmfe_save_path: str) -> Path:
    return Path(f"{Path(cnmfe_save_path).expanduser()}.temp")


def _phase_command(overrides: list[str]) -> list[str]:
    return [sys.executable, "-u", "-B", "-m", "script.cnmfe", *overrides]


def _run_phase(phase: str, overrides: list[str]) -> None:
    env = os.environ.copy()
    env[PHASE_ENV] = phase
    subprocess.run(
        _phase_command(overrides),
        check=True,
        env=env,
    )


@hydra.main(version_base=None, config_path="../config", config_name="cnmfe")
def main(cfg: omegaconf.DictConfig) -> None:
    omegaconf.OmegaConf.resolve(cfg)

    temp_dir = _temp_dir_for(str(cfg.cnmfe_save_path))
    phase = os.environ.get(PHASE_ENV)
    if phase is None:
        overrides = sys.argv[1:]
        if temp_dir.exists():
            shutil.rmtree(temp_dir)
        temp_dir.mkdir(parents=True, exist_ok=True)
        try:
            _run_phase("fit", overrides)
            _run_phase("attach_w", overrides)
        except Exception:
            print(f"[cnmfe] failed; preserved temp directory {temp_dir}", flush=True)
            raise
        shutil.rmtree(temp_dir)
        return

    temp_dir.mkdir(parents=True, exist_ok=True)
    params = cfg.params
    if phase == "fit":
        fit.run(
            mmap_load_path=cfg.mmap_load_path,
            y_save_path=cfg.cnmfe_save_path,
            data=params.data,
            patch=params.patch,
            init=params.init,
            preprocess=params.preprocess,
            spatial=params.spatial,
            temporal=params.temporal,
            merging=params.merging,
            caiman_temp=str(temp_dir),
        )
    elif phase == "attach_w":
        attach_w.run(
            mmap_load_path=cfg.mmap_load_path,
            cnmfe_load_path=cfg.cnmfe_save_path,
            init=omegaconf.OmegaConf.to_container(params.init, resolve=True),
            caiman_temp=str(temp_dir),
        )
    else:
        raise ValueError(f"Unknown {PHASE_ENV}={phase!r}")


if __name__ == "__main__": main()
