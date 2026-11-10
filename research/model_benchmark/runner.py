"""Resumable, sequential benchmark coordinator."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import threading
from collections import deque
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .common import atomic_json, exclusive_lock, hash_file, hash_tree, verify_artifacts
from .config import CACHE_ROOT, ENV_ROOT, MODEL_KEYS, REPO_ROOT, RUNS_ROOT, SOURCE_ROOT, benchmark_fingerprint, dataset_identity, model_config
from .dataset import freeze_common_cohort, load_source
from .metrics import evaluate_common, evaluate_forecaster, evaluate_ranker
from .process_tree import start_managed_process
from .registry import get_spec
from .reporting import write_reports


class IdentityDriftError(RuntimeError):
    """The immutable run identity changed while this run was in progress."""


def _timestamp_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]


def _env_python(env: str) -> Path:
    return ENV_ROOT / env / "Scripts" / "python.exe"


def _stable_identity(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: _stable_identity(v) for k, v in sorted(value.items())
                if not any(token in k.lower() for token in ("timestamp", "generated", "created", "log", "duration"))}
    if isinstance(value, list):
        return [_stable_identity(v) for v in value]
    return value


def _env_identity(env: str, model_key: str) -> dict[str, Any]:
    root = ENV_ROOT / env
    manifest = root / "environment-manifest.json"
    if not manifest.is_file():
        raise FileNotFoundError(f"missing pinned environment manifest: {manifest}")
    raw = _stable_identity(json.loads(manifest.read_text(encoding="utf-8")))
    if raw.get("status") != "ready":
        raise RuntimeError(f"isolated environment {env} is not ready: {raw.get('error', raw.get('status'))}")
    lock_path = Path(raw.get("lock", ""))
    if raw.get("lock_sha256") and lock_path.is_file() and hash_file(lock_path) != raw["lock_sha256"]:
        raise ValueError(f"environment lock hash mismatch: {lock_path}")
    spec = get_spec(model_key)
    if spec.requires_model_assets:
        model = raw.get("model", {})
        if model.get("status") != "ready":
            raise RuntimeError(f"pinned weights for {model_key} are not ready: {model.get('error', model.get('status'))}")
        file_records = model.get("files", {})
        if not file_records:
            raise ValueError(f"environment manifest has no pinned weight files for {model_key}")
        for file_record in file_records.values():
            file_path = Path(file_record.get("path", ""))
            if file_record.get("status") != "ready" or not file_path.is_file() or hash_file(file_path) != file_record.get("sha256"):
                raise ValueError(f"pinned weight file hash mismatch for {model_key}: {file_path}")
    from .common import hash_bytes, canonical_json
    return {"manifest_sha256": hash_bytes(canonical_json(raw)), "manifest": raw, "python": str(_env_python(env))}


def _attempt_dir(run_dir: Path, key: str, device: str, fingerprint: str) -> Path:
    model_dir = run_dir / "models" / key
    count = len(list(model_dir.glob("attempt-*"))) + 1 if model_dir.exists() else 1
    path = model_dir / f"attempt-{count:02d}-{device}-{uuid.uuid4().hex[:6]}"
    path.mkdir(parents=True, exist_ok=False)
    # Reuse only adapter-owned candidate/checkpoint working directories from an
    # attempt with the same source/config/code/env fingerprint. Never overwrite.
    if model_dir.exists():
        previous = sorted(model_dir.glob("attempt-*/attempt_identity.json"), key=lambda p: p.stat().st_mtime, reverse=True)
        for identity_path in previous:
            try:
                identity = json.loads(identity_path.read_text(encoding="utf-8"))
                if identity.get("fingerprint") != fingerprint:
                    continue
                old = identity_path.parent
                for name in ("trials", "checkpoints", "training_state", "training_state.pt", "checkpoint.pt", "checkpoint.safetensors"):
                    source = old / name
                    target = path / name
                    if source.is_dir():
                        shutil.copytree(source, target, dirs_exist_ok=True)
                    elif source.is_file():
                        shutil.copy2(source, target)
                break
            except (OSError, ValueError):
                continue
    atomic_json(path / "attempt_identity.json", {"fingerprint": fingerprint, "model_key": key, "device": device})
    return path


def _run_worker(spec_key: str, action: str, attempt_dir: Path, run_dir: Path, device: str,
                smoke: bool, fingerprint: str, env_identity: dict[str, Any], log_path: Path,
                state_path: Path) -> tuple[dict[str, Any], int, str]:
    spec = get_spec(spec_key)
    python = _env_python(spec.environment)
    if not python.is_file():
        raise FileNotFoundError(f"isolated model environment not found: {python}")
    config = model_config(spec_key, smoke)
    if smoke:
        cohort_path = run_dir / "common_cohort.json"
        config["smoke_cohort_path"] = str(cohort_path)
        config["smoke_test_keys_path"] = str(cohort_path)
    context = {"model_key": spec_key, "source_root": str(SOURCE_ROOT), "attempt_dir": str(attempt_dir),
               "run_dir": str(run_dir), "device": device, "smoke": smoke, "config": config,
               "config_fingerprint": fingerprint, "action": action, "environment": spec.environment,
               "environment_identity": env_identity}
    context_path = attempt_dir / f"{action}-context.json"
    atomic_json(context_path, context)
    env = os.environ.copy()
    env["PYTHONUTF8"] = "1"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONPATH"] = str(REPO_ROOT) + (os.pathsep + env["PYTHONPATH"] if env.get("PYTHONPATH") else "")
    project_cache = REPO_ROOT / ".benchmark-cache"
    env["HF_HOME"] = str(project_cache / "hf")
    env["HF_HUB_CACHE"] = str(project_cache / "hf" / "hub")
    env["TORCH_HOME"] = str(project_cache / "torch")
    env["CUDA_CACHE_PATH"] = str(project_cache / "cuda")
    env["XDG_CACHE_HOME"] = str(project_cache)
    env["MPLCONFIGDIR"] = str(project_cache / "matplotlib")
    started = time.perf_counter()
    log_path.parent.mkdir(parents=True, exist_ok=True)
    with log_path.open("a", encoding="utf-8") as log:
        log.write(f"\n===== {action} device={device} started={datetime.now(timezone.utc).isoformat()} =====\n")
        log.flush()
    child = start_managed_process([str(python), "-u", "-m", "research.model_benchmark.worker", "--context", str(context_path)],
                                  cwd=REPO_ROOT, env=env)
    proc = child.process
    stdout_tail: deque[str] = deque(maxlen=40)
    stderr_tail: deque[str] = deque(maxlen=1000)
    write_lock = threading.Lock()

    def pump(stream: Any, label: str, tail: deque[str]) -> None:
        for line in iter(stream.readline, ""):
            tail.append(line)
            with write_lock, log_path.open("a", encoding="utf-8") as log:
                log.write(f"[{label}] {line}")

    threads = [threading.Thread(target=pump, args=(proc.stdout, "stdout", stdout_tail), daemon=True),
               threading.Thread(target=pump, args=(proc.stderr, "stderr", stderr_tail), daemon=True)]
    try:
        for thread in threads:
            thread.start()
        last_heartbeat = 0.0
        while proc.poll() is None:
            time.sleep(5)
            if time.monotonic() - last_heartbeat >= 60:
                try:
                    state = json.loads(state_path.read_text(encoding="utf-8"))
                    state["last_heartbeat_utc"] = datetime.now(timezone.utc).isoformat()
                    state["active_worker"] = {"model": spec_key, "action": action, "device": device, "pid": proc.pid}
                    atomic_json(state_path, state)
                except Exception:
                    pass
                last_heartbeat = time.monotonic()
    finally:
        # Kill any surviving child processes before joining pipe readers. A worker
        # that spawned a background process must not hold its pipes or CUDA context.
        child.close(kill_tree=True)
        for thread in threads:
            if thread.ident is not None:
                thread.join(timeout=5)
    elapsed = time.perf_counter() - started
    exit_code = proc.returncode
    with log_path.open("a", encoding="utf-8") as log:
        log.write(f"\n===== {action} exit={exit_code} elapsed={elapsed:.3f}s =====\n")
    stdout = "".join(stdout_tail)
    stderr = "".join(stderr_tail)
    response = {}
    if exit_code == 0:
        lines = [line for line in stdout.splitlines() if line.strip()]
        try:
            response = json.loads(lines[-1]) if lines else {}
        except json.JSONDecodeError:
            raise RuntimeError(f"worker {action} returned invalid JSON; see {log_path}")
        if response.get("ok") is not True:
            raise RuntimeError(f"worker {action} did not report ok=true; see {log_path}")
    return response.get("result", {}), exit_code, stderr


def _prediction_file(attempt: Path) -> Path:
    path = attempt / "predictions.parquet"
    if not path.is_file():
        raise FileNotFoundError(f"missing predictions.parquet in {attempt}")
    return path


def _validate_prediction(path: Path, key: str, expected_pairs: set[tuple[str, int]] | None = None) -> dict[str, Any]:
    import numpy as np
    import pandas as pd
    frame = pd.read_parquet(path)
    common = {"symbol", "open_time", "variant"}
    spec = get_spec(key)
    expected = common | ({"score_long", "score_short"} if spec.family == "rank" else {"pred_close_4h", "pred_return_4h"})
    missing = expected.difference(frame.columns)
    if missing:
        raise ValueError(f"{key} predictions missing required columns: {sorted(missing)}")
    if "variant" not in frame.columns:
        raise ValueError(f"{key} predictions must include variant")
    unique_key = ["symbol", "open_time", "variant"]
    if frame.duplicated(unique_key).any():
        raise ValueError(f"{key} prediction artifact has duplicate {unique_key}")
    if frame.empty:
        raise ValueError(f"{key} predictions are empty")
    coverage: dict[str, Any] = {}
    if spec.family == "rank":
        variants = set(frame["variant"].astype(str).unique())
        if variants != {"trained"}:
            raise ValueError(f"rank predictions must contain exactly variant='trained', got {sorted(variants)}")
        values = frame[["score_long", "score_short"]].to_numpy(dtype=float)
        if not np.isfinite(values).all():
            raise ValueError("rank predictions contain NaN or infinite scores")
    else:
        variants = set(frame["variant"].astype(str).unique())
        required_variants = {"pretrained", "finetuned"}
        if variants != required_variants:
            raise ValueError(f"forecast predictions must include pretrained and finetuned variants, got {sorted(variants)}")
        for variant in sorted(required_variants):
            subset = frame.loc[frame["variant"].astype(str).eq(variant)]
            values = subset[["pred_close_4h", "pred_return_4h"]].to_numpy(dtype=float)
            if not np.isfinite(values).all() or not subset["pred_close_4h"].gt(0).all():
                raise ValueError(f"{variant} forecast contains NaN/Inf or nonpositive predicted price")
            pairs = set((str(s), int(t)) for s, t in subset[["symbol", "open_time"]].itertuples(index=False, name=None))
            coverage[variant] = {"valid_pairs": len(pairs), "expected_pairs": len(expected_pairs) if expected_pairs is not None else None,
                                 "missing_pairs": len(expected_pairs - pairs) if expected_pairs is not None else None}
            if not pairs:
                raise ValueError(f"forecast variant {variant} contains no valid predictions")
    return coverage


def _is_oom(stderr: str, log_path: Path) -> bool:
    text = stderr + (log_path.read_text(encoding="utf-8", errors="replace") if log_path.exists() else "")
    return bool(re.search(r"out of memory|cuda error:.*memory|cuda out of memory|cublas_status_alloc_failed", text, re.I))


def _model_integrity(item: dict[str, Any], run_dir: Path, fingerprint: str) -> bool:
    if item.get("fingerprint") != fingerprint or item.get("status") != "SUCCESS" or not item.get("training", {}).get("trained"):
        return False
    attempt = Path(item.get("attempt_dir", ""))
    if not attempt.is_dir() or not item.get("predict", {}).get("fresh_load"):
        return False
    artifacts = item.get("artifact_hashes", {})
    if not verify_artifacts(attempt, artifacts):
        return False
    pred = attempt / "predictions.parquet"
    if not pred.is_file() or hash_file(pred) != item.get("predict", {}).get("predictions_sha256"):
        return False
    return (run_dir / "comparison.md").is_file()


def _completed_run_is_valid(run_dir: Path, smoke: bool) -> bool:
    try:
        manifest = json.loads((run_dir / "run_manifest.json").read_text(encoding="utf-8"))
        if manifest.get("status") != "SUCCESS" or manifest.get("smoke") is not smoke:
            return False
        source = dataset_identity(SOURCE_ROOT)
        envs, fingerprints = _current_identity(source, smoke)
        if manifest.get("source_identity") != source or manifest.get("fingerprints") != fingerprints:
            return False
        for key in MODEL_KEYS:
            spec = get_spec(key)
            if envs[spec.environment].get("error"):
                return False
            if not _model_integrity(manifest.get("models", {}).get(key, {}), run_dir, fingerprints[key]):
                return False
        return all((run_dir / name).is_file() for name in ("comparison.md", "comparison.csv", "comparison.json"))
    except Exception:
        return False


def _current_identity(source: dict[str, Any], smoke: bool) -> tuple[dict[str, Any], dict[str, str]]:
    envs: dict[str, Any] = {}
    fingerprints: dict[str, str] = {}
    for key in MODEL_KEYS:
        spec = get_spec(key)
        if spec.environment not in envs:
            try:
                envs[spec.environment] = _env_identity(spec.environment, key)
            except Exception as exc:
                envs[spec.environment] = {"error": f"{type(exc).__name__}: {exc}"}
        fingerprints[key] = benchmark_fingerprint(key, {**source, "environment": envs[spec.environment]}, smoke)
    return envs, fingerprints


def _lightgbm_predictions(panel: Any, cohort: Any, run_dir: Path) -> tuple[Any | None, dict[str, Any]]:
    """Re-run the frozen existing LightGBM on the exact shared cohort."""
    import pandas as pd
    models_dir = SOURCE_ROOT / "models"
    meta_path = models_dir / "lgbm_metadata.json"
    try:
        metadata = json.loads(meta_path.read_text(encoding="utf-8"))
        if int(metadata.get("pipeline_version", 0)) < 3:
            raise ValueError("existing LightGBM metadata is not pipeline v3")
        from research.model_research.features_and_labels import FEATURE_COLUMNS
        import lightgbm as lgb
        rows = panel.merge(cohort[["symbol", "open_time"]], on=["symbol", "open_time"], how="inner", validate="one_to_one")
        predictions = rows[["symbol", "open_time"]].copy()
        predictions["variant"] = "frozen_existing_lgbm"
        for direction, filename in (("long", "lgbm_long_ranker.txt"), ("short", "lgbm_short_ranker.txt")):
            record = metadata.get(f"{direction}_model", {})
            model_path = models_dir / filename
            expected = record.get("sha256")
            if not expected or hash_file(model_path) != expected:
                raise ValueError(f"existing LightGBM source weight hash mismatch: {filename}")
            model = lgb.Booster(model_file=str(model_path))
            predictions[f"score_{direction}"] = model.predict(rows[FEATURE_COLUMNS])
        output = run_dir / "baselines" / "lightgbm_common_predictions.parquet"
        output.parent.mkdir(parents=True, exist_ok=True)
        predictions.to_parquet(output, index=False)
        return predictions, {"status": "PASSED", "source_metadata_sha256": hash_file(meta_path), "prediction_path": str(output), "rows": len(predictions)}
    except Exception as exc:
        return None, {"status": "FAILED", "error": f"{type(exc).__name__}: {exc}"}


def attach_common_metrics(models: dict[str, dict[str, Any]], common: dict[str, Any], baseline: dict[str, Any]) -> None:
    """Keep the fixed LightGBM reference outside the four trainable model states."""
    for key, metrics in common.get("models", {}).items():
        if key == "lightgbm_existing":
            baseline["common_metrics"] = metrics
        elif key in models:
            models[key]["common_metrics"] = metrics


def run_in_order(keys: tuple[str, ...], callback: Any) -> dict[str, dict[str, Any]]:
    """Run each registered model independently; exceptions never stop later keys."""
    results: dict[str, dict[str, Any]] = {}
    for key in keys:
        try:
            results[key] = callback(key)
        except Exception as exc:
            results[key] = {"status": "FAILED", "evaluation_status": "FAILED",
                            "failures": [{"error": f"{type(exc).__name__}: {exc}"}]}
    return results


def _execute_model(key: str, run_dir: Path, smoke: bool, fingerprint: str, env_identity: dict[str, Any],
                   expected_pairs: set[tuple[str, int]], identity_check: Any) -> dict[str, Any]:
    spec = get_spec(key)
    log_path = run_dir / "logs" / f"{key}.log"
    device = "cpu" if spec.family == "rank" else "cuda"
    failures = []
    for attempt_no in range(2):
        current_device = "cpu" if attempt_no else device
        attempt = _attempt_dir(run_dir, key, current_device, fingerprint)
        started = time.perf_counter()
        try:
            identity_check(key)
            training, train_rc, train_stderr = _run_worker(key, "train", attempt, run_dir, current_device, smoke,
                                                           fingerprint, env_identity, log_path, run_dir / "run_manifest.json")
            if train_rc:
                if attempt_no == 0 and current_device == "cuda" and _is_oom(train_stderr, log_path):
                    failures.append({"device": current_device, "error": "CUDA OOM during training; retrying CPU in new attempt"})
                    continue
                raise RuntimeError(f"train subprocess exit code {train_rc}")
            # Training may optionally emit a prediction artifact; the required evaluation
            # prediction is always produced by the separate fresh-load process below.
            train_pred = attempt / "predictions.parquet"
            if train_pred.is_file():
                (attempt / "training_predictions.sha256").write_text(hash_file(train_pred) + "\n", encoding="ascii")
            identity_check(key)
            prediction, pred_rc, pred_stderr = _run_worker(key, "predict", attempt, run_dir, current_device, smoke,
                                                           fingerprint, env_identity, log_path, run_dir / "run_manifest.json")
            if pred_rc:
                if attempt_no == 0 and current_device == "cuda" and _is_oom(pred_stderr, log_path):
                    failures.append({"device": current_device, "error": "CUDA OOM during fresh-load prediction; retrying CPU in new attempt"})
                    continue
                raise RuntimeError(f"fresh-load prediction subprocess exit code {pred_rc}")
            identity_check(key)
            pred_path = _prediction_file(attempt)
            prediction["cohort_coverage"] = _validate_prediction(pred_path, key, expected_pairs)
            if prediction.get("fresh_load") is not True:
                raise RuntimeError("worker did not verify fresh-load prediction")
            steps = training.get("training_steps", training.get("optimizer_steps", training.get("optimizer_updates", training.get("updates", 0))))
            if int(steps) < 1:
                raise RuntimeError("adapter reported no optimizer/training steps")
            # Adapter may return relative or absolute artifact hashes. We recompute anything it declared.
            declared = training.get("artifact_hashes", {})
            if not isinstance(declared, dict) or not declared:
                raise RuntimeError("adapter must return artifact_hashes for saved trained weights")
            declared = dict(declared)
            metadata_path_value = training.get("metadata_path")
            if metadata_path_value:
                metadata_path = Path(metadata_path_value)
                if not metadata_path.is_absolute():
                    metadata_path = attempt / metadata_path
                if metadata_path.is_file():
                    declared[str(metadata_path.relative_to(attempt))] = hash_file(metadata_path)
            for rel, digest in declared.items():
                artifact = Path(rel)
                if not artifact.is_absolute():
                    artifact = attempt / artifact
                if not artifact.is_file() or hash_file(artifact) != digest:
                    raise RuntimeError(f"trained artifact hash mismatch: {rel}")
            artifact_hashes = {str(Path(rel).relative_to(attempt) if Path(rel).is_absolute() else Path(rel)): digest for rel, digest in declared.items()}
            actual_device = str(training.get("training_device", training.get("device", current_device)))
            return {"status": "SUCCESS", "fingerprint": fingerprint, "device": actual_device,
                    "attempt_dir": str(attempt), "train_seconds": round(time.perf_counter() - started, 3),
                    "training": training, "predict": prediction, "artifact_hashes": artifact_hashes,
                    "predictions_path": str(pred_path), "failures": failures, "evaluation_status": "PENDING"}
        except Exception as exc:
            failures.append({"device": current_device, "attempt_dir": str(attempt), "error": f"{type(exc).__name__}: {exc}"})
            if isinstance(exc, IdentityDriftError):
                return {"status": "FAILED", "fingerprint": fingerprint, "device": current_device,
                        "failures": failures, "evaluation_status": "FAILED", "identity_drift": True}
            if attempt_no == 0 and current_device == "cuda" and _is_oom(str(exc), log_path):
                continue
            break
    return {"status": "FAILED", "fingerprint": fingerprint, "device": device,
            "train_seconds": None, "failures": failures, "evaluation_status": "FAILED"}


def _make_run(run_dir: Path, new_run: bool, smoke: bool) -> dict[str, Any]:
    panel, klines, source_id = load_source(SOURCE_ROOT)
    cohort, cohort_meta = freeze_common_cohort(panel, klines, run_dir, source_id, smoke=smoke)
    models: dict[str, Any] = {}
    env_identities, fingerprints = _current_identity(source_id, smoke)
    state_path = run_dir / "run_manifest.json"
    if state_path.exists():
        manifest = json.loads(state_path.read_text(encoding="utf-8"))
        if manifest.get("source_identity") != source_id or manifest.get("fingerprints") != fingerprints:
            raise ValueError("run identity mismatch; use -NewRun to create a separate run")
        models.update(manifest.get("models", {}))
    manifest = {"schema": 1, "run_id": run_dir.name, "started_utc": datetime.now(timezone.utc).isoformat(),
                "status": "RUNNING", "source_root": str(SOURCE_ROOT), "source_identity": source_id,
                "fingerprints": fingerprints, "environment_identities": env_identities, "common_cohort": cohort_meta,
                "test_scope": "既有資料研究比較；TEST 曾被檢視，不是全新獨立測試", "smoke": smoke, "models": models}
    atomic_json(state_path, manifest)
    results: dict[str, Any] = {"models": {}}
    identity_drift = False

    def identity_check(key: str) -> None:
        spec = get_spec(key)
        try:
            source_now = dataset_identity(SOURCE_ROOT)
            env_now = _env_identity(spec.environment, key)
            actual = benchmark_fingerprint(key, {**source_now, "environment": env_now}, smoke)
        except Exception as exc:
            raise IdentityDriftError(f"run identity cannot be verified before {key} stage: {type(exc).__name__}: {exc}") from exc
        if actual != fingerprints[key]:
            raise IdentityDriftError(f"run identity changed before {key} stage; expected {fingerprints[key]}, got {actual}")

    def run_one(key: str) -> dict[str, Any]:
        nonlocal identity_drift
        if identity_drift:
            return {"status": "FAILED", "fingerprint": fingerprints[key], "device": "unknown",
                    "failures": [{"error": "run stopped because source/code/environment identity drifted earlier"}],
                    "evaluation_status": "FAILED", "identity_drift": True}
        if env_identities[get_spec(key).environment].get("error"):
            item = {"status": "FAILED", "fingerprint": fingerprints[key], "device": "unknown",
                    "failures": [{"error": env_identities[get_spec(key).environment]["error"]}], "evaluation_status": "FAILED"}
            models[key] = item
            manifest["models"] = models
            atomic_json(state_path, manifest)
            return item
        try:
            identity_check(key)
        except IdentityDriftError as exc:
            identity_drift = True
            manifest["identity_drift"] = str(exc)
            atomic_json(state_path, manifest)
            return {"status": "FAILED", "fingerprint": fingerprints[key], "device": "unknown",
                    "failures": [{"error": str(exc)}], "evaluation_status": "FAILED", "identity_drift": True}
        previous = models.get(key, {})
        fp = fingerprints[key]
        if not new_run and _model_integrity(previous, run_dir, fp):
            item = previous
        elif env_identities[get_spec(key).environment].get("error"):
            item = {"status": "FAILED", "fingerprint": fp, "device": "unknown", "failures": [{"error": env_identities[get_spec(key).environment]["error"]}], "evaluation_status": "FAILED"}
        else:
                expected_pairs = set((str(s), int(t)) for s, t in cohort[["symbol", "open_time"]].itertuples(index=False, name=None))
                item = _execute_model(key, run_dir, smoke, fp, env_identities[get_spec(key).environment], expected_pairs, identity_check)
        if item.get("identity_drift"):
            identity_drift = True
            manifest["identity_drift"] = item.get("failures", [{}])[-1].get("error", "identity drift")
        models[key] = item
        manifest["models"] = models
        atomic_json(state_path, manifest)
        results["models"][key] = dict(item)
        if item.get("status") == "SUCCESS":
            import pandas as pd
            try:
                pred = pd.read_parquet(item["predictions_path"])
                item["full_metrics"] = evaluate_ranker(pred, panel) if get_spec(key).family == "rank" else evaluate_forecaster(pred, panel)
                item["evaluation_status"] = "PASSED"
            except Exception as exc:
                item["evaluation_status"] = "FAILED"
                item["evaluation_error"] = f"{type(exc).__name__}: {exc}"
                item["status"] = "FAILED"
        models[key] = item
        manifest["models"] = models
        atomic_json(state_path, manifest)
        return item

    results["models"] = run_in_order(MODEL_KEYS, run_one)
    successful = {k: v for k, v in results["models"].items() if v.get("status") == "SUCCESS" and v.get("evaluation_status") == "PASSED"}
    predictions = {}
    for k, item in successful.items():
        import pandas as pd
        predictions[k] = pd.read_parquet(item["predictions_path"])
    lgbm_baseline = None
    lgbm_status = {"status": "SKIPPED"}
    if predictions:
        lgbm_baseline, lgbm_status = _lightgbm_predictions(panel, cohort, run_dir)
        if lgbm_baseline is not None:
            predictions["lightgbm_existing"] = lgbm_baseline
    try:
        if predictions:
            results["common_summary"] = evaluate_common(predictions, cohort, panel)
            attach_common_metrics(results["models"], results["common_summary"], lgbm_status)
        else:
            results["common_summary"] = {"cohort_pairs": len(cohort), "intersection_pairs": 0, "excluded_pairs": len(cohort), "models": {}}
    except Exception as exc:
        results["common_error"] = f"{type(exc).__name__}: {exc}"
    results["lightgbm_baseline"] = lgbm_status
    common_has_samples = int(results.get("common_summary", {}).get("intersection_groups", 0)) > 0
    passed = (not smoke and not identity_drift and len(successful) == len(MODEL_KEYS) and common_has_samples
              and "common_error" not in results and lgbm_status.get("status") == "PASSED"
              and all(v.get("common_metrics") and (v["common_metrics"].get("evaluated_groups", 0) > 0 if "directions" in v["common_metrics"] else v["common_metrics"].get("samples", 0) > 0)
                      for k, v in results["models"].items() if k in successful))
    status = "SUCCESS" if passed else ("PARTIAL" if successful else "FAILED")
    manifest["status"] = status
    if smoke:
        manifest["status_reason"] = "SMOKE_ONLY"
    elif identity_drift:
        manifest["status_reason"] = "IDENTITY_DRIFT"
    manifest["finished_utc"] = datetime.now(timezone.utc).isoformat()
    manifest["models"] = results["models"]
    atomic_json(state_path, manifest)
    write_reports(run_dir, manifest, results)
    return manifest


def _find_resumable(source_identity: dict[str, Any], fingerprints: dict[str, str]) -> Path | None:
    if not RUNS_ROOT.exists():
        return None
    candidates = sorted((p for p in RUNS_ROOT.iterdir() if p.is_dir() and (p / "run_manifest.json").is_file()), key=lambda p: p.name, reverse=True)
    for path in candidates:
        try:
            data = json.loads((path / "run_manifest.json").read_text(encoding="utf-8"))
            if (data.get("status") != "SUCCESS" and data.get("source_identity") == source_identity
                    and data.get("fingerprints") == fingerprints):
                return path
        except Exception:
            continue
    return None


def _find_latest_run() -> Path | None:
    if not RUNS_ROOT.exists():
        return None
    candidates = sorted((p for p in RUNS_ROOT.iterdir() if p.is_dir() and (p / "run_manifest.json").is_file()), key=lambda p: p.name, reverse=True)
    return candidates[0] if candidates else None


def _find_completed(source_identity: dict[str, Any], fingerprints: dict[str, str], smoke: bool) -> Path | None:
    if not RUNS_ROOT.exists():
        return None
    candidates = sorted((p for p in RUNS_ROOT.iterdir() if p.is_dir() and (p / "run_manifest.json").is_file()), key=lambda p: p.name, reverse=True)
    for path in candidates:
        try:
            data = json.loads((path / "run_manifest.json").read_text(encoding="utf-8"))
            if data.get("status") == "SUCCESS" and data.get("source_identity") == source_identity and data.get("fingerprints") == fingerprints:
                if _completed_run_is_valid(path, smoke):
                    return path
        except Exception:
            continue
    return None


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--new-run", action="store_true")
    parser.add_argument("--run-dir", type=Path)
    parser.add_argument("--smoke", action="store_true", help="small adapter contract smoke run; never a full benchmark")
    args = parser.parse_args(argv)
    if args.run_dir and args.new_run:
        parser.error("--run-dir and --new-run cannot be combined")
    if args.run_dir:
        run_dir = args.run_dir.resolve()
        try:
            run_dir.relative_to(RUNS_ROOT.resolve())
        except ValueError:
            parser.error(f"--run-dir must be within {RUNS_ROOT}")
        if run_dir.exists() and (run_dir / "run_manifest.json").exists():
            if _completed_run_is_valid(run_dir, args.smoke):
                print(run_dir / "comparison.md")
                return 0
    elif args.new_run:
        run_dir = RUNS_ROOT / _timestamp_id()
    else:
        source = dataset_identity(SOURCE_ROOT)
        _, fingerprints = _current_identity(source, args.smoke)
        completed = _find_completed(source, fingerprints, args.smoke)
        if completed:
            print(completed / "comparison.md")
            return 0
        existing = _find_resumable(source, fingerprints)
        run_dir = existing or RUNS_ROOT / _timestamp_id()
    run_dir.mkdir(parents=True, exist_ok=True)
    CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    lock = RUNS_ROOT.parent / ".benchmark-owner.lock"
    try:
        with exclusive_lock(lock):
            result = _make_run(run_dir, args.new_run, args.smoke)
        print(f"{result['status']}: {run_dir / 'comparison.md'}")
        return 0 if result["status"] == "SUCCESS" else 2
    except Exception as exc:
        print(f"FAILED: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
