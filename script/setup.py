"""Download the links in config/setup.yaml into data/.

Run python -m script.setup from the repository root.
ZIPs become data/<category>/<zip name>/; other files keep their original
filenames. Existing third-level entries are skipped. Each link is
handled independently, with all conflicts and errors listed at the end.
"""

import base64
import json
import os
from pathlib import Path
import sys
import tempfile
from urllib.parse import quote, urlsplit
from urllib.request import Request, urlopen
import zipfile

import hydra
from tqdm import tqdm


TEMP_ROOT = Path("temp")
DATA_ROOT = Path("data")
RESOLVE_URL = (
    "https://ckdatabasews.icloud.com/database/1/"
    "com.apple.cloudkit/production/public/records/resolve"
)


def resolve(link: str) -> tuple[str, str, int]:
    share_id = urlsplit(link).path.rstrip("/").rsplit("/", 1)[-1]
    request = Request(
        RESOLVE_URL,
        data=json.dumps({"shortGUIDs": [{"value": share_id}]}).encode(),
        headers={"Content-Type": "application/json"},
    )
    with urlopen(request, timeout=30) as response:
        result = json.load(response)["results"][0]
    root = result.get("rootRecord", {})
    if result.get("requireAppleLogin") or root.get("recordType") != "content":
        raise ValueError("The link must share a public file, not an iCloud folder")

    fields = root["fields"]
    name = base64.b64decode(fields["encryptedBasename"]["value"]).decode("utf-8")
    extension = fields.get("extension", {}).get("value")
    if extension:
        name += f".{extension}"
    if name in ("", ".", "..") or any(char in name for char in "/\\:"):
        raise ValueError(f"Invalid filename: {name!r}")
    asset = fields["fileContent"]["value"]
    url = asset["downloadURL"].replace("${f}", quote(name, safe=""))
    return name, url, int(asset["size"])


def check_conflicts(paths: list[Path]) -> None:
    conflicts = [path for path in paths if path.exists() or path.is_symlink()]
    if conflicts:
        names = ", ".join(str(path) for path in conflicts)
        raise FileExistsError(f"already exists: {names}")


def download_file(url: str, destination: Path, size: int, *, description: str = "") -> None:
    written = 0
    with urlopen(url, timeout=30) as response, destination.open("xb") as output, tqdm(
        total=size,
        desc=description or destination.name,
        unit="MB",
        unit_scale=1e-6,
        file=sys.stdout,
        dynamic_ncols=True,
        bar_format="{l_bar}{bar}| {n:,.1f}/{total:,.1f} MB [{elapsed}<{remaining}, {rate_fmt}]",
    ) as progress:
        while chunk := response.read(8 * 1024 * 1024):
            output.write(chunk)
            written += len(chunk)
            progress.update(len(chunk))
    if written != size:
        raise OSError(f"incomplete download: {written:,}/{size:,} bytes")


def unzip(archive: Path, workspace: Path, model: str) -> Path:
    unpacked = workspace / "unpacked"
    unpacked.mkdir()
    with zipfile.ZipFile(archive) as zipped:
        members = [
            entry for entry in zipped.infolist()
            if "__MACOSX" not in Path(entry.filename).parts
            and Path(entry.filename).name != ".DS_Store"
        ]
        # Only constrain extraction to this new workspace; no cache-schema checks.
        for entry in members:
            target = (unpacked / entry.filename).resolve()
            if not target.is_relative_to(unpacked.resolve()):
                raise ValueError(f"ZIP path leaves its destination: {entry.filename}")
            if (entry.external_attr >> 16) & 0o170000 == 0o120000:
                raise ValueError(f"ZIP contains a symbolic link: {entry.filename}")
        zipped.extractall(unpacked, members=members)
    nested = unpacked / model
    return nested if nested.is_dir() else unpacked


@hydra.main(version_base=None, config_path="../config", config_name="setup")
def main(cfg) -> list[Path]:
    install = []
    warning = []
    categories = ("cache", "cnmfe", "raw")
    total = sum(len(cfg[f"{category}_link"]) for category in categories)
    current = 0

    for category in categories:
        links = cfg[f"{category}_link"]
        for index in range(len(links)):
            current += 1
            label = f"[{current}/{total}] [{category}_link:{index + 1}]"
            stage = "Resolve"
            try:
                name, url, size = resolve(links[index])
                label = f"[{current}/{total}] [{category}/{name}]"
                stage = "Check Conflict"
                folder = DATA_ROOT / category
                archive_or_file = folder / name
                target = archive_or_file
                is_zip = name.lower().endswith(".zip")
                if is_zip:
                    if name[:-4] in ("", ".", ".."):
                        raise ValueError("ZIP file must have a valid name")
                    target = folder / name[:-4]

                # The category directory may exist; only its immediate entries conflict.
                paths = [target, archive_or_file] if is_zip else [target]
                check_conflicts(paths)
                if DATA_ROOT.is_symlink() or folder.is_symlink() or TEMP_ROOT.is_symlink():
                    raise ValueError("Data and temporary directories must not be symbolic links")
                print(f"{label} Check Conflict: OK", flush=True)

                stage = "Download"
                TEMP_ROOT.mkdir(exist_ok=True)
                with tempfile.TemporaryDirectory(prefix="setup-", dir=TEMP_ROOT) as temporary:
                    workspace = Path(temporary)
                    downloaded = workspace / name
                    download_file(
                        url, downloaded, size,
                        description=f"{label} Download: {os.path.relpath(downloaded)}",
                    )
                    stage = "Install"
                    check_conflicts(paths)
                    folder.mkdir(parents=True, exist_ok=True)
                    # Exclusive publication: an existing file is never overwritten.
                    os.link(downloaded, archive_or_file)
                    source = downloaded
                    if is_zip:
                        source = unzip(archive_or_file, workspace, target.name)
                        target.mkdir()
                        for entry in source.iterdir():
                            entry.rename(target / entry.name)
                        archive_or_file.unlink()  # Remove only this successfully extracted ZIP.
                install.append(target)
                print(f"{label} Install: OK {os.path.relpath(source)} -> {target}", flush=True)
            except Exception as error:
                message = f"{label} {stage}: FAIL - {error}"
                print(message, flush=True)
                warning.append(message)

    print(f"Setup finished: {len(install)} installed, {len(warning)} warnings.")
    if warning:
        print("Warnings:")
        for warning in warning:
            print(f"  - {warning}")
    return install


if __name__ == "__main__": main()
