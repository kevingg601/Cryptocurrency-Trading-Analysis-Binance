"""Tiny real-file cache checks; no GPU, package downloads or training."""
import json
from pathlib import Path

import pytest

from research.model_benchmark.drive_cache import save_cache, restore_cache, cache_identity


def test_cache_roundtrip_reuse_and_excludes_installed_environment(tmp_path):
    local = tmp_path / "local"
    for category in ("python", "pip", "wheels", "models", "envs"):
        path = local / category / "tiny.bin"
        path.parent.mkdir(parents=True)
        path.write_bytes(category.encode())
    incomplete = local / "models" / "download.incomplete"
    incomplete.write_bytes(b"partial")
    drive = tmp_path / "drive"
    save_cache(local, drive, "identity")
    before = sorted(p.name for p in (drive / "cache/identity").iterdir())
    save_cache(local, drive, "identity")
    assert sorted(p.name for p in (drive / "cache/identity").iterdir()) == before
    fresh = tmp_path / "fresh"
    restore_cache(fresh, drive, "identity")
    for category in ("python", "pip", "wheels", "models"):
        assert (fresh / category / "tiny.bin").read_bytes() == category.encode()
    assert not (fresh / "envs").exists()
    assert not (fresh / "models/download.incomplete").exists()


def test_corrupt_archive_rejected_before_extraction(tmp_path):
    local = tmp_path / "local"
    (local / "python").mkdir(parents=True)
    (local / "python/a.tar.gz").write_bytes(b"tiny")
    drive = tmp_path / "drive"
    save_cache(local, drive, "identity")
    marker = drive / "cache/identity/python.json"
    record = json.loads(marker.read_text())
    (marker.parent / record["archive"]).write_bytes(b"corrupted")
    fresh = tmp_path / "fresh"
    with pytest.raises(ValueError, match="hash mismatch"):
        restore_cache(fresh, drive, "identity")
    assert not (fresh / "python").exists()


def test_valid_wheel_cache_does_not_call_network(tmp_path, monkeypatch):
    from research.model_benchmark import bootstrap as b
    monkeypatch.setattr(b, "CACHE_ROOT", tmp_path)
    lock = tmp_path / "requirements.lock"
    lock.write_text("example==1.0")
    directory = tmp_path / "wheels" / f"rank-{b._sha256(lock)[:16]}"
    directory.mkdir(parents=True)
    wheel = directory / "example-1.0-py3-none-any.whl"
    wheel.write_bytes(b"tiny orchestration fixture, not an installable wheel")
    (directory / "wheel-manifest.json").write_text(json.dumps({"lock_sha256": b._sha256(lock),
                                                            "files": {wheel.name: b._sha256(wheel)}}))
    monkeypatch.setattr(b.subprocess, "run", lambda *a, **k: pytest.fail("network/install must not run"))
    assert b._prepare_wheels("rank", lock, {}) == directory


def test_cache_key_tracks_locks_not_source_commit(tmp_path):
    root = tmp_path / "research/model_benchmark"
    root.mkdir(parents=True)
    names = ["python-runtime.lock.json", "model-assets.lock.json"]
    names += [f"requirements-{name}.linux.lock.txt" for name in ("rank", "chronos", "timesfm")]
    for name in names:
        (root / name).write_text(name)
    first = cache_identity(tmp_path)
    (root / "github_colab.py").write_text("# unrelated code update")
    assert cache_identity(tmp_path) == first
    (root / names[0]).write_text("changed pinned runtime")
    assert cache_identity(tmp_path) != first
