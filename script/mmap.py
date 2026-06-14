"""TIFF to CaImAn mmap writer.

Profiling note from 2026-06-13 on the development workstation:

- Hardware context: Intel i9-13900KF, 64 GiB RAM, DDR5 configured at
  4800 MT/s.
- The measured throughput is end-to-end writer throughput, not pure memory
  bandwidth: it includes TIFF/Zarr reads, float32 conversion, transpose,
  file writes, flush/fsync, and OS caching behavior.

- Input movie: ``data/raw/Y.tif`` with TYX shape ``(1788, 2692, 3548)``.
- Writer layout: CaImAn-compatible float32 mmap with rows ordered as
  pixels x frames. Output filename encodes ``d1/d2/d3/order/frames`` so
  CaImAn can recover shape directly from the name.
- Algorithm: stream the TIFF by column blocks, add a tiny positive
  offset, transpose each block to pixel-major order, and write into the
  final row offsets. This avoids materializing the full movie in Python.
- The earlier writable-numpy-memmap prototype grew to about 5 GiB RSS in
  the first few minutes and was stopped. The direct file writer keeps memory
  tied to the current column block instead.

Block-size profile used full frames + full height + first 96 columns:

    write_block_mib | columns/block | time_s | throughput_mib_s | peak_rss_gib
    32              | 1             | 8.855  | 199.1            | 0.979
    64              | 3             | 6.119  | 288.0            | 1.051
    128             | 6             | 5.915  | 298.0            | 1.159
    256             | 13            | 6.274  | 281.0            | 1.410
    512             | 27            | 6.602  | 267.0            | 1.912
    1024            | 55            | 6.467  | 272.5            | 2.916
    2048            | 96            | 8.546  | 206.2            | 4.386

The slice benchmark favored 128 MiB blocks: near-best throughput with much
lower peak RSS than larger blocks. A full production run observed with
256 MiB blocks wrote 273 blocks in about 50 min 31 s, with total script time
about 54 min 18 s. The slice extrapolation is therefore useful for comparing
block sizes, but not reliable as an absolute full-movie runtime estimate.
"""


import hydra
import omegaconf

from src import mmap


@hydra.main(version_base=None, config_path="../config", config_name="mmap")
def main(cfg: omegaconf.DictConfig) -> None:
    mmap.run(**cfg)


if __name__ == "__main__": main()
