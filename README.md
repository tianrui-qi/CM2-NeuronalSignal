# CM2

CM2 is a research project for building CaImAn/CNMF-E outputs and inspecting fitted neurons in a browser.

## Layout

```text
config/       Runtime configs for mmap, CNMF-E fitting, cache building, and serving.
script/       User-facing command entry points.
src/mmap.py   Raw TIFF -> CaImAn encoded mmap.
src/cnmfe/    CNMF-E fitting and analysis-friendly hdf5 helpers.
src/cache/    Viewer cache builder; writes data/cache/<model_id>/.
src/serve/    Flask server for web/ and a selected cache folder.
web/          Browser frontend.
data/raw/     Raw input boundary.
data/mmap/    CaImAn encoded mmap files.
data/cnmfe/   CNMF-E hdf5 models and CaImAn temp folders.
data/cache/   Browser cache artifacts by model id.
data/serve/   User-created viewer outputs by model id.
```

## Commands

From the repo root, activate `cm2` and run the module entry points:

```powershell
conda activate cm2
python -m script.mmap
python -m script.cnmfe
python -m script.cache
python -m script.serve
```

`script/serve.py` only serves existing cache files. Rebuild cache explicitly with `script/cache.py`.
Cache building, validation, serving, and the browser share one strict,
unversioned scientific contract.

For repository-wide instructions, see `AGENTS.md`. For viewer internals and
manual browser checks, continue with `web/AGENTS.md`.
