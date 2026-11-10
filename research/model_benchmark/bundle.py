"""Create and safely extract a small, hash-verified Colab source/data bundle."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

from .common import atomic_json, hash_file

BUNDLE_SCHEMA = 1
BUNDLE_MANIFEST = "fadachi_colab_bundle.json"
REQUIRED_FEATURES = ["managed-python-runtime-v1"]
SOURCE_REL = "data-reruns/20261110-004810/model-research"


def _sha256(path: Path) -> str:
    return hash_file(path)


def _required_paths(repo_root: Path) -> list[Path]:
    benchmark = repo_root / "research" / "model_benchmark"
    files = [p for p in benchmark.glob("*.py") if p.is_file()]
    files.extend([
        benchmark / "requirements-rank.txt",
        benchmark / "requirements-chronos.txt",
        benchmark / "requirements-timesfm.txt",
        benchmark / "requirements-rank.linux.lock.txt",
        benchmark / "requirements-chronos.linux.lock.txt",
        benchmark / "requirements-timesfm.linux.lock.txt",
        benchmark / "model-assets.lock.json",
        benchmark / "python-runtime.lock.json",
    ])
    files.append(repo_root / "research" / "__init__.py")
    model_research = repo_root / "research" / "model_research"
    files.extend([model_research / "__init__.py", model_research / "features_and_labels.py"])
    source = repo_root / SOURCE_REL
    files.extend([
        source / "datasets" / "dataset_manifest.json",
        source / "datasets" / "research_panel.parquet",
        source / "datasets" / "klines_1h.parquet",
        source / "datasets" / "funding_rates.parquet",
        source / "models" / "lgbm_metadata.json",
        source / "models" / "lgbm_long_ranker.txt",
        source / "models" / "lgbm_short_ranker.txt",
    ])
    return sorted(set(files), key=lambda p: p.relative_to(repo_root).as_posix())


def _validate_relpath(name: str) -> PurePosixPath:
    if not isinstance(name, str) or not name or "\\" in name:
        raise ValueError(f"invalid bundle path: {name!r}")
    path = PurePosixPath(name)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts) or ":" in path.parts[0]:
        raise ValueError(f"unsafe bundle path: {name!r}")
    return path


def create_bundle(repo_root: Path, output_path: Path) -> dict[str, Any]:
    """Build a zip from an explicit allowlist, never by walking the repository."""
    repo_root = repo_root.resolve()
    output_path = output_path.resolve()
    records: list[dict[str, Any]] = []
    files: list[tuple[Path, str]] = []
    for path in _required_paths(repo_root):
        if not path.is_file():
            raise FileNotFoundError(f"required Colab bundle input missing: {path}")
        if path.is_symlink():
            raise ValueError(f"symbolic links are not accepted in the Colab bundle: {path}")
        rel = path.relative_to(repo_root).as_posix()
        _validate_relpath(rel)
        files.append((path, rel))
        records.append({"path": rel, "size": path.stat().st_size, "sha256": _sha256(path)})

    output_path.parent.mkdir(parents=True, exist_ok=True)
    manifest = {
        "schema": BUNDLE_SCHEMA,
        "bundle_id": hashlib.sha256(json.dumps(records, sort_keys=True).encode()).hexdigest(),
        "features": REQUIRED_FEATURES,
        "files": records,
    }
    fd, temp_name = tempfile.mkstemp(prefix=f".{output_path.name}.", suffix=".tmp", dir=output_path.parent)
    os.close(fd)
    try:
        with zipfile.ZipFile(temp_name, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as archive:
            archive.writestr(BUNDLE_MANIFEST, json.dumps(manifest, indent=2, sort_keys=True) + "\n")
            for path, rel in files:
                archive.write(path, rel)
        os.replace(temp_name, output_path)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise
    return {**manifest, "archive_path": str(output_path), "archive_sha256": _sha256(output_path)}


def read_bundle_manifest(archive_path: Path) -> dict[str, Any]:
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("bundle contains duplicate zip entries")
        if BUNDLE_MANIFEST not in names:
            raise ValueError("bundle manifest is missing")
        manifest = json.loads(archive.read(BUNDLE_MANIFEST).decode("utf-8"))
        if manifest.get("schema") != BUNDLE_SCHEMA or not isinstance(manifest.get("files"), list):
            raise ValueError("unsupported or malformed bundle manifest")
        expected = {record["path"]: record for record in manifest["files"]}
        if len(expected) != len(manifest["files"]):
            raise ValueError("bundle manifest contains duplicate paths")
        actual = set(names) - {BUNDLE_MANIFEST}
        if actual != set(expected):
            raise ValueError("bundle entries do not match manifest allowlist")
        total_uncompressed = 0
        for info in archive.infolist():
            if info.filename == BUNDLE_MANIFEST:
                continue
            path = _validate_relpath(info.filename)
            unix_mode = info.external_attr >> 16
            if stat.S_ISLNK(unix_mode):
                raise ValueError(f"symbolic link in bundle: {info.filename}")
            if info.file_size > 128 * 1024 * 1024:
                raise ValueError(f"bundle member exceeds size limit: {info.filename}")
            total_uncompressed += info.file_size
            if total_uncompressed > 512 * 1024 * 1024:
                raise ValueError("bundle exceeds total uncompressed size limit")
            if info.file_size > 0 and info.compress_size == 0:
                raise ValueError(f"invalid compressed member: {info.filename}")
            if info.file_size > max(4 * 1024 * 1024, info.compress_size * 1000):
                raise ValueError(f"suspicious compression ratio: {info.filename}")
            record = expected[info.filename]
            if info.file_size != int(record["size"]):
                raise ValueError(f"bundle size mismatch: {info.filename}")
            digest = hashlib.sha256(archive.read(info.filename)).hexdigest()
            if digest != record["sha256"]:
                raise ValueError(f"bundle hash mismatch: {info.filename}")
        return manifest


def extract_bundle(archive_path: Path, destination: Path) -> dict[str, Any]:
    """Verify the full bundle before writing; refuse overwriting changed files."""
    archive_path = archive_path.resolve()
    destination = destination.resolve()
    manifest = read_bundle_manifest(archive_path)
    destination.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{destination.name}.extract-", dir=destination.parent))
    try:
        with zipfile.ZipFile(archive_path) as archive:
            for record in manifest["files"]:
                rel = _validate_relpath(record["path"])
                staged_path = stage.joinpath(*rel.parts)
                staged_path.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(record["path"]) as source, staged_path.open("wb") as target:
                    shutil.copyfileobj(source, target)
                if _sha256(staged_path) != record["sha256"]:
                    raise ValueError(f"extracted file hash mismatch: {record['path']}")

        marker = stage / ".fadachi_colab_bundle.json"
        marker.write_text(json.dumps({"bundle_id": manifest["bundle_id"], "archive_sha256": _sha256(archive_path)}, indent=2) + "\n", encoding="utf-8")
        if destination.exists():
            existing_marker = destination / ".fadachi_colab_bundle.json"
            if existing_marker.is_symlink() or not existing_marker.is_file():
                raise FileExistsError(f"refusing to overlay non-bundle directory: {destination}")
            prior = json.loads(existing_marker.read_text(encoding="utf-8"))
            if prior.get("bundle_id") != manifest["bundle_id"]:
                raise FileExistsError("bundle destination contains a different bundle; choose a new local path")
            for record in manifest["files"]:
                path = destination.joinpath(*_validate_relpath(record["path"]).parts)
                if path.is_symlink() or not path.is_file() or _sha256(path) != record["sha256"]:
                    raise ValueError(f"existing bundle file changed; refusing overwrite: {record['path']}")
            return {**manifest, "destination": str(destination), "restored_existing": True}
        os.replace(stage, destination)
        stage = None  # type: ignore[assignment]
        return {**manifest, "destination": str(destination), "restored_existing": False}
    finally:
        if stage is not None and stage.exists():
            shutil.rmtree(stage)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subparsers = parser.add_subparsers(dest="command", required=True)
    create = subparsers.add_parser("create")
    create.add_argument("--repo-root", type=Path, default=Path(__file__).resolve().parents[2])
    create.add_argument("--output", type=Path, default=Path("data/model-benchmark/colab/fadachi-colab-bundle.zip"))
    verify = subparsers.add_parser("verify")
    verify.add_argument("archive", type=Path)
    extract = subparsers.add_parser("extract")
    extract.add_argument("archive", type=Path)
    extract.add_argument("destination", type=Path)
    args = parser.parse_args(argv)
    try:
        if args.command == "create":
            result = create_bundle(args.repo_root, args.output)
        elif args.command == "verify":
            result = read_bundle_manifest(args.archive)
        else:
            result = extract_bundle(args.archive, args.destination)
        print(json.dumps(result, indent=2, ensure_ascii=False))
        return 0
    except Exception as exc:
        print(f"{type(exc).__name__}: {exc}")
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
