from __future__ import annotations

import argparse
import csv
import json
import logging
import os
from contextlib import contextmanager, redirect_stderr, redirect_stdout
from pathlib import Path
from typing import Any

import h5py
import numpy as np
import tifffile
from PIL import Image
from tqdm import tqdm


TRACE_SOURCE_FILES = {
    "c": "traces_c.float32.bin",
    "yra": "traces_yra.float32.bin",
    "c_plus_yra": "traces_c_plus_yra.float32.bin",
}
PROFILE_METRIC_KEYS = (
    "snr",
    "r_value",
    "bl",
    "lam",
    "neurons_sn",
    "g_0",
    "g_1",
    "t_peak",
    "t_half",
)
POINTS_FILE_NAME = "points.json"
METADATA_FILE_NAME = "metadata.json"
BACKGROUND_DIRNAME = "backgrounds"
BACKGROUND_CHUNK_FRAMES = 8


@contextmanager
def _silence_stdio():
    with open(os.devnull, "w", encoding="utf-8") as devnull:
        with redirect_stdout(devnull), redirect_stderr(devnull):
            yield


def _is_file(path: Path) -> bool:
    return path.is_file() and path.stat().st_size > 0


def _source_signature(path: Path) -> dict[str, object]:
    stat = path.stat()
    return {
        "path": str(path.resolve()),
        "mtime_ns": int(stat.st_mtime_ns),
        "size": int(stat.st_size),
    }


def _read_model_dims(model_path: Path, cnm: Any) -> tuple[int, int]:
    dims = getattr(cnm.estimates, "dims", None)
    if dims is None:
        dims = cnm.params.data.get("dims")
    if dims is None:
        with h5py.File(model_path, "r") as handle:
            if "dims" in handle:
                dims = handle["dims"][()]
            elif "params" in handle and "data" in handle["params"] and "dims" in handle["params"]["data"]:
                dims = handle["params"]["data"]["dims"][()]
    if dims is None:
        raise ValueError(f"Cannot infer model dimensions from {model_path}")
    dims_tuple = tuple(int(x) for x in np.asarray(dims).reshape(-1).tolist())
    if len(dims_tuple) < 2:
        raise ValueError(f"Expected 2D model dimensions, got {dims_tuple}")
    return int(dims_tuple[0]), int(dims_tuple[1])


def _frame_rate_hz(cnm: Any) -> float:
    for getter in (
        lambda: cnm.params.get("data", "fr"),
        lambda: cnm.params.data.get("fr"),
    ):
        try:
            value = getter()
            if value is not None:
                return float(value)
        except Exception:
            pass
    return 1.0


def _read_profile(profile_load_path: Path, n_components: int) -> tuple[list[dict[str, str]], tuple[str, ...]]:
    rows_by_index: dict[int, dict[str, str]] = {}
    with profile_load_path.open("r", newline="", encoding="utf-8") as handle:
        reader = csv.DictReader(handle)
        if reader.fieldnames is None:
            raise ValueError(f"Profile CSV has no header: {profile_load_path}")
        fieldnames = tuple(reader.fieldnames)
        if "component_index" not in fieldnames:
            raise ValueError(f"Profile CSV is missing component_index: {profile_load_path}")
        missing_fields = sorted(set(PROFILE_METRIC_KEYS) - set(fieldnames))
        if missing_fields:
            raise ValueError(f"Profile CSV is missing fields {missing_fields}: {profile_load_path}")
        for row in reader:
            rows_by_index[int(row["component_index"])] = row

    missing = [idx for idx in range(n_components) if idx not in rows_by_index]
    if missing:
        raise ValueError(
            f"Profile/model mismatch: profile is missing {len(missing)} rows; first={missing[:5]}"
        )
    metric_keys = tuple(key for key in PROFILE_METRIC_KEYS if key in fieldnames)
    return [rows_by_index[idx] for idx in range(n_components)], metric_keys


def _optional_component_vector(value: Any, n_components: int) -> np.ndarray | None:
    try:
        arr = np.asarray(value, dtype=np.float64)
    except (TypeError, ValueError):
        return None
    if arr.dtype == object:
        return None
    if arr.ndim == 0:
        if not np.isfinite(float(arr)):
            return None
        return np.full(n_components, float(arr), dtype=np.float64)
    arr = np.ravel(arr).astype(np.float64, copy=False)
    if arr.shape[0] != n_components or not np.any(np.isfinite(arr)):
        return None
    return arr


def _movie_tyx_from_tif(y_load_path: Path, h: int, w: int, trace_length: int | None = None) -> np.ndarray:
    movie = tifffile.memmap(y_load_path)
    if movie.ndim == 2:
        raise ValueError(f"Expected a time series movie, got 2D image: {y_load_path}")
    if movie.ndim != 3:
        raise ValueError(f"Expected a 3D movie, got shape {movie.shape}: {y_load_path}")
    if movie.shape[1:] == (h, w) and (trace_length is None or movie.shape[0] == trace_length):
        return movie
    if movie.shape[:2] == (h, w) and (trace_length is None or movie.shape[2] == trace_length):
        return np.moveaxis(movie, 2, 0)
    raise ValueError(f"Movie shape {movie.shape} does not match model dims {(h, w)}: {y_load_path}")


def _profile_from_model(
    *,
    cnm: Any,
    y_load_path: Path,
    h: int,
    w: int,
    n_components: int,
    trace_length: int,
    frame_rate_hz: float,
) -> tuple[list[dict[str, str]], tuple[str, ...]]:
    from src.qc import (
        _component_float_vector,
        _component_g_matrix,
        _component_timing_arrays,
        _evaluate_snr_r_values,
    )

    estimates = cnm.estimates
    snr = _optional_component_vector(getattr(estimates, "SNR_comp", None), n_components)
    r_value = _optional_component_vector(getattr(estimates, "r_values", None), n_components)
    if snr is None or r_value is None:
        print(f"[app] computing SNR/r_value from movie {y_load_path}")
        movie_tyx = _movie_tyx_from_tif(y_load_path, h=h, w=w, trace_length=trace_length)
        snr, r_value = _evaluate_snr_r_values(cnm, movie_tyx)

    g_matrix = _component_g_matrix(getattr(estimates, "g", None), n_components)
    bl = _component_float_vector(getattr(estimates, "bl", None), n_components)
    lam = _component_float_vector(getattr(estimates, "lam", None), n_components)
    neurons_sn = _component_float_vector(getattr(estimates, "neurons_sn", None), n_components)
    t_peak, t_half = _component_timing_arrays(g_matrix, dt_s=1.0 / float(frame_rate_hz))

    rows: list[dict[str, str]] = []
    for idx in range(n_components):
        row = {
            "snr": str(float(snr[idx])),
            "r_value": str(float(r_value[idx])),
            "bl": str(float(bl[idx])),
            "lam": str(float(lam[idx])),
            "neurons_sn": str(float(neurons_sn[idx])),
            "g_0": str(float(g_matrix[idx, 0])) if g_matrix.shape[1] > 0 else "nan",
            "g_1": str(float(g_matrix[idx, 1])) if g_matrix.shape[1] > 1 else "nan",
            "t_peak": str(float(t_peak[idx])),
            "t_half": str(float(t_half[idx])),
        }
        rows.append(row)
    return rows, PROFILE_METRIC_KEYS


def _json_float_or_none(value: object) -> float | None:
    try:
        scalar = float(value)
    except (TypeError, ValueError):
        return None
    if np.isfinite(scalar):
        return scalar
    return None


def _imagej_auto_contrast_to_uint8(image: np.ndarray, saturated_percent: float = 0.35) -> np.ndarray:
    arr = np.asarray(image, dtype=np.float32)
    finite = arr[np.isfinite(arr)]
    if finite.size == 0:
        return np.zeros(arr.shape, dtype=np.uint8)

    lo = float(np.percentile(finite, saturated_percent))
    hi = float(np.percentile(finite, 100.0 - saturated_percent))
    if not np.isfinite(lo) or not np.isfinite(hi) or hi <= lo:
        lo = float(np.min(finite))
        hi = float(np.max(finite))
    if not np.isfinite(lo) or not np.isfinite(hi) or hi <= lo:
        return np.zeros(arr.shape, dtype=np.uint8)

    scaled = np.clip((arr - lo) / (hi - lo), 0.0, 1.0)
    return np.round(scaled * 255.0).astype(np.uint8)


def _write_background_png(bg_load_path: Path, output_path: Path) -> dict[str, object]:
    image = tifffile.imread(bg_load_path)
    if image.ndim != 2:
        raise ValueError(f"Expected 2D background image, got {image.shape}: {bg_load_path}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    png_uint8 = _imagej_auto_contrast_to_uint8(image)
    Image.fromarray(png_uint8, mode="L").save(output_path)
    return {
        "file": str(output_path.relative_to(output_path.parent.parent)).replace("\\", "/"),
        "height": int(image.shape[0]),
        "width": int(image.shape[1]),
        "source_path": str(bg_load_path),
        "key": "background",
        "label": bg_load_path.name,
        "contrast_mode": "imagej_auto_0p35pct",
    }


def _std_projection_from_movie(movie_tyx: np.ndarray) -> np.ndarray:
    n_frames = int(movie_tyx.shape[0])
    h, w = int(movie_tyx.shape[1]), int(movie_tyx.shape[2])
    sum_image = np.zeros((h, w), dtype=np.float64)
    sumsq_image = np.zeros((h, w), dtype=np.float64)
    for start in tqdm(range(0, n_frames, BACKGROUND_CHUNK_FRAMES), desc="app(background)", dynamic_ncols=True):
        chunk = np.asarray(movie_tyx[start:start + BACKGROUND_CHUNK_FRAMES], dtype=np.float64)
        sum_image += chunk.sum(axis=0)
        sumsq_image += (chunk * chunk).sum(axis=0)
    mean = sum_image / max(n_frames, 1)
    variance = np.maximum(sumsq_image / max(n_frames, 1) - mean * mean, 0.0)
    return np.sqrt(variance).astype(np.float32)


def _write_background_png_from_y(
    y_load_path: Path,
    output_path: Path,
    *,
    h: int,
    w: int,
    trace_length: int,
) -> dict[str, object]:
    image_or_movie = tifffile.memmap(y_load_path)
    if image_or_movie.ndim == 2:
        image = np.asarray(image_or_movie)
    else:
        movie_tyx = _movie_tyx_from_tif(y_load_path, h=h, w=w, trace_length=trace_length)
        image = _std_projection_from_movie(movie_tyx)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    png_uint8 = _imagej_auto_contrast_to_uint8(image)
    Image.fromarray(png_uint8, mode="L").save(output_path)
    return {
        "file": str(output_path.relative_to(output_path.parent.parent)).replace("\\", "/"),
        "height": int(image.shape[0]),
        "width": int(image.shape[1]),
        "source_path": str(y_load_path),
        "key": "background",
        "label": f"{y_load_path.name} STD" if image_or_movie.ndim != 2 else y_load_path.name,
        "contrast_mode": "imagej_auto_0p35pct",
    }


def _existing_optional_path(path: Path | None) -> Path | None:
    if path is None:
        return None
    candidate = path.expanduser().resolve()
    return candidate if _is_file(candidate) else None


def _autodiscover_profile(model_load_path: Path, y_load_path: Path | None) -> Path | None:
    candidates = [
        model_load_path.parent / "qc" / "profile.csv",
    ]
    if y_load_path is not None:
        candidates.append(y_load_path.parent / "qc" / "profile.csv")
    for candidate in candidates:
        if _is_file(candidate):
            return candidate.resolve()
    return None


def _autodiscover_background(y_load_path: Path | None) -> Path | None:
    if y_load_path is None:
        return None
    for name in ("Ybandpass.tif", "Ystd.tif", "Ymean.tif"):
        candidate = y_load_path.parent / name
        if _is_file(candidate):
            return candidate.resolve()
    return None


def _component_peak_xy(A_csc: Any, component_index: int, h: int) -> tuple[int, int]:
    start = int(A_csc.indptr[component_index])
    end = int(A_csc.indptr[component_index + 1])
    if end <= start:
        return 0, 0
    data = A_csc.data[start:end]
    indices = A_csc.indices[start:end]
    flat_index = int(indices[int(np.argmax(data))])
    return int(flat_index // h), int(flat_index % h)


def _compute_trace_stats(traces: np.ndarray) -> dict[str, np.ndarray]:
    return {
        "mean": traces.mean(axis=1, dtype=np.float64).astype(np.float32),
        "std": traces.std(axis=1, dtype=np.float64).astype(np.float32),
        "p05": np.percentile(traces, 5.0, axis=1).astype(np.float32),
        "p95": np.percentile(traces, 95.0, axis=1).astype(np.float32),
    }


def _write_trace_cache(app_fold: Path, source_key: str, traces: np.ndarray) -> dict[str, dict[str, np.ndarray]]:
    traces = np.ascontiguousarray(traces, dtype=np.float32)
    traces.tofile(app_fold / TRACE_SOURCE_FILES[source_key])
    return {source_key: _compute_trace_stats(traces)}


def _load_cnmf(model_load_path: Path) -> Any:
    from caiman.source_extraction.cnmf.cnmf import load_CNMF

    with _silence_stdio():
        return load_CNMF(str(model_load_path), n_processes=1, dview=None)


def build_cache(
    *,
    model_load_path: Path,
    y_load_path: Path | None,
    app_fold: Path,
    bg_load_path: Path | None = None,
    profile_load_path: Path | None = None,
) -> None:
    model_load_path = model_load_path.expanduser().resolve()
    y_load_path = y_load_path.expanduser().resolve() if y_load_path is not None else None
    app_fold = app_fold.expanduser().resolve()
    profile_load_path = _existing_optional_path(profile_load_path)
    bg_load_path = _existing_optional_path(bg_load_path)

    if not _is_file(model_load_path):
        raise FileNotFoundError(f"Missing model file: {model_load_path}")
    if y_load_path is not None and not _is_file(y_load_path):
        raise FileNotFoundError(f"Missing movie file: {y_load_path}")

    logging.getLogger("caiman").setLevel(logging.WARNING)
    app_fold.mkdir(parents=True, exist_ok=True)
    (app_fold / BACKGROUND_DIRNAME).mkdir(parents=True, exist_ok=True)

    print(f"[app] loading model {model_load_path}")
    cnm = _load_cnmf(model_load_path)
    h, w = _read_model_dims(model_load_path, cnm)
    frame_rate_hz = _frame_rate_hz(cnm)

    A = cnm.estimates.A.tocsc()
    C = np.asarray(cnm.estimates.C, dtype=np.float32)
    if A.shape != (h * w, C.shape[0]):
        raise ValueError(f"A/C shape mismatch: A={A.shape}, C={C.shape}, dims={(h, w)}")
    n_components, trace_length = int(C.shape[0]), int(C.shape[1])
    if profile_load_path is None:
        profile_load_path = _autodiscover_profile(model_load_path, y_load_path)
    if profile_load_path is not None:
        print(f"[app] reading profile {profile_load_path}")
        rows, metric_keys = _read_profile(profile_load_path, n_components=n_components)
    else:
        if y_load_path is None:
            raise FileNotFoundError("Profile is missing; y_load_path is required to compute SNR/r_value.")
        rows, metric_keys = _profile_from_model(
            cnm=cnm,
            y_load_path=y_load_path,
            h=h,
            w=w,
            n_components=n_components,
            trace_length=trace_length,
            frame_rate_hz=frame_rate_hz,
        )

    print(f"[app] caching {n_components} neurons, {trace_length} frames")
    if bg_load_path is None:
        bg_load_path = _autodiscover_background(y_load_path)
    if bg_load_path is not None:
        background_spec = _write_background_png(
            bg_load_path,
            app_fold / BACKGROUND_DIRNAME / "background.png",
        )
    else:
        if y_load_path is None:
            raise FileNotFoundError("Background is missing; y_load_path is required to compute a background projection.")
        background_spec = _write_background_png_from_y(
            y_load_path,
            app_fold / BACKGROUND_DIRNAME / "background.png",
            h=h,
            w=w,
            trace_length=trace_length,
        )

    xs = np.zeros(n_components, dtype=np.int32)
    ys = np.zeros(n_components, dtype=np.int32)
    for idx in tqdm(range(n_components), desc="app(points)", dynamic_ncols=True):
        xs[idx], ys[idx] = _component_peak_xy(A, idx, h=h)

    YrA = getattr(cnm.estimates, "YrA", None)
    if YrA is None:
        YrA = np.zeros_like(C, dtype=np.float32)
    else:
        YrA = np.asarray(YrA, dtype=np.float32)
        if YrA.shape != C.shape:
            raise ValueError(f"YrA/C shape mismatch: YrA={YrA.shape}, C={C.shape}")

    trace_stats_by_source: dict[str, dict[str, np.ndarray]] = {}
    trace_stats_by_source.update(_write_trace_cache(app_fold, "c", C))
    trace_stats_by_source.update(_write_trace_cache(app_fold, "yra", YrA))
    c_plus_yra = C + YrA
    trace_stats_by_source.update(_write_trace_cache(app_fold, "c_plus_yra", c_plus_yra))

    points_payload = {
        "id": list(range(n_components)),
        "x": xs.astype(int).tolist(),
        "y": ys.astype(int).tolist(),
        "metrics": {
            key: [_json_float_or_none(row.get(key)) for row in rows]
            for key in metric_keys
        },
        "trace_stats": {
            source_key: {
                stat_key: [_json_float_or_none(v) for v in values]
                for stat_key, values in trace_stats.items()
            }
            for source_key, trace_stats in trace_stats_by_source.items()
        },
    }
    (app_fold / POINTS_FILE_NAME).write_text(
        json.dumps(points_payload, separators=(",", ":")),
        encoding="utf-8",
    )

    metadata = {
        "cache_version": 5,
        "model_load_path": str(model_load_path),
        "y_load_path": str(y_load_path) if y_load_path is not None else None,
        "profile_load_path": str(profile_load_path) if profile_load_path is not None else None,
        "bg_load_path": str(bg_load_path) if bg_load_path is not None else None,
        "app_fold": str(app_fold),
        "full_height": int(h),
        "full_width": int(w),
        "trace_length": trace_length,
        "frame_rate_hz": frame_rate_hz,
        "neuron_count": n_components,
        "metric_keys": list(metric_keys),
        "trace_sources": {
            "c": {
                "file": TRACE_SOURCE_FILES["c"],
                "label": "C",
                "description": "CNMF-E fitted temporal trace",
                "dtype": "float32",
            },
            "yra": {
                "file": TRACE_SOURCE_FILES["yra"],
                "label": "YrA",
                "description": "CNMF-E residual temporal trace",
                "dtype": "float32",
            },
            "c_plus_yra": {
                "file": TRACE_SOURCE_FILES["c_plus_yra"],
                "label": "C + YrA",
                "description": "CNMF-E fitted temporal trace plus YrA residual",
                "dtype": "float32",
            },
        },
        "points_file": POINTS_FILE_NAME,
        "backgrounds": [background_spec],
        "default_background_key": "background",
        "sources": {
            "model": _source_signature(model_load_path),
            **({"movie": _source_signature(y_load_path)} if y_load_path is not None else {}),
            **({"background": _source_signature(bg_load_path)} if bg_load_path is not None else {}),
            **({"profile": _source_signature(profile_load_path)} if profile_load_path is not None else {}),
        },
    }
    (app_fold / METADATA_FILE_NAME).write_text(json.dumps(metadata, indent=2), encoding="utf-8")
    print(f"[app] cache ready: {app_fold}")


def main() -> None:
    parser = argparse.ArgumentParser(description="Build cache files for the CM2 neuron web app.")
    parser.add_argument("--model_load_path", type=Path, required=True)
    parser.add_argument("--y_load_path", type=Path, default=None)
    parser.add_argument("--bg_load_path", type=Path, default=None)
    parser.add_argument("--profile_load_path", type=Path, default=None)
    parser.add_argument("--app_fold", type=Path, required=True)
    args = parser.parse_args()

    logging.basicConfig(level=logging.WARNING, format="%(message)s")
    build_cache(
        model_load_path=args.model_load_path,
        y_load_path=args.y_load_path,
        app_fold=args.app_fold,
        bg_load_path=args.bg_load_path,
        profile_load_path=args.profile_load_path,
    )


if __name__ == "__main__":
    main()
