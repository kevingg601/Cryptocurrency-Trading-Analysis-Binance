from __future__ import annotations

import hashlib
import ast
import importlib.util
import io
import json
import zipfile
from types import SimpleNamespace
from pathlib import Path
from unittest import mock

import pytest

from research.model_benchmark.bundle import BUNDLE_MANIFEST, create_bundle, extract_bundle, read_bundle_manifest
from research.model_benchmark.colab import (
    TRAINING_PYTHON_ENV,
    commit_notebook_artifacts,
    current_portable_identity,
    make_colab_environment,
    prepare_environments,
    python_executable,
    training_python,
    validate_kernel_python,
)
from research.model_benchmark.snapshots import SnapshotStore, restore_snapshot, verify_committed_archive


def _notebook_builder():
    path = Path(__file__).resolve().parents[2] / "scripts" / "build_colab_benchmark_notebook.py"
    spec = importlib.util.spec_from_file_location("build_colab_benchmark_notebook", path)
    module = importlib.util.module_from_spec(spec)
    assert spec and spec.loader
    spec.loader.exec_module(module)
    return module


def test_generated_notebook_gpu_probe_timeout_is_bounded_and_reported() -> None:
    notebook = _notebook_builder().build_notebook()
    environment_source = "".join(notebook["cells"][4]["source"])
    parsed = ast.parse(environment_source)
    helper = next(node for node in parsed.body if isinstance(node, ast.FunctionDef) and node.name == "run_bounded_gpu_probe")
    namespace = {"json": json, "subprocess": __import__("subprocess"), "sys": __import__("sys"), "time": __import__("time")}
    exec(compile(ast.Module(body=[helper], type_ignores=[]), "notebook-probe-helper", "exec"), namespace)
    with pytest.raises(RuntimeError, match="timed out"):
        namespace["run_bounded_gpu_probe"]("import time; time.sleep(5)", timeout_seconds=0.1)


def test_kernel_python_313_is_supported_but_training_interpreter_stays_312(tmp_path: Path) -> None:
    validate_kernel_python((3, 12))
    validate_kernel_python((3, 13))
    with pytest.raises(RuntimeError, match="3.12 or 3.13"):
        validate_kernel_python((3, 14))
    with mock.patch("research.model_benchmark.colab._kernel_python_version", return_value=(3, 13)):
        with pytest.raises(RuntimeError, match=TRAINING_PYTHON_ENV):
            training_python({})

    managed_python = tmp_path / "python312.exe"
    managed_python.write_bytes(b"mock executable")
    env = {TRAINING_PYTHON_ENV: str(managed_python)}
    with mock.patch("research.model_benchmark.colab.subprocess.run", return_value=SimpleNamespace(
        returncode=0,
        stdout=json.dumps({"version": [3, 12], "executable": str(managed_python)}),
        stderr="",
    )) as probe:
        assert training_python(env) == managed_python.resolve()
    assert probe.call_args.args[0][0] == str(managed_python.resolve())


def test_prepare_environments_launches_bootstrap_with_managed_python(tmp_path: Path) -> None:
    managed_python = tmp_path / "python312"
    managed_python.write_bytes(b"mock executable")
    tmp_root = tmp_path / "tmp"
    env = {
        TRAINING_PYTHON_ENV: str(managed_python),
        "FADACHI_MODEL_BENCHMARK_TMP_ROOT": str(tmp_root),
        "FADACHI_MODEL_BENCHMARK_ENV_ROOT": str(tmp_path / "envs"),
    }

    class FakeProcess:
        def __init__(self, command, **kwargs):
            self.command = command
            self.env = kwargs["env"]
            self.stdout = io.StringIO("bootstrap ready\n")
            self.manifest = Path(command[command.index("--manifest") + 1])
            self.manifest.write_text('{"status":"ready"}\n', encoding="utf-8")

        @staticmethod
        def wait():
            return 0

    with mock.patch("research.model_benchmark.colab.subprocess.run", return_value=SimpleNamespace(
        returncode=0,
        stdout=json.dumps({"version": [3, 12], "executable": str(managed_python)}),
        stderr="",
    )), mock.patch("research.model_benchmark.colab.subprocess.Popen", side_effect=FakeProcess) as popen:
        result = prepare_environments(tmp_path, env)
    assert result["status"] == "ready"
    assert popen.call_args.args[0][0] == str(managed_python.resolve())
    assert popen.call_args.kwargs["env"][TRAINING_PYTHON_ENV] == str(managed_python.resolve())


def test_portable_identity_is_computed_by_rank_python_312(tmp_path: Path) -> None:
    rank_python = python_executable(tmp_path / "envs", "rank")
    rank_python.parent.mkdir(parents=True)
    rank_python.write_bytes(b"mock executable")
    identity = {"platform": {"python_version": "3.12.14"}, "fingerprints": {"catboost": "a" * 64}, "environments": {}}
    env = {
        "FADACHI_MODEL_BENCHMARK_ENV_ROOT": str(tmp_path / "envs"),
        "FADACHI_MODEL_BENCHMARK_SOURCE_ROOT": str(tmp_path / "source"),
        TRAINING_PYTHON_ENV: str(tmp_path / "managed-python"),
    }
    with mock.patch("research.model_benchmark.colab.subprocess.run", return_value=SimpleNamespace(
        returncode=0, stdout=json.dumps(identity) + "\n", stderr=""
    )) as child:
        assert current_portable_identity(tmp_path, env, smoke=False) == identity
    assert child.call_args.args[0][0] == str(rank_python)
    assert "runner import _current_identity" in child.call_args.args[0][2]
    assert child.call_args.kwargs["env"][TRAINING_PYTHON_ENV] == env[TRAINING_PYTHON_ENV]


def test_colab_child_env_does_not_inherit_kernel_python_paths(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("PYTHONPATH", "C:/kernel/python313/site-packages")
    monkeypatch.setenv("PYTHONHOME", "C:/kernel/python313")
    monkeypatch.setenv("VIRTUAL_ENV", "C:/kernel/python313/venv")
    monkeypatch.setenv("PYTHONUSERBASE", "C:/kernel/userbase")
    monkeypatch.setenv("PATH", "C:/cuda/bin;C:/Windows/System32")
    roots = [tmp_path / name for name in ("repo", "source", "runs", "cache", "envs", "tmp")]
    env = make_colab_environment(*roots)
    assert env["PYTHONPATH"] == str(roots[0].resolve())
    assert env["PYTHONNOUSERSITE"] == "1"
    assert all(name not in env for name in ("PYTHONHOME", "VIRTUAL_ENV", "PYTHONUSERBASE"))
    assert env["PATH"] == "C:/cuda/bin;C:/Windows/System32"


def test_notebook_environment_cell_is_pure_preflight_and_bundle_uses_file_paths() -> None:
    notebook = _notebook_builder().build_notebook()
    environment_cell = notebook["cells"][4]["source"]
    environment_source = "".join(environment_cell)
    assert environment_source.index('print("') < environment_source.index("content_free_bytes =")
    assert "timeout_seconds=90" in environment_source
    environment_ast = ast.parse(environment_source)
    assert not any(
        isinstance(node, ast.Attribute)
        and isinstance(node.value, ast.Attribute)
        and isinstance(node.value.value, ast.Name)
        and node.value.value.id == "torch"
        and node.value.attr == "cuda"
        for node in ast.walk(environment_ast)
    )
    for forbidden in ("files.upload", "drive.mount", "zipfile", "BUNDLE_ZIP_PATH", "hashlib", "copyfile"):
        assert forbidden not in environment_source
    bundle_source = "".join(notebook["cells"][6]["source"])
    assert "files.upload" not in bundle_source
    assert "BUNDLE_ZIP_PATH" in bundle_source
    assert "managed-python-runtime-v1" in bundle_source
    assert "舊版資料包" in bundle_source
    assert "copy_with_progress" in bundle_source
    assert "verify_bundle(bundle_path)" in bundle_source
    assert "files.download" not in "".join(notebook["cells"][12]["source"])
    settings_source = "".join(notebook["cells"][2]["source"])
    assert "Colab: Mount Google Drive to Server..." in settings_source
    assert "timeout_ms=60000" in settings_source


def test_generated_notebook_routes_drive_zip_to_local_copy(tmp_path: Path) -> None:
    notebook = _notebook_builder().build_notebook()
    bundle_source = "".join(notebook["cells"][6]["source"])
    parsed = ast.parse(bundle_source)
    helper = next(
        node for node in parsed.body
        if isinstance(node, ast.FunctionDef) and node.name == "is_content_local_bundle"
    )
    namespace = {"Path": Path}
    exec(compile(ast.Module(body=[helper], type_ignores=[]), "notebook-path-helper", "exec"), namespace)

    content_root = tmp_path / "content"
    drive_root = content_root / "drive"
    drive_zip = drive_root / "MyDrive" / "input.zip"
    local_zip = content_root / "input.zip"
    drive_zip.parent.mkdir(parents=True)
    local_zip.parent.mkdir(parents=True, exist_ok=True)
    drive_zip.write_bytes(b"unchanged Drive ZIP")
    local_zip.write_bytes(b"local ZIP")

    is_local = namespace["is_content_local_bundle"]
    assert is_local(drive_zip, content_root, drive_root) is False
    assert is_local(local_zip, content_root, drive_root) is True
    assert "if is_content_local:" in bundle_source
    assert "copy_with_progress(bundle_path, local_bundle_path" in bundle_source


def _write(root: Path, rel: str, data: bytes = b"x") -> Path:
    path = root / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return path


def _bundle_fixture(root: Path) -> None:
    for name in (
        "research/__init__.py",
        "research/model_benchmark/__init__.py",
        "research/model_benchmark/colab.py",
        "research/model_benchmark/managed_python.py",
        "research/model_benchmark/requirements-rank.txt",
        "research/model_benchmark/requirements-chronos.txt",
        "research/model_benchmark/requirements-timesfm.txt",
        "research/model_benchmark/requirements-rank.linux.lock.txt",
        "research/model_benchmark/requirements-chronos.linux.lock.txt",
        "research/model_benchmark/requirements-timesfm.linux.lock.txt",
        "research/model_benchmark/model-assets.lock.json",
        "research/model_benchmark/python-runtime.lock.json",
        "research/model_research/__init__.py",
        "research/model_research/features_and_labels.py",
        "data-reruns/20261110-004810/model-research/datasets/dataset_manifest.json",
        "data-reruns/20261110-004810/model-research/datasets/research_panel.parquet",
        "data-reruns/20261110-004810/model-research/datasets/klines_1h.parquet",
        "data-reruns/20261110-004810/model-research/datasets/funding_rates.parquet",
        "data-reruns/20261110-004810/model-research/models/lgbm_metadata.json",
        "data-reruns/20261110-004810/model-research/models/lgbm_long_ranker.txt",
        "data-reruns/20261110-004810/model-research/models/lgbm_short_ranker.txt",
    ):
        _write(root, name)
    _write(root, ".env", b"SECRET=should-not-be-included")


def _snapshot_event(run_root: Path, *, event_id: str = "event-1", model_state: dict | None = None) -> dict:
    model_state = model_state or {"run_id": "run-1", "status": "RUNNING", "source_root": "old-source"}
    state_bytes = (json.dumps(model_state, sort_keys=True, separators=(",", ":")) + "\n").encode()
    cohort_bytes = b'{"symbols":["BTCUSDT"]}\n'
    baseline_bytes = b"baseline-predictions"
    _write(run_root, "snapshots/state-deadbeef.json", state_bytes)
    _write(run_root, "common_cohort.json", cohort_bytes)
    _write(run_root, "baselines/lightgbm.parquet", baseline_bytes)
    files = [
        ("snapshots/state-deadbeef.json", state_bytes),
        ("common_cohort.json", cohort_bytes),
        ("baselines/lightgbm.parquet", baseline_bytes),
    ]
    return {
        "schema": 1,
        "event_id": event_id,
        "run_id": "run-1",
        "event": "model_stage_completed",
        "model_key": "catboost",
        "stage": "trained",
        "attempt_dir": "models/catboost/attempt-1",
        "portable_identity": {"schema": 1, "platform": {"system": "Linux", "python_version": "3.12.13"}, "fingerprints": {"catboost": "abc"}},
        "artifact_manifest": [
            {"path": rel, "size_bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()} for rel, data in files
        ],
        "snapshot_context": {
            "manifest_path": "snapshots/state-deadbeef.json",
            "manifest_sha256": hashlib.sha256(state_bytes).hexdigest(),
            "cohort_path": "common_cohort.json",
            "cohort_sha256": hashlib.sha256(cohort_bytes).hexdigest(),
            "baseline_path": "baselines/lightgbm.parquet",
            "baseline_sha256": hashlib.sha256(baseline_bytes).hexdigest(),
        },
        "created_utc": "2026-11-10T01:02:03Z",
    }


def test_bundle_allowlist_and_verified_extract(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    _bundle_fixture(repo)
    archive = tmp_path / "bundle.zip"
    result = create_bundle(repo, archive)
    assert result["files"]
    manifest = read_bundle_manifest(archive)
    names = set(zipfile.ZipFile(archive).namelist())
    assert BUNDLE_MANIFEST in names
    assert "managed-python-runtime-v1" in manifest["features"]
    assert ".env" not in names
    assert "research/model_research/features_and_labels.py" in names
    assert "research/model_benchmark/managed_python.py" in names
    assert "research/model_benchmark/python-runtime.lock.json" in names
    destination = tmp_path / "extract"
    extracted = extract_bundle(archive, destination)
    assert extracted["restored_existing"] is False
    assert (destination / "research/model_benchmark/colab.py").read_bytes() == b"x"
    assert extract_bundle(archive, destination)["restored_existing"] is True


def test_bundle_refuses_path_traversal_before_writing(tmp_path: Path) -> None:
    archive_path = tmp_path / "evil.zip"
    payload = b"bad"
    manifest = {
        "schema": 1,
        "bundle_id": "evil",
        "files": [{"path": "../escaped.txt", "size": len(payload), "sha256": hashlib.sha256(payload).hexdigest()}],
    }
    with zipfile.ZipFile(archive_path, "w") as archive:
        archive.writestr(BUNDLE_MANIFEST, json.dumps(manifest))
        archive.writestr("../escaped.txt", payload)
    with pytest.raises(ValueError, match="unsafe"):
        extract_bundle(archive_path, tmp_path / "destination")
    assert not (tmp_path / "escaped.txt").exists()


def test_snapshot_commit_restore_and_portable_identity(tmp_path: Path) -> None:
    run_root = tmp_path / "local-runs" / "run-1"
    event = _snapshot_event(run_root)
    drive_root = tmp_path / "drive"
    store = SnapshotStore(drive_root, "session-current", local_lock_root=tmp_path / "local-locks")
    archive = store.save_event(run_root, event)
    marker = archive.with_suffix(archive.suffix + ".COMMITTED")
    assert marker.is_file()
    assert verify_committed_archive(archive, marker)["event"]["event_id"] == "event-1"
    listed = store.list_committed("run-1", portable_identity=event["portable_identity"])
    assert len(listed) == 1

    restored = tmp_path / "restored-runs" / "run-1"
    result = restore_snapshot(archive, marker, restored, expected_portable_identity=event["portable_identity"], current_source_root=tmp_path / "source")
    assert result["run_id"] == "run-1"
    assert json.loads((restored / "run_manifest.json").read_text())["run_id"] == "run-1"
    assert json.loads((restored / "snapshots/state-deadbeef.json").read_text())["source_root"] == "old-source"
    assert (restored / "baselines/lightgbm.parquet").read_bytes() == b"baseline-predictions"

    wrong_identity = {**event["portable_identity"], "platform": {"system": "Windows"}}
    with pytest.raises(ValueError, match="identity differs"):
        restore_snapshot(archive, marker, tmp_path / "wrong" / "run-1", expected_portable_identity=wrong_identity, current_source_root=tmp_path / "source")


def test_restore_rebases_successful_model_artifacts(tmp_path: Path) -> None:
    run_root = tmp_path / "original-runs" / "run-1"
    source_root = tmp_path / "original-source"
    attempt = run_root / "models/catboost/attempt-1"
    weight_path = _write(attempt, "model.bin", b"model-weights")
    prediction_path = _write(attempt, "predictions.parquet", b"prediction-data")
    weight_hash = hashlib.sha256(weight_path.read_bytes()).hexdigest()
    prediction_hash = hashlib.sha256(prediction_path.read_bytes()).hexdigest()
    model_state = {
        "run_id": "run-1",
        "status": "RUNNING",
        "source_root": str(source_root),
        "models": {
            "catboost": {
                "status": "SUCCESS",
                "attempt_dir": str(attempt),
                "predictions_path": str(prediction_path),
                "artifact_hashes": {"model.bin": weight_hash},
                "predict": {"predictions_sha256": prediction_hash},
            }
        },
    }
    event = _snapshot_event(run_root, model_state=model_state)
    event["artifact_manifest"].extend([
        {"path": "models/catboost/attempt-1/model.bin", "size_bytes": weight_path.stat().st_size, "sha256": weight_hash},
        {"path": "models/catboost/attempt-1/predictions.parquet", "size_bytes": prediction_path.stat().st_size, "sha256": prediction_hash},
    ])
    store = SnapshotStore(tmp_path / "drive", "session", local_lock_root=tmp_path / "locks")
    archive = store.save_event(run_root, event)
    marker = archive.with_suffix(archive.suffix + ".COMMITTED")
    destination = tmp_path / "restored-runs" / "run-1"
    new_source = tmp_path / "new-source"
    restore_snapshot(archive, marker, destination, expected_portable_identity=event["portable_identity"], current_source_root=new_source)
    restored_state = json.loads((destination / "run_manifest.json").read_text(encoding="utf-8"))
    assert restored_state["source_root"] == str(new_source.resolve())
    assert Path(restored_state["models"]["catboost"]["attempt_dir"]).is_dir()
    assert Path(restored_state["models"]["catboost"]["predictions_path"]).is_file()


def test_restore_accepts_legacy_windows_nested_adapter_artifact_path(tmp_path: Path) -> None:
    run_root = tmp_path / "windows-runs" / "run-legacy"
    attempt = run_root / "models/chronos2/attempt-1"
    adapter_readme = _write(attempt, "adapter/README.md", b"saved adapter metadata")
    predictions = _write(attempt, "predictions.parquet", b"forecast rows")
    adapter_hash = hashlib.sha256(adapter_readme.read_bytes()).hexdigest()
    prediction_hash = hashlib.sha256(predictions.read_bytes()).hexdigest()
    model_state = {
        "run_id": "run-legacy",
        "status": "SUCCESS",
        "source_root": str(tmp_path / "windows-source"),
        "models": {
            "chronos2": {
                "status": "SUCCESS",
                "attempt_dir": str(attempt),
                "predictions_path": str(predictions),
                "artifact_hashes": {"adapter\\README.md": adapter_hash},
                "predict": {"predictions_sha256": prediction_hash},
            }
        },
    }
    event = _snapshot_event(run_root, event_id="windows-event", model_state=model_state)
    event["run_id"] = "run-legacy"
    event["portable_identity"]["platform"]["system"] = "Windows"
    # Stage artifacts are always stored under canonical POSIX member names.
    event["artifact_manifest"] = [
        item for item in event["artifact_manifest"]
        if item["path"] not in {"snapshots/state-deadbeef.json", "common_cohort.json", "baselines/lightgbm.parquet"}
    ]
    files = [
        ("snapshots/state-deadbeef.json", (json.dumps(model_state, sort_keys=True, separators=(",", ":")) + "\n").encode()),
        ("common_cohort.json", b'{"symbols":["BTCUSDT"]}\n'),
        ("baselines/lightgbm.parquet", b"baseline-predictions"),
        ("models/chronos2/attempt-1/adapter/README.md", adapter_readme.read_bytes()),
        ("models/chronos2/attempt-1/predictions.parquet", predictions.read_bytes()),
    ]
    event["artifact_manifest"] = [
        {"path": name, "size_bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}
        for name, data in files
    ]
    store = SnapshotStore(tmp_path / "windows-drive", "session-windows", local_lock_root=tmp_path / "locks")
    archive = store.save_event(run_root, event)
    destination = tmp_path / "restored-windows" / "run-legacy"
    restore_snapshot(
        archive,
        archive.with_suffix(archive.suffix + ".COMMITTED"),
        destination,
        expected_portable_identity=event["portable_identity"],
        current_source_root=tmp_path / "restored-source",
    )
    assert (destination / "models/chronos2/attempt-1/adapter/README.md").read_bytes() == b"saved adapter metadata"
    restored_manifest = json.loads((destination / "run_manifest.json").read_text(encoding="utf-8"))
    assert "adapter\\README.md" in restored_manifest["models"]["chronos2"]["artifact_hashes"]


def test_snapshot_without_marker_or_with_tampered_archive_is_not_restorable(tmp_path: Path) -> None:
    run_root = tmp_path / "local-runs" / "run-1"
    store = SnapshotStore(tmp_path / "drive", "session", local_lock_root=tmp_path / "locks")
    archive = store.save_event(run_root, _snapshot_event(run_root))
    marker = archive.with_suffix(archive.suffix + ".COMMITTED")
    marker.unlink()
    with pytest.raises(ValueError, match="COMMITTED"):
        verify_committed_archive(archive, marker)
    marker.write_text(json.dumps({"archive_sha256": hashlib.sha256(archive.read_bytes()).hexdigest()}), encoding="utf-8")
    archive.write_bytes(archive.read_bytes() + b"truncated")
    with pytest.raises(ValueError, match="archive hash"):
        verify_committed_archive(archive, marker)


def test_notebook_log_and_runtime_are_committed_and_restorable(tmp_path: Path) -> None:
    run_root = tmp_path / "runs" / "run-1"
    run_root.mkdir(parents=True)
    log_path = tmp_path / "logs" / "outer-runner.log"
    log_path.parent.mkdir(parents=True)
    log_path.write_bytes(b"runner started\nmodel training complete\nrunner exited\n")
    identity = {"schema": 1, "platform": {"system": "Linux"}, "fingerprints": {"chronos2": "abc"}}
    _write(run_root, "common_cohort.json", b'{"groups":1}\n')
    attempt = run_root / "models/catboost/attempt-1"
    weight = _write(attempt, "model.bin", b"catboost-model")
    predictions = _write(attempt, "predictions.parquet", b"frozen-predictions")
    _write(attempt, "attempt_identity.json", b'{"fingerprint":"abc"}\n')
    for name, data in (
        ("comparison.md", b"# final report\n"),
        ("comparison.csv", b"metric,value\nndcg,0.5\n"),
        ("comparison.json", b'{"status":"SUCCESS"}\n'),
    ):
        _write(run_root, name, data)
    (run_root / "run_manifest.json").write_text(json.dumps({
        "run_id": "run-1", "status": "SUCCESS", "source_root": str(tmp_path / "source"),
        "portable_identity": identity,
        "models": {
            "catboost": {
                "status": "SUCCESS",
                "attempt_dir": str(attempt),
                "artifact_hashes": {"model.bin": hashlib.sha256(weight.read_bytes()).hexdigest()},
                "predictions_path": str(predictions),
                "predict": {"predictions_sha256": hashlib.sha256(predictions.read_bytes()).hexdigest()},
            }
        },
    }), encoding="utf-8")
    store = SnapshotStore(tmp_path / "drive", "session-current", local_lock_root=tmp_path / "locks")

    result = commit_notebook_artifacts(
        run_root,
        runner_log=log_path,
        runtime={"gpu_name": "NVIDIA A100-SXM4-40GB", "cuda_tensor_op_passed": True},
        ts_gpu={"chronos": {"torch": "2.6.0+cu126", "gpu": "NVIDIA A100-SXM4-40GB"}},
        session_id="session-current",
        store=store,
    )
    event = result["event"]
    assert event["stage"] == "notebook_completed"
    paths = {item["path"] for item in event["artifact_manifest"]}
    log_rel = Path(result["runner_log_path"]).relative_to(run_root).as_posix()
    runtime_rel = Path(result["runtime_metadata_path"]).relative_to(run_root).as_posix()
    assert log_rel in paths and runtime_rel in paths
    assert Path(result["runner_log_path"]).read_bytes() == log_path.read_bytes()

    latest = store.list_committed("run-1")[-1]
    assert latest["event_id"] == event["event_id"]
    with zipfile.ZipFile(result["archive_path"]) as archive:
        archive_names = set(archive.namelist())
    assert {"comparison.md", "comparison.csv", "comparison.json", log_rel, runtime_rel, "models/catboost/attempt-1/model.bin"} <= archive_names
    destination = tmp_path / "restored" / "run-1"
    restore_snapshot(
        Path(result["archive_path"]),
        Path(result["archive_path"]).with_suffix(Path(result["archive_path"]).suffix + ".COMMITTED"),
        destination,
        expected_portable_identity=identity,
        current_source_root=tmp_path / "restored-source",
    )
    assert (destination / log_rel).read_bytes() == b"runner started\nmodel training complete\nrunner exited\n"
    assert (destination / "comparison.md").read_bytes() == b"# final report\n"
    assert (destination / "comparison.csv").is_file() and (destination / "comparison.json").is_file()
    assert (destination / "models/catboost/attempt-1/model.bin").read_bytes() == b"catboost-model"
    hardware = json.loads((destination / runtime_rel).read_text(encoding="utf-8"))
    assert hardware["colab_runtime"]["gpu_name"].startswith("NVIDIA A100")
    assert hardware["timeseries_environments"]["chronos"]["torch"] == "2.6.0+cu126"
