from __future__ import annotations

from typing import Any


def run_app(*args: Any, **kwargs: Any) -> None:
    from .runtime import run_app as _run_app

    _run_app(*args, **kwargs)


__all__ = ["run_app"]
