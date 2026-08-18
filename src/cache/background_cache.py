from __future__ import annotations

from pathlib import Path

from PIL import Image

from ..cnmfe.background import imagej_auto_contrast_uint8, imagej_bandpass, mean_std_projection_from_mmap

from .contract import BACKGROUND_DIRNAME


def _write_background_png(
    *,
    root: Path,
    file_name: str,
    image,
    key: str,
    label: str,
) -> dict[str, object]:
    output_path = root / BACKGROUND_DIRNAME / file_name
    Image.fromarray(imagej_auto_contrast_uint8(image), mode="L").save(output_path)
    return {
        "file": str(output_path.relative_to(root)).replace("\\", "/"),
        "key": key,
        "label": label,
    }


def write_background_cache(
    *,
    cache_save_fold: str | Path,
    mmap_load_path: str | Path,
    height: int,
    width: int,
    trace_length: int,
) -> list[dict[str, object]]:
    root = Path(cache_save_fold)
    (root / BACKGROUND_DIRNAME).mkdir(parents=True, exist_ok=True)

    source = Path(mmap_load_path).expanduser().resolve()
    mean_image, std_image = mean_std_projection_from_mmap(
        source,
        height=height,
        width=width,
        trace_length=trace_length,
    )
    bandpass_image = imagej_bandpass(std_image)

    return [
        _write_background_png(
            root=root,
            file_name="mean.png",
            image=mean_image,
            key="mean",
            label="Mean",
        ),
        _write_background_png(
            root=root,
            file_name="std.png",
            image=std_image,
            key="std",
            label="STD",
        ),
        _write_background_png(
            root=root,
            file_name="bandpass.png",
            image=bandpass_image,
            key="bandpass",
            label="STD + Bandpass",
        ),
    ]
