"""GitHub/Drive orchestration; heavy model packages stay in isolated processes."""
from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import uuid
import zipfile
from pathlib import Path
from typing import Any

from .common import atomic_json, hash_file

DATASET_ID = "v3-20261110-004810"
SOURCE_REL = "data-reruns/20261110-004810/model-research"
INPUT_FILES = (
    "datasets/dataset_manifest.json", "datasets/research_panel.parquet",
    "datasets/klines_1h.parquet", "datasets/funding_rates.parquet",
    "models/lgbm_metadata.json", "models/lgbm_long_ranker.txt", "models/lgbm_short_ranker.txt",
)


def build_inputs(source: Path, destination: Path) -> dict[str, Any]:
    """Only immutable data and reference models; never includes source code."""
    destination.mkdir(parents=True, exist_ok=True)
    archive = destination / "research-inputs.zip"
    manifest_path = destination / "assets-manifest.json"
    if archive.exists() or manifest_path.exists():
        raise FileExistsError("input delivery already exists; use a new destination")
    records = []
    for relative in INPUT_FILES:
        path = source / relative
        if not path.is_file() or path.is_symlink():
            raise FileNotFoundError(path)
        records.append({"path": relative, "size_bytes": path.stat().st_size, "sha256": hash_file(path)})
    with zipfile.ZipFile(archive, "x", compression=zipfile.ZIP_DEFLATED) as z:
        for record in records:
            z.write(source / record["path"], record["path"])
    manifest = {"schema": 1, "dataset_id": DATASET_ID, "files": records,
                "archive_sha256": hash_file(archive), "archive_size_bytes": archive.stat().st_size}
    atomic_json(manifest_path, manifest)
    return manifest


def install_inputs(archive: Path, manifest_path: Path, destination: Path) -> dict[str, Any]:
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("dataset_id") != DATASET_ID or manifest.get("schema") != 1:
        raise ValueError("unsupported dataset manifest")
    if hash_file(archive) != manifest["archive_sha256"]:
        raise ValueError("input ZIP hash mismatch")
    expected = {r["path"]: r for r in manifest["files"]}
    if len(manifest["files"]) != len(INPUT_FILES) or set(expected) != set(INPUT_FILES):
        raise ValueError("input whitelist mismatch")
    with zipfile.ZipFile(archive) as z:
        infos = z.infolist()
        if len(infos) != len(expected) or {i.filename for i in infos} != set(expected):
            raise ValueError("unexpected or duplicate ZIP members")
        if sum(i.file_size for i in infos) > 512 * 1024**2:
            raise ValueError("input ZIP exceeds 512 MiB uncompressed limit")
        # Validate everything before creating any destination files.
        import hashlib
        for info in infos:
            record = expected[info.filename]
            if info.file_size != record["size_bytes"]:
                raise ValueError("input file size mismatch")
            with z.open(info) as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            if digest != record["sha256"]:
                raise ValueError(f"input file hash mismatch: {info.filename}")
        if destination.exists():
            for relative, record in expected.items():
                path = destination / relative
                if not path.is_file() or path.is_symlink() or hash_file(path) != record["sha256"]:
                    raise ValueError("existing dataset differs; original files were preserved")
            return manifest
        destination.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=destination.parent) as tmp:
            stage = Path(tmp) / "source"
            stage.mkdir()
            for relative in expected:
                target = stage / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                with z.open(relative) as inp, target.open("xb") as out:
                    shutil.copyfileobj(inp, out)
            stage.rename(destination)
    return manifest


def export_run(run_dir: Path, drive_root: Path) -> Path:
    """Standalone export: no notebook globals or model/environment imports."""
    run_dir = run_dir.resolve()
    manifest_path = run_dir / "run_manifest.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"missing run manifest: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("status") in {"RUNNING", "PENDING"}:
        raise RuntimeError("run is still marked active; refusing a final export")
    # Never follow links out of a run when publishing its files.
    if any(p.is_symlink() for p in run_dir.rglob("*")):
        raise ValueError("run contains symbolic links")
    provenance = run_dir / "colab_execution.json"
    session = str(json.loads(provenance.read_text(encoding="utf-8")).get("session_id") if provenance.is_file() else "recovered")
    if not re.fullmatch(r"[A-Za-z0-9_-]+", session):
        raise ValueError("invalid session id")
    target_root = drive_root / "outputs" / session / run_dir.name
    target_root.mkdir(parents=True, exist_ok=True)
    name = f"{run_dir.name}-{uuid.uuid4().hex[:8]}"
    with tempfile.TemporaryDirectory() as tmp:
        local = Path(shutil.make_archive(str(Path(tmp) / name), "zip", root_dir=run_dir.parent, base_dir=run_dir.name))
        digest = hash_file(local)
        target = target_root / (name + ".zip")
        uploading = target.with_suffix(".zip.uploading")
        shutil.copyfile(local, uploading)
        if hash_file(uploading) != digest:
            raise IOError("Drive export hash mismatch; incomplete .uploading file retained")
        os.replace(uploading, target)
        atomic_json(target.with_suffix(".sha256.json"), {"sha256": digest, "size_bytes": target.stat().st_size,
                    "status": manifest.get("status"), "archive": target.name})
    print(f"{manifest.get('status')}: {target}", flush=True)
    return target


def configure(repo: Path, work: Path) -> dict[str, str]:
    from .colab import make_colab_environment
    env = make_colab_environment(repo, work / "source", work / "runs", work / "cache", work / "envs", work / "tmp")
    env["MPLBACKEND"] = "Agg"
    return env


def gpu_probe(timeout: int = 45) -> dict[str, Any]:
    subprocess.run(["nvidia-smi"], check=True, timeout=15)
    code = """import json,torch
assert torch.cuda.is_available(), 'CUDA unavailable'
x=torch.ones((2,2),device='cuda'); y=x@x; torch.cuda.synchronize()
assert torch.isfinite(y).all().item()
print(json.dumps({'gpu':torch.cuda.get_device_name(0),'memory_bytes':torch.cuda.get_device_properties(0).total_memory}))
"""
    result = subprocess.run([sys.executable, "-I", "-c", code], capture_output=True, text=True, timeout=timeout, check=True)
    info = json.loads(result.stdout.strip().splitlines()[-1])
    print(json.dumps(info, ensure_ascii=False))
    return info


def prepare(repo: Path, work: Path, drive: Path, *, models: list[str] | None = None) -> dict[str, str]:
    from .colab import prepare_environments
    from .managed_python import prepare_managed_python
    env = configure(repo, work)
    if models is not None:
        from .registry import get_spec
        if not models or len(set(models)) != len(models):
            raise ValueError("invalid model selection")
        for key in models:
            get_spec(key)
        env["FADACHI_MODEL_BENCHMARK_MODELS"] = ",".join(models)
    inputs = drive / "inputs" / DATASET_ID
    # Copy large archive off Drive once before seek-heavy ZIP reads.
    cache = work / "cache" / "inputs"
    cache.mkdir(parents=True, exist_ok=True)
    for name in ("research-inputs.zip", "assets-manifest.json"):
        source = inputs / name
        target = cache / name
        if not target.exists() or hash_file(target) != hash_file(source):
            shutil.copyfile(source, target)
    install_inputs(cache / "research-inputs.zip", cache / "assets-manifest.json", work / "source")
    runtime = prepare_managed_python(work / "python312", work / "cache" / "python", progress=print)
    env["FADACHI_MODEL_BENCHMARK_PYTHON"] = runtime["python"]
    prepare_environments(repo, env)
    return env


def execute(repo: Path, work: Path, drive: Path, *, action: str, mode: str,
            models: list[str], resume_run: Path | None = None, model_run: Path | None = None,
            resume_session: str | None = None) -> Path:
    """Explicit train and inference routes. Inference never invokes the trainer."""
    from .colab import python_executable, run_with_snapshots
    from .snapshots import SnapshotStore
    if action not in {"train", "infer"} or mode not in {"full", "smoke"}:
        raise ValueError("invalid action or run mode")
    if not models or len(set(models)) != len(models) or not set(models) <= {"catboost", "xgboost", "chronos2", "timesfm25"}:
        raise ValueError("invalid model selection")
    env = configure(repo, work)
    managed = work / "python312" / "python" / "bin" / "python3.12"
    if managed.is_file():
        env["FADACHI_MODEL_BENCHMARK_PYTHON"] = str(managed)
    session = uuid.uuid4().hex[:16]
    print(f"Snapshot session ID: {session}", flush=True)
    if action == "infer":
        if model_run is None or resume_run is not None:
            raise ValueError("inference requires MODEL_RUN_PATH and no training resume path")
        run = work / "runs" / ("infer-" + uuid.uuid4().hex[:12])
        command = [str(python_executable(work / "envs", "rank")), "-u", "-m", "research.model_benchmark.inference",
                   "--model-run", str(model_run), "--output", str(run), "--models", ",".join(models)]
        run.mkdir(parents=True, exist_ok=False)
        log = work / "tmp" / (run.name + ".log")
        log.parent.mkdir(parents=True, exist_ok=True)
        with log.open("w", encoding="utf-8") as stream:
            result = subprocess.run(command, cwd=repo, env=env, stdout=stream, stderr=subprocess.STDOUT)
        print(log.read_text(encoding="utf-8")[-4000:])
    else:
        run = resume_run or work / "runs" / ("colab-" + uuid.uuid4().hex[:16] + "-" + mode)
        run = run.resolve()
        run.relative_to((work / "runs").resolve())
        if resume_run and not (run / "run_manifest.json").is_file():
            if not resume_session:
                raise FileNotFoundError("resume run missing: supply RESUME_SESSION_ID for Drive restore")
            from .colab import restore_latest_snapshot
            probe = """import json,sys
from research.model_benchmark import runner as r
from research.model_benchmark.config import dataset_identity,portable_identity
r.MODEL_KEYS=tuple(json.loads(sys.argv[1])); s=dataset_identity(); e,f=r._current_identity(s,sys.argv[2]=='smoke')
print(json.dumps(portable_identity(s,f,e)))
"""
            proc = subprocess.run([str(python_executable(work / "envs", "rank")), "-c", probe,
                                   json.dumps(models), mode], cwd=repo, env=env, text=True, capture_output=True, check=True)
            identity = json.loads(proc.stdout.strip().splitlines()[-1])
            old_env = os.environ.copy()
            try:
                os.environ.update(env)
                restore_latest_snapshot(SnapshotStore(drive / "outputs", session), run_id=run.name,
                    source_session_id=resume_session, local_runs_root=work / "runs", expected_identity=identity)
            finally:
                os.environ.clear()
                os.environ.update(old_env)
        command = [str(python_executable(work / "envs", "rank")), "-u", "-m", "research.model_benchmark.runner",
                   "--run-dir", str(run), "--models", ",".join(models)]
        if mode == "smoke":
            command.append("--smoke")
        print(f"Run path: {run}", flush=True)
        try:
            result = run_with_snapshots(command, repo_root=repo, env=env, run_root=run,
                        store=SnapshotStore(drive / "outputs", session), log_path=work / "tmp" / (run.name + ".log"))
        except RuntimeError as exc:
            # Snapshot transport failure must not prevent saving a finished run.
            if not (run / "run_manifest.json").is_file():
                raise
            if json.loads((run / "run_manifest.json").read_text(encoding="utf-8")).get("status") == "RUNNING":
                raise
            result = {"snapshot_error": str(exc)}
            atomic_json(run / "snapshot_transport_error.json", result)
            print(f"Snapshot transport failed; preserving finished result: {exc}", flush=True)
    path = run / "run_manifest.json"
    if path.is_file():
        state = json.loads(path.read_text(encoding="utf-8"))
        # Notebook provenance is separate from the immutable training manifest.
        atomic_json(run / "colab_execution.json", {"session_id": session, "code_commit": subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=repo, text=True).strip(), "action": action, "models": models})
        print(f"Status: {state.get('status')} | {run / 'comparison.md'}", flush=True)
        export_run(run, drive)
    else:
        raise RuntimeError(f"process did not produce a manifest: {result}; inspect {work / 'tmp'}")
    return run
