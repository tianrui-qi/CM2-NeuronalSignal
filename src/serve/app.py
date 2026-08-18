from __future__ import annotations

from collections.abc import Callable
from pathlib import Path

from flask import Flask

from .cache_routes import register_cache_file_route, register_health_route
from .static_routes import register_static_routes, register_vendor_route
from .ui_state_routes import register_ui_state_routes


def create_flask_app(
    *,
    import_name: str,
    root_path: str | Path,
    web_root: Path,
    cache_root: Path,
    validate_cache_fn: Callable[[Path], None],
) -> Flask:
    app = Flask(
        import_name,
        static_folder=None,
        root_path=str(root_path),
    )

    register_static_routes(app=app, web_root=web_root)
    register_cache_file_route(app=app, cache_root=cache_root)
    register_ui_state_routes(app=app, cache_root=cache_root)
    register_vendor_route(app=app)
    register_health_route(
        app=app,
        cache_root=cache_root,
        validate_cache_fn=validate_cache_fn,
    )

    return app
