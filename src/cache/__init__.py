"""Public facade for viewer-cache construction and validation."""

from __future__ import annotations

from pathlib import Path

from .contract import validate_cache


def build_cache(
    *,
    mmap_load_path: str | Path,
    cnmfe_load_path: str | Path,
    cache_save_fold: str | Path,
) -> Path:
    """Build a cache through the existing implementation without eager heavy imports."""

    from .builder import build_cache as _build_cache

    return _build_cache(
        mmap_load_path=mmap_load_path,
        cnmfe_load_path=cnmfe_load_path,
        cache_save_fold=cache_save_fold,
    )


__all__ = [
    "build_cache",
    "validate_cache",
]
