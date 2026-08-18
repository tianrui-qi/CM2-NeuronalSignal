"""Rollback-safe publication for a fully built and validated cache directory."""

from __future__ import annotations

from dataclasses import dataclass
import logging
import os
from pathlib import Path
import shutil
from typing import Callable, Iterable
from uuid import uuid4

from .contract import validate_cache


BuildDirectory = Callable[[Path], object]
ValidateDirectory = Callable[[Path], None]


class CachePublishError(RuntimeError):
    """Raised when a cache publication cannot complete normally."""


class CacheRollbackError(CachePublishError):
    """Raised when both promotion and automatic restoration fail."""


@dataclass(frozen=True, slots=True)
class _PublishWorkspace:
    target: Path
    token: str
    staging: Path
    backup: Path


def _path_exists(path: Path) -> bool:
    """Return true for regular paths and broken symlinks."""

    return path.exists() or path.is_symlink()


def _resolve_target(target: str | Path) -> Path:
    requested = Path(target).expanduser()
    if requested.is_symlink():
        raise ValueError(f"Refusing to publish through a symlink target: {requested}")
    resolved = requested.resolve()
    if resolved.parent == resolved or not resolved.name:
        raise ValueError(f"Refusing to publish a cache at a filesystem root: {resolved}")
    if _path_exists(resolved) and not resolved.is_dir():
        raise NotADirectoryError(f"Cache publish target is not a directory: {resolved}")
    return resolved


def _assert_not_ancestor_of_inputs(target: Path, protected_inputs: Iterable[str | Path]) -> None:
    for protected_input in protected_inputs:
        protected = Path(protected_input).expanduser().resolve()
        if protected == target or target in protected.parents:
            raise ValueError(
                f"Refusing to publish cache {target}; it contains protected input {protected}"
            )


def _assert_replaceable_target(target: Path) -> None:
    """Reject non-cache content before it can be moved and recursively cleaned."""

    if not _path_exists(target):
        return
    if target.is_symlink() or not target.is_dir():
        raise ValueError(f"Cache publish target is not a replaceable directory: {target}")
    try:
        next(target.iterdir())
    except StopIteration:
        return

    try:
        validate_cache(target)
    except (FileNotFoundError, OSError, UnicodeError, ValueError) as error:
        raise ValueError(f"Existing target is not a recognizable CM2 cache: {target}") from error


def _new_workspace(target: Path) -> _PublishWorkspace:
    """Reserve publisher-owned sibling names on the target filesystem."""

    for _ in range(100):
        token = uuid4().hex
        prefix = f".{target.name}.cm2-publish-{token}"
        staging = target.parent / f"{prefix}.staging"
        backup = target.parent / f"{prefix}.backup"
        if not _path_exists(staging) and not _path_exists(backup):
            return _PublishWorkspace(
                target=target,
                token=token,
                staging=staging,
                backup=backup,
            )
    raise CachePublishError(f"Could not allocate a cache publish workspace beside {target}")


def _assert_no_unresolved_workspaces(target: Path) -> None:
    prefix = f".{target.name}.cm2-publish-"
    unresolved = sorted(
        (
            path
            for path in target.parent.iterdir()
            if path.name.startswith(prefix)
            and (path.name.endswith(".staging") or path.name.endswith(".backup"))
        ),
        key=lambda path: path.name,
    )
    if unresolved:
        paths = ", ".join(str(path) for path in unresolved)
        raise CachePublishError(
            f"Unresolved cache publication paths require manual recovery before publishing: {paths}"
        )


def _assert_owned_workspace_path(workspace: _PublishWorkspace, path: Path) -> None:
    prefix = f".{workspace.target.name}.cm2-publish-{workspace.token}"
    allowed = {
        workspace.target.parent / f"{prefix}.staging",
        workspace.target.parent / f"{prefix}.backup",
    }
    if path not in allowed or path.parent != workspace.target.parent:
        raise CachePublishError(f"Refusing to clean a path not owned by this publication: {path}")


def _remove_owned_path(workspace: _PublishWorkspace, path: Path) -> None:
    _assert_owned_workspace_path(workspace, path)
    if not _path_exists(path):
        return
    if path.is_symlink() or not path.is_dir():
        path.unlink()
        return
    shutil.rmtree(path)


def _move_directory(source: Path, destination: Path) -> None:
    """Atomically rename one directory within a filesystem."""

    os.replace(source, destination)


def _promote(workspace: _PublishWorkspace) -> None:
    target_existed = _path_exists(workspace.target)
    try:
        if target_existed:
            _assert_replaceable_target(workspace.target)
            _move_directory(workspace.target, workspace.backup)
        _move_directory(workspace.staging, workspace.target)
    except BaseException as promotion_error:
        if not target_existed or not _path_exists(workspace.backup):
            raise
        if _path_exists(workspace.target):
            message = (
                "Cache promotion was interrupted after the validated cache became current; "
                f"the previous cache is retained at {workspace.backup}"
            )
            if isinstance(promotion_error, (KeyboardInterrupt, SystemExit)):
                logging.getLogger(__name__).warning(message)
                raise
            raise CachePublishError(message) from promotion_error
        try:
            _move_directory(workspace.backup, workspace.target)
        except BaseException as rollback_error:
            raise CacheRollbackError(
                "Cache promotion and rollback both failed; manual recovery required. "
                f"target={workspace.target}, previous={workspace.backup}, "
                f"validated_staging={workspace.staging}, "
                f"promotion_error={promotion_error!r}"
            ) from rollback_error
        if isinstance(promotion_error, (KeyboardInterrupt, SystemExit)):
            raise
        raise CachePublishError(
            f"Cache promotion failed; restored the previous cache at {workspace.target}"
        ) from promotion_error

    if target_existed:
        try:
            _remove_owned_path(workspace, workspace.backup)
        except OSError:
            logging.getLogger(__name__).warning(
                "Published cache at %s but could not remove old backup %s",
                workspace.target,
                workspace.backup,
                exc_info=True,
            )


def publish_cache_directory(
    target: str | Path,
    *,
    build: BuildDirectory,
    validate: ValidateDirectory = validate_cache,
    protected_inputs: Iterable[str | Path] = (),
) -> Path:
    """Build beside ``target``, validate, then promote with rollback protection.

    The target is untouched while ``build`` and ``validate`` run. Staging and
    backup directories are unique siblings, so directory moves stay on the same
    filesystem. Replacing an existing cache remains a full replacement: files
    from the old directory are not copied into the new cache. The two directory
    moves are exception-rollback-safe, not a crash-atomic directory exchange.
    """

    resolved_target = _resolve_target(target)
    _assert_not_ancestor_of_inputs(resolved_target, protected_inputs)
    _assert_replaceable_target(resolved_target)
    resolved_target.parent.mkdir(parents=True, exist_ok=True)
    _assert_no_unresolved_workspaces(resolved_target)
    workspace = _new_workspace(resolved_target)
    workspace.staging.mkdir()

    try:
        build(workspace.staging)
        if not workspace.staging.is_dir() or workspace.staging.is_symlink():
            raise CachePublishError(
                f"Cache builder replaced its staging directory: {workspace.staging}"
            )
        validate(workspace.staging)
        _promote(workspace)
    except CacheRollbackError:
        # Both candidates are intentionally retained for explicit recovery.
        raise
    except BaseException:
        if _path_exists(workspace.staging):
            try:
                _remove_owned_path(workspace, workspace.staging)
            except Exception:
                logging.getLogger(__name__).warning(
                    "Cache publication failed and staging cleanup also failed; "
                    "the original error is preserved and staging remains at %s",
                    workspace.staging,
                    exc_info=True,
                )
        raise

    return resolved_target
