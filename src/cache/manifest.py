from __future__ import annotations

from pathlib import Path


CACHE_VERSION = 11
POINTS_FILE_NAME = "points.json"
METADATA_FILE_NAME = "metadata.json"
BACKGROUND_DIRNAME = "backgrounds"
TRACE_SOURCE_FILES = {
    "c": "traces_c.float32.bin",
    "c_plus_yra": "traces_c_plus_yra.float32.bin",
    "ybg_projection": "traces_ybg_projection.float32.bin",
}


def source_signature(path: str | Path) -> dict[str, object]:
    resolved = Path(path).expanduser().resolve()
    stat = resolved.stat()
    return {
        "path": str(resolved),
        "mtime_ns": int(stat.st_mtime_ns),
        "size": int(stat.st_size),
    }
