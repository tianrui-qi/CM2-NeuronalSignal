from __future__ import annotations

from pathlib import Path

from flask import Flask

from ..cache import validate_cache
from .app import create_flask_app as _create_flask_app


def create_app(*, web_dir: str | Path, cache_load_fold: str | Path) -> Flask:
    web_root = Path(web_dir).expanduser().resolve()
    cache_root = Path(cache_load_fold).expanduser().resolve()
    return _create_flask_app(
        import_name=__name__,
        root_path=str(Path(__file__).resolve().parent.parent),
        web_root=web_root,
        cache_root=cache_root,
        validate_cache_fn=validate_cache,
    )


def serve(
    *,
    web_dir: str | Path,
    cache_load_fold: str | Path,
    host: str = "127.0.0.1",
    port: int = 8765,
    debug: bool = False,
) -> None:
    cache_root = Path(cache_load_fold).expanduser().resolve()
    validate_cache(cache_root)
    app = create_app(web_dir=web_dir, cache_load_fold=cache_root)
    app.run(host=host, port=port, debug=debug)
