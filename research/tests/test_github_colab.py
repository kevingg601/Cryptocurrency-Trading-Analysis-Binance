"""Small offline regression checks. No GPU, model downloads or training."""
import json
import zipfile
from pathlib import Path

import pytest

from research.model_benchmark.github_colab import INPUT_FILES, build_inputs, install_inputs, export_run, execute
from research.model_benchmark.common import hash_file


def inputs(tmp_path):
    source = tmp_path / "original"
    for relative in INPUT_FILES:
        path = source / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(relative, encoding="utf-8")
    delivery = tmp_path / "delivery"
    build_inputs(source, delivery)
    return source, delivery


def test_data_only_roundtrip_and_existing_dataset_preserved(tmp_path):
    source, delivery = inputs(tmp_path)
    target = tmp_path / "installed"
    install_inputs(delivery / "research-inputs.zip", delivery / "assets-manifest.json", target)
    assert sorted(p.relative_to(target).as_posix() for p in target.rglob("*") if p.is_file()) == sorted(INPUT_FILES)
    (target / INPUT_FILES[0]).write_text("local edit")
    with pytest.raises(ValueError, match="preserved"):
        install_inputs(delivery / "research-inputs.zip", delivery / "assets-manifest.json", target)
    assert (target / INPUT_FILES[0]).read_text() == "local edit"
    assert (source / INPUT_FILES[0]).read_text() == INPUT_FILES[0]


def test_extra_archive_member_rejected_before_extract(tmp_path):
    _, delivery = inputs(tmp_path)
    archive = delivery / "research-inputs.zip"
    with zipfile.ZipFile(archive, "a") as z:
        z.writestr("../escape.py", "unexpected")
    manifest = delivery / "assets-manifest.json"
    m = json.loads(manifest.read_text())
    m["archive_sha256"] = hash_file(archive)
    manifest.write_text(json.dumps(m))
    target = tmp_path / "installed"
    with pytest.raises(ValueError, match="unexpected"):
        install_inputs(archive, manifest, target)
    assert not target.exists()


def test_export_partial_standalone_preserves_original_and_verifies_hash(tmp_path):
    run = tmp_path / "run"
    run.mkdir()
    manifest = run / "run_manifest.json"
    manifest.write_text(json.dumps({"status": "PARTIAL", "models": {}}))
    original = manifest.read_bytes()
    target = export_run(run, tmp_path / "drive")
    digest = json.loads(target.with_suffix(".sha256.json").read_text())
    assert hash_file(target) == digest["sha256"]
    assert digest["status"] == "PARTIAL"
    assert manifest.read_bytes() == original
    with zipfile.ZipFile(target) as z:
        assert json.loads(z.read("run/run_manifest.json"))["status"] == "PARTIAL"


def test_running_run_not_exported(tmp_path):
    run = tmp_path / "run"
    run.mkdir()
    (run / "run_manifest.json").write_text('{"status":"RUNNING"}')
    with pytest.raises(RuntimeError, match="active"):
        export_run(run, tmp_path / "drive")
    assert not (tmp_path / "drive").exists()


def test_infer_missing_model_path_never_starts_training(tmp_path, monkeypatch):
    import subprocess
    monkeypatch.setattr(subprocess, "run", lambda *a, **k: pytest.fail("subprocess must not start"))
    with pytest.raises(ValueError, match="MODEL_RUN_PATH"):
        execute(tmp_path, tmp_path, tmp_path, action="infer", mode="full", models=["catboost"])


def test_saved_model_inference_only_calls_predict(tmp_path, monkeypatch):
    from research.model_benchmark import inference as inf, runner
    source = tmp_path / "saved"
    attempt = source / "models/catboost/attempt"
    attempt.mkdir(parents=True)
    weight = attempt / "model.cbm"
    weight.write_bytes(b"fake artifact for orchestration only")
    (source / "run_manifest.json").write_text(json.dumps({"source_identity": {"id": "fixed"},
        "models": {"catboost": {"status": "SUCCESS", "attempt_dir": "/former/saved/models/catboost/attempt",
        "artifact_hashes": {"model.cbm": hash_file(weight)}, "fingerprint": "saved-fingerprint"}}}))
    monkeypatch.setattr(inf, "dataset_identity", lambda *a: {"id": "fixed"})
    monkeypatch.setattr(inf, "load_source", lambda: (None, None, {"id": "fixed"}))
    monkeypatch.setattr(inf, "freeze_common_cohort", lambda *a, **k: None)
    monkeypatch.setattr(runner, "_env_identity", lambda *a: {})
    calls = []
    def worker(key, action, directory, *args, **kwargs):
        calls.append(action)
        assert action == "predict"
        (directory / "predictions.parquet").write_bytes(b"stub")
        return {}, 0, ""
    monkeypatch.setattr(runner, "_run_worker", worker)
    monkeypatch.setattr(runner, "_validate_prediction", lambda *a: {})
    monkeypatch.setattr(runner, "_execute_model", lambda *a, **k: pytest.fail("trainer must not run"))
    result = inf.run_inference(source, tmp_path / "output", ["catboost"])
    assert calls == ["predict"]
    assert result["status"] == "SUCCESS" and result["action"] == "infer"
    assert weight.read_bytes() == b"fake artifact for orchestration only"


def test_rank_only_setup_does_not_download_forecast_weights(tmp_path, monkeypatch):
    from research.model_benchmark import bootstrap as b
    monkeypatch.setenv("FADACHI_MODEL_BENCHMARK_MODELS", "xgboost")
    monkeypatch.setattr(b, "ENV_ROOT", tmp_path / "envs")
    monkeypatch.setattr(b, "CACHE_ROOT", tmp_path / "cache")
    prepared = []
    def setup(name, **kwargs):
        prepared.append(name)
        return {"status": "ready"}
    monkeypatch.setattr(b, "_prepare_env", setup)
    monkeypatch.setattr(b.subprocess, "run", lambda *a, **k: pytest.fail("no model download subprocess"))
    result = b._prepare_locked()
    assert prepared == ["rank"] and result["status"] == "ready"
