from __future__ import annotations

from pathlib import Path

from PIL import Image

from ..cnmfe.background import imagej_auto_contrast_uint8, imagej_bandpass, mean_std_projection_from_mmap

from .manifest import BACKGROUND_DIRNAME


def _write_background_png(
    *,
    root: Path,
    file_name: str,
    image,
    source: Path,
    key: str,
    label: str,
    transform: str,
) -> dict[str, object]:
    output_path = root / BACKGROUND_DIRNAME / file_name
    Image.fromarray(imagej_auto_contrast_uint8(image), mode="L").save(output_path)
    return {
        "file": str(output_path.relative_to(root)).replace("\\", "/"),
        "height": int(image.shape[0]),
        "width": int(image.shape[1]),
        "source_path": str(source),
        "key": key,
        "label": label,
        "transform": transform,
        "contrast_mode": "imagej_auto_0p35pct",
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
            source=source,
            key="mean",
            label="Mean",
            transform="mean_projection",
        ),
        _write_background_png(
            root=root,
            file_name="std.png",
            image=std_image,
            source=source,
            key="std",
            label="STD",
            transform="std_projection",
        ),
        _write_background_png(
            root=root,
            file_name="bandpass.png",
            image=bandpass_image,
            source=source,
            key="bandpass",
            label="STD + Bandpass",
            transform="std_projection_imagej_bandpass",
        ),
    ]
