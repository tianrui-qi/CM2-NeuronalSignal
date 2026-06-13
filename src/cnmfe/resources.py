from __future__ import annotations

import os
from dataclasses import dataclass
from typing import Any

import numpy as np
from skimage.morphology import disk


BYTES_PER_GIB = 1024**3


@dataclass(frozen=True)
class HardwareResources:
    logical_cpu: int
    physical_cpu: int | None
    total_memory_gib: float
    available_memory_gib: float


@dataclass(frozen=True)
class AutoDecision:
    value: int
    reason: str


def detect_hardware() -> HardwareResources:
    logical_cpu = os.cpu_count() or 1
    physical_cpu: int | None = None
    total_memory = 0
    available_memory = 0

    try:
        import psutil

        physical_cpu = psutil.cpu_count(logical=False)
        logical_cpu = psutil.cpu_count(logical=True) or logical_cpu
        memory = psutil.virtual_memory()
        total_memory = int(memory.total)
        available_memory = int(memory.available)
    except Exception:
        pass

    if total_memory <= 0:
        total_memory = 16 * BYTES_PER_GIB
    if available_memory <= 0:
        available_memory = max(total_memory // 2, 1)

    return HardwareResources(
        logical_cpu=int(logical_cpu),
        physical_cpu=int(physical_cpu) if physical_cpu else None,
        total_memory_gib=total_memory / BYTES_PER_GIB,
        available_memory_gib=available_memory / BYTES_PER_GIB,
    )


def _is_auto(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return value.strip().lower() in {"", "auto"}
    return False


def _ring_count(radius: float, ssub: int) -> int:
    scaled_radius = int(round(float(radius) / float(ssub)))
    ring = disk(scaled_radius + 1)
    ring[1:-1, 1:-1] -= disk(scaled_radius)
    return int(np.count_nonzero(ring))


def _ring_batch_bytes(batch_size: int, *, frames: int, ring_pixels: int) -> float:
    return float(batch_size) * float(ring_pixels) * float(frames) * np.dtype(np.float32).itemsize


def resolve_ring_pixel_batch_size(
    value: Any,
    *,
    frames: int,
    radius: float,
    ssub: int,
) -> AutoDecision:
    if not _is_auto(value):
        return AutoDecision(
            value=max(1, int(value)),
            reason=f"explicit W pixel batch size={int(value)}",
        )

    hardware = detect_hardware()
    ring_pixels = _ring_count(radius=radius, ssub=ssub)
    candidates = (512, 1024, 2048, 4096, 8192, 16384)
    budget_gib = max(1.0, min(16.0, hardware.available_memory_gib * 0.30))
    budget_bytes = budget_gib * BYTES_PER_GIB
    chosen = candidates[0]

    for candidate in candidates:
        neighbor_bytes = _ring_batch_bytes(candidate, frames=frames, ring_pixels=ring_pixels)
        estimated_peak_bytes = neighbor_bytes * 2.0
        if estimated_peak_bytes <= budget_bytes:
            chosen = candidate

    return AutoDecision(
        value=chosen,
        reason=(
            "auto W pixel batch size="
            f"{chosen} (cpu, available_memory={hardware.available_memory_gib:.1f}GiB, "
            f"budget={budget_gib:.1f}GiB, ring_pixels={ring_pixels}, frames={frames})"
        ),
    )
