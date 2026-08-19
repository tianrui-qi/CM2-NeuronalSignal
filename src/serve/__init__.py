from __future__ import annotations

import ipaddress
from pathlib import Path

from flask import Flask

from ..cache import validate_cache
from .app import create_flask_app as _create_flask_app


_REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
_READ_ONLY_DATA_ROOTS = tuple(
    (_REPOSITORY_ROOT / "data" / name).resolve()
    for name in ("raw", "mmap", "cnmfe")
)


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _validate_serve_path(*, serve_path: Path, cache_root: Path) -> None:
    if serve_path.suffix.casefold() != ".json":
        raise ValueError("serve_path must name a .json file.")
    if _is_relative_to(serve_path, cache_root):
        raise ValueError("serve_path must not be located inside cache_load_fold.")
    for read_only_root in _READ_ONLY_DATA_ROOTS:
        if _is_relative_to(serve_path, read_only_root):
            raise ValueError(
                f"serve_path must not be located inside read-only {read_only_root}."
            )


def _is_loopback_host(host: str) -> bool:
    if host.casefold() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def create_app(
    *,
    web_dir: str | Path,
    cache_load_fold: str | Path,
    serve_path: str | Path,
    edit_default: bool = False,
    host: str = "127.0.0.1",
) -> Flask:
    if edit_default and not _is_loopback_host(host):
        raise ValueError("edit_default=true requires a loopback host.")
    web_root = Path(web_dir).expanduser().resolve()
    cache_root = Path(cache_load_fold).expanduser().resolve()
    default_profile_path = Path(serve_path).expanduser().resolve()
    _validate_serve_path(serve_path=default_profile_path, cache_root=cache_root)
    return _create_flask_app(
        import_name=__name__,
        root_path=str(Path(__file__).resolve().parent.parent),
        web_root=web_root,
        cache_root=cache_root,
        serve_path=default_profile_path,
        edit_default=edit_default,
        validate_cache_fn=validate_cache,
    )


def serve(
    *,
    web_dir: str | Path,
    cache_load_fold: str | Path,
    serve_path: str | Path,
    edit_default: bool = False,
    host: str = "127.0.0.1",
    port: int = 8765,
    debug: bool = False,
) -> None:
    cache_root = Path(cache_load_fold).expanduser().resolve()
    validate_cache(cache_root)
    app = create_app(
        web_dir=web_dir,
        cache_load_fold=cache_root,
        serve_path=serve_path,
        edit_default=edit_default,
        host=host,
    )
    app.run(host=host, port=port, debug=debug)
