from __future__ import annotations

import io
import ast
import importlib.util
import tarfile
from pathlib import Path

import pytest

from research.model_benchmark.managed_python import _read_lock, validate_archive_members


def _notebook():
    path = Path(__file__).resolve().parents[2] / "scripts" / "build_colab_benchmark_notebook.py"
    spec = importlib.util.spec_from_file_location("build_colab_benchmark_notebook", path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.build_notebook()


def _tar(entries: list[tuple[str, str, str]]) -> tarfile.TarFile:
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w:gz") as archive:
        for name, kind, target in entries:
            info = tarfile.TarInfo(name)
            if kind == "dir":
                info.type = tarfile.DIRTYPE
            elif kind == "symlink":
                info.type = tarfile.SYMTYPE
                info.linkname = target
            else:
                info.type = tarfile.REGTYPE
                info.size = len(target.encode())
                archive.addfile(info, io.BytesIO(target.encode()))
                continue
            archive.addfile(info)
    buffer.seek(0)
    return tarfile.open(fileobj=buffer, mode="r:gz")


def test_pinned_managed_python_asset_lock() -> None:
    lock = _read_lock()
    assert lock["provider"] == "astral-sh/python-build-standalone"
    assert lock["release_tag"] == "20251028"
    assert lock["python_version"] == "3.12.12"
    assert lock["archive"] == "cpython-3.12.12+20251028-x86_64-unknown-linux-gnu-install_only_stripped.tar.gz"
    assert lock["sha256"] == "d136b7168603620bf82fd2ec0fcaed2a5853551aae66f8023b3ae32b435683f2"


def test_generated_notebook_uses_pinned_training_python_without_changing_kernel() -> None:
    notebook = _notebook()
    preflight = "".join(notebook["cells"][4]["source"])
    setup = "".join(notebook["cells"][8]["source"])
    assert "(3, 12), (3, 13)" in preflight
    assert "prepare_managed_python" in setup
    assert 'ENV["FADACHI_MODEL_BENCHMARK_PYTHON"] = str(TRAINING_PYTHON)' in setup
    assert setup.index('ENV["FADACHI_MODEL_BENCHMARK_PYTHON"]') < setup.index("os.environ.update(ENV)")
    assert "TRAINING_PYTHON_INFO[\"asset_sha256\"]" in setup
    ast.parse(preflight)
    ast.parse(setup)


def test_validated_archive_allows_only_in_root_relative_symlinks() -> None:
    archive = _tar([
        ("python", "dir", ""),
        ("python/bin", "dir", ""),
        ("python/bin/python3.12", "file", "runtime"),
        ("python/bin/python3", "symlink", "python3.12"),
        ("python/lib/current", "symlink", "../python3.12"),
    ])
    with archive:
        members = validate_archive_members(archive)
    assert len(members) == 5


@pytest.mark.parametrize(
    "entries",
    [
        [("../escaped", "file", "x")],
        [("python/bin/python", "symlink", "../../outside")],
        [("python/bin/python", "symlink", "/usr/bin/python3")],
        [("python/file", "file", "x"), ("python/file/child", "file", "x")],
    ],
)
def test_python_archive_rejects_unsafe_paths_and_link_ancestors(entries: list[tuple[str, str, str]]) -> None:
    archive = _tar(entries)
    with archive, pytest.raises(ValueError):
        validate_archive_members(archive)
