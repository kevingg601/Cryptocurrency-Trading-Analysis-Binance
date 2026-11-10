"""Install the hash-pinned Linux training interpreter without changing the kernel."""
from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import subprocess
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path, PurePosixPath
from typing import Any, Callable


LOCK_PATH = Path(__file__).with_name("python-runtime.lock.json")
MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
MAX_UNPACKED_BYTES = 1024 * 1024 * 1024


def _read_lock(lock_path: Path = LOCK_PATH) -> dict[str, Any]:
    lock = json.loads(lock_path.read_text(encoding="utf-8"))
    if lock.get("schema") != 1 or lock.get("python_version") != "3.12.12":
        raise ValueError("Unsupported managed Python lock schema/version.")
    if lock.get("target") != "x86_64-unknown-linux-gnu":
        raise ValueError("Managed Python asset must target x86_64-unknown-linux-gnu.")
    digest = str(lock.get("sha256", ""))
    if len(digest) != 64 or any(char not in "0123456789abcdef" for char in digest):
        raise ValueError("Managed Python lock has an invalid SHA256.")
    url = str(lock.get("url", ""))
    if not url.startswith("https://github.com/astral-sh/python-build-standalone/releases/download/"):
        raise ValueError("Managed Python lock must use the pinned official HTTPS release URL.")
    filename = str(lock.get("archive", ""))
    if Path(filename).name != filename or not filename.endswith(".tar.gz"):
        raise ValueError("Managed Python lock has an invalid archive filename.")
    if not url.endswith(filename.replace("+", "%2B")):
        raise ValueError("Managed Python release URL and archive name disagree.")
    if lock.get("python_relative_path") != "python/bin/python3.12":
        raise ValueError("Managed Python archive layout is not the expected install-only layout.")
    return lock


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _archive_path(name: str) -> PurePosixPath:
    if not name or "\\" in name or name.startswith("/"):
        raise ValueError(f"Unsafe Python archive path: {name!r}")
    rel = PurePosixPath(name)
    if any(part in {"", ".", ".."} for part in rel.parts) or rel.parts[0] != "python":
        raise ValueError(f"Python archive member is outside the expected python/ root: {name!r}")
    if ":" in rel.parts[0]:
        raise ValueError(f"Unsafe Python archive path: {name!r}")
    return rel


def _resolve_link(member: PurePosixPath, target: str, *, hardlink: bool) -> PurePosixPath:
    if not target or "\\" in target or target.startswith("/"):
        raise ValueError(f"Unsafe absolute or malformed link in Python archive: {member} -> {target!r}")
    raw = PurePosixPath(target)
    if hardlink:
        base: list[str] = []
    else:
        base = list(member.parent.parts)
    for part in raw.parts:
        if part in {"", "."}:
            continue
        if part == "..":
            if not base:
                raise ValueError(f"Python archive link escapes its root: {member} -> {target!r}")
            base.pop()
        else:
            base.append(part)
    resolved = PurePosixPath(*base)
    if not resolved.parts or resolved.parts[0] != "python":
        raise ValueError(f"Python archive link escapes python/: {member} -> {target!r}")
    return resolved


def validate_archive_members(archive: tarfile.TarFile) -> list[tarfile.TarInfo]:
    """Validate the full tar namespace, including link targets and parent traversal."""
    members = archive.getmembers()
    by_name: dict[str, tarfile.TarInfo] = {}
    non_directory_paths: set[PurePosixPath] = set()
    total_size = 0
    for member in members:
        rel = _archive_path(member.name.rstrip("/") if member.isdir() else member.name)
        canonical_name = rel.as_posix()
        if canonical_name in by_name:
            raise ValueError(f"Duplicate Python archive member: {member.name!r}")
        if not (member.isfile() or member.isdir() or member.issym() or member.islnk()):
            raise ValueError(f"Unsupported special file in Python archive: {member.name!r}")
        if member.size < 0 or member.size > MAX_ARCHIVE_BYTES:
            raise ValueError(f"Invalid Python archive member size: {member.name!r}")
        total_size += member.size
        if total_size > MAX_UNPACKED_BYTES:
            raise ValueError("Managed Python archive exceeds the uncompressed size limit.")
        if member.issym():
            _resolve_link(rel, member.linkname, hardlink=False)
            non_directory_paths.add(rel)
        elif member.islnk():
            _resolve_link(rel, member.linkname, hardlink=True)
            non_directory_paths.add(rel)
        elif member.isfile():
            non_directory_paths.add(rel)
        by_name[canonical_name] = member

    for member in members:
        rel = _archive_path(member.name.rstrip("/") if member.isdir() else member.name)
        if any(PurePosixPath(*rel.parts[:index]) in non_directory_paths for index in range(1, len(rel.parts))):
            raise ValueError(f"Python archive member has a non-directory parent: {member.name!r}")
    return members


def _download(lock: dict[str, Any], cache_root: Path, *, progress: Callable[[str], None] | None) -> Path:
    cache_root.mkdir(parents=True, exist_ok=True)
    archive = cache_root / lock["archive"]
    expected_hash = lock["sha256"]
    if archive.is_file():
        if _sha256(archive) == expected_hash:
            return archive
        raise ValueError(f"Cached managed Python archive hash mismatch: {archive}")

    last_error: Exception | None = None
    for attempt in range(1, 4):
        part = cache_root / f".{lock['archive']}.{os.urandom(6).hex()}.part"
        try:
            request = urllib.request.Request(lock["url"], headers={"User-Agent": "fadachi-model-benchmark"})
            with urllib.request.urlopen(request, timeout=30) as response, part.open("wb") as output:
                total = 0
                while True:
                    chunk = response.read(1024 * 1024)
                    if not chunk:
                        break
                    total += len(chunk)
                    if total > MAX_ARCHIVE_BYTES:
                        raise ValueError("Managed Python archive exceeded the download size limit.")
                    output.write(chunk)
                    if progress and total % (8 * 1024 * 1024) < len(chunk):
                        progress(f"已下載固定 Python 資產 {total // (1024 * 1024)} MiB")
                output.flush()
                os.fsync(output.fileno())
            actual_hash = _sha256(part)
            if actual_hash != expected_hash:
                raise ValueError(f"Managed Python archive SHA256 mismatch: {actual_hash}")
            os.replace(part, archive)
            return archive
        except Exception as exc:
            last_error = exc
            part.unlink(missing_ok=True)
            if attempt < 3:
                if progress:
                    progress(f"Python 資產下載第 {attempt} 次失敗，稍後有限重試：{type(exc).__name__}: {exc}")
                time.sleep(min(2 ** (attempt - 1), 4))
    raise RuntimeError(f"Unable to obtain the pinned managed Python archive after 3 attempts: {last_error}")


def _probe_python(python: Path) -> str:
    completed = subprocess.run(
        [str(python), "-I", "-c", "import sys; print('.'.join(map(str, sys.version_info[:3])))"],
        check=True, capture_output=True, text=True, encoding="utf-8", timeout=30,
    )
    version = completed.stdout.strip().splitlines()[-1]
    if version != "3.12.12":
        raise RuntimeError(f"Managed training interpreter must be 3.12.12, got {version!r}")
    return version


def prepare_managed_python(
    install_root: Path,
    cache_root: Path,
    *,
    progress: Callable[[str], None] | None = None,
    lock_path: Path = LOCK_PATH,
) -> dict[str, Any]:
    """Download, verify, safely install and identify the pinned Linux CPython."""
    if platform.system() != "Linux" or platform.machine().lower() not in {"x86_64", "amd64"}:
        raise RuntimeError("Managed benchmark Python is pinned for Linux x86_64 Colab runtimes only.")
    lock = _read_lock(lock_path)
    install_root = install_root.resolve()
    python = install_root / PurePosixPath(lock["python_relative_path"])
    marker = install_root / ".managed-python.json"
    if marker.is_file() and python.is_file():
        existing = json.loads(marker.read_text(encoding="utf-8"))
        if existing.get("asset_sha256") == lock["sha256"] and existing.get("python_version") == lock["python_version"]:
            version = _probe_python(python)
            return {**existing, "python": str(python), "python_version": version, "reused": True}
    if install_root.exists():
        raise FileExistsError(f"Managed Python installation path already exists but is not a verified matching install: {install_root}")

    archive = _download(lock, cache_root, progress=progress)
    install_root.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{install_root.name}.install-", dir=install_root.parent))
    try:
        with tarfile.open(archive, mode="r:gz") as source:
            members = validate_archive_members(source)
            source.extractall(stage, members=members, filter="data")
        staged_python = stage / PurePosixPath(lock["python_relative_path"])
        if staged_python.is_symlink() or not staged_python.is_file():
            raise ValueError("Pinned Python archive does not contain a regular python/bin/python3.12 executable.")
        version = _probe_python(staged_python)
        record = {
            "schema": 1,
            "provider": lock["provider"],
            "release_tag": lock["release_tag"],
            "archive": lock["archive"],
            "archive_sha256": _sha256(archive),
            "asset_sha256": lock["sha256"],
            "python_version": version,
            "target": lock["target"],
            "python_relative_path": lock["python_relative_path"],
        }
        marker_temp = stage / ".managed-python.json.tmp"
        marker_temp.write_text(json.dumps(record, sort_keys=True, indent=2) + "\n", encoding="utf-8")
        os.replace(marker_temp, stage / ".managed-python.json")
        install_root.parent.mkdir(parents=True, exist_ok=True)
        os.replace(stage, install_root)
        stage = None  # type: ignore[assignment]
        python = install_root / PurePosixPath(lock["python_relative_path"])
        _probe_python(python)
        if progress:
            progress(f"固定訓練 Python 已準備：{python}")
        return {**record, "python": str(python), "reused": False}
    finally:
        if stage is not None and stage.exists():
            shutil.rmtree(stage)
