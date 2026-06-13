from __future__ import annotations

from pathlib import Path


CACHE_VERSION = 7
POINTS_FILE_NAME = "points.json"
METADATA_FILE_NAME = "metadata.json"
BACKGROUND_DIRNAME = "backgrounds"


def source_signature(path: str | Path) -> dict[str, object]:
    resolved = Path(path).expanduser().resolve()
    stat = resolved.stat()
    return {
        "path": str(resolved),
        "mtime_ns": int(stat.st_mtime_ns),
        "size": int(stat.st_size),
    }
