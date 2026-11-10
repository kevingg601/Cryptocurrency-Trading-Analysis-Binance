"""Persist download caches, never installed virtual environments, to Drive."""
from __future__ import annotations

import hashlib
import json
import os
import platform
import shutil
import tempfile
import uuid
import zipfile
from pathlib import Path, PurePosixPath

from .common import atomic_json, hash_file

CATEGORIES = ("python", "wheels", "models")


def cache_identity(repo: Path) -> str:
    root = repo / "research/model_benchmark"
    names = ["python-runtime.lock.json", "model-assets.lock.json"]
    names += [f"requirements-{name}.linux.lock.txt" for name in ("rank", "chronos", "timesfm")]
    record = {name: hash_file(root / name) for name in names}
    record.update(schema=1, system=platform.system(), machine=platform.machine().lower())
    return hashlib.sha256(json.dumps(record, sort_keys=True).encode()).hexdigest()[:24]


def restore_cache(local: Path, drive: Path, identity: str) -> None:
    """One archive per category avoids loading thousands of files over Drive."""
    root = drive / "cache" / identity
    for category in CATEGORIES:
        marker = root / f"{category}.json"
        if not marker.is_file():
            print(f"Drive cache {category}: first use / no committed cache", flush=True)
            continue
        record = json.loads(marker.read_text(encoding="utf-8"))
        name = record.get("archive", "")
        if record.get("identity") != identity or not name.startswith(category + "-") or Path(name).name != name or "/" in name or "\\" in name:
            raise ValueError("invalid Drive cache marker")
        source = root / name
        print(f"Restoring Drive cache: {category}", flush=True)
        # Work with a local archive after one sequential copy from Drive.
        local.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=local) as tmp:
            archive = Path(tmp) / "cache.zip"
            shutil.copyfile(source, archive)
            if hash_file(archive) != record["sha256"]:
                raise ValueError(f"Drive cache hash mismatch: {category}; original cache preserved")
            with zipfile.ZipFile(archive) as z:
                members = z.infolist()
                names = set()
                for info in members:
                    rel = PurePosixPath(info.filename)
                    if rel.is_absolute() or ".." in rel.parts or "\\" in info.filename or ":" in info.filename or not rel.parts or rel.parts[0] != category or info.filename in names:
                        raise ValueError("unsafe or duplicate cache archive member")
                    names.add(info.filename)
                for info in members:
                    target = local.joinpath(*PurePosixPath(info.filename).parts)
                    target.resolve().relative_to(local.resolve())
                    if target.is_symlink():
                        raise ValueError("cache restore target is symbolic link")
                    target.parent.mkdir(parents=True, exist_ok=True)
                    # Local cache is disposable; archive/marker on Drive remain unchanged.
                    part = target.with_name(target.name + ".restore-" + uuid.uuid4().hex)
                    try:
                        with z.open(info) as inp, part.open("xb") as out:
                            shutil.copyfileobj(inp, out)
                        os.replace(part, target)
                    finally:
                        part.unlink(missing_ok=True)
            print(f"Drive cache restored: {category} ({len(members)} files)", flush=True)


def save_cache(local: Path, drive: Path, identity: str) -> None:
    root = drive / "cache" / identity
    root.mkdir(parents=True, exist_ok=True)
    for category in CATEGORIES:
        directory = local / category
        if not directory.is_dir():
            continue
        files = sorted(p for p in directory.rglob("*") if p.is_file() and not p.is_symlink()
                       and ".cache" not in p.relative_to(directory).parts
                       and not p.name.endswith((".part", ".incomplete", ".lock")))
        if not files:
            continue
        print(f"Checking Drive cache inventory: {category} ({len(files)} files)", flush=True)
        marker = root / f"{category}.json"
        # Hash the content inventory, excluding timestamps, to avoid duplicate uploads.
        inventory = {p.relative_to(local).as_posix(): hash_file(p) for p in files}
        content_hash = hashlib.sha256(json.dumps(inventory, sort_keys=True).encode()).hexdigest()
        if marker.is_file():
            old = json.loads(marker.read_text(encoding="utf-8"))
            if old.get("identity") == identity and old.get("content_hash") == content_hash:
                name = old.get("archive", "")
                if Path(name).name == name and "/" not in name and "\\" not in name and (root / name).is_file():
                    print(f"Drive cache unchanged: {category}", flush=True)
                    continue
        with tempfile.TemporaryDirectory(dir=local) as tmp:
            print(f"Packing/saving Drive cache: {category}", flush=True)
            archive = Path(tmp) / "cache.zip"
            # Model weights/wheels are already compressed; STORE avoids CPU compression.
            with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_STORED) as z:
                for path in files:
                    z.write(path, path.relative_to(local).as_posix())
            digest = hash_file(archive)
            name = f"{category}-{digest}.zip"
            target = root / name
            if not target.exists():
                part = root / (name + ".uploading-" + uuid.uuid4().hex)
                shutil.copyfile(archive, part)
                if hash_file(part) != digest:
                    raise IOError(f"Drive cache upload hash mismatch: {category}")
                os.replace(part, target)
            elif hash_file(target) != digest:
                raise IOError(f"existing Drive cache archive corrupt: {category}")
            # Publish only after a fully copied, hash-verified archive exists.
            atomic_json(marker, {"schema": 1, "identity": identity, "archive": name,
                "sha256": digest, "content_hash": content_hash, "files": len(files)})
            print(f"Drive cache saved: {category} ({target.stat().st_size // 1024**2} MiB)", flush=True)
