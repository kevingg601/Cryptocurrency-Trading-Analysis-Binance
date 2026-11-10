"""Colab runtime checks, environment preparation and resumable runner helpers."""
from __future__ import annotations

import json
import os
import platform
import re
import signal
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Callable

from .snapshots import SnapshotStore, restore_snapshot


def make_colab_environment(
    repo_root: Path,
    source_root: Path,
    runs_root: Path,
    cache_root: Path,
    env_root: Path,
    tmp_root: Path,
) -> dict[str, str]:
    """Return the exact cross-platform path contract consumed by benchmark config."""
    roots = {
        "FADACHI_MODEL_BENCHMARK_ROOT": repo_root,
        "FADACHI_MODEL_BENCHMARK_SOURCE_ROOT": source_root,
        "FADACHI_MODEL_BENCHMARK_RUNS_ROOT": runs_root,
        "FADACHI_MODEL_BENCHMARK_CACHE_ROOT": cache_root,
        "FADACHI_MODEL_BENCHMARK_ENV_ROOT": env_root,
        "FADACHI_MODEL_BENCHMARK_TMP_ROOT": tmp_root,
    }
    result = os.environ.copy()
    result.update({key: str(path.resolve()) for key, path in roots.items()})
    # Do not let a VS Code/Colab kernel's Python install override packages in
    # the pinned 3.12 child interpreters. PATH remains available for CUDA and
    # system executables; Python import configuration is explicitly scoped.
    for key in ("PYTHONHOME", "VIRTUAL_ENV", "PYTHONUSERBASE"):
        result.pop(key, None)
    result["PYTHONUTF8"] = "1"
    result["PYTHONNOUSERSITE"] = "1"
    result["MPLBACKEND"] = "Agg"
    result["PYTHONPATH"] = str(repo_root.resolve())
    return result


SUPPORTED_KERNEL_PYTHONS = ((3, 12), (3, 13))
TRAINING_PYTHON_ENV = "FADACHI_MODEL_BENCHMARK_PYTHON"


def _kernel_python_version() -> tuple[int, int]:
    return int(sys.version_info.major), int(sys.version_info.minor)


def validate_kernel_python(version: tuple[int, int], expected_python: tuple[int, int] | None = None) -> None:
    supported = (expected_python,) if expected_python is not None else SUPPORTED_KERNEL_PYTHONS
    if version not in supported:
        expected = " or ".join(f"{major}.{minor}" for major, minor in supported)
        raise RuntimeError(
            f"Python {expected} kernel required; got {version[0]}.{version[1]}. "
            "The notebook kernel may use Python 3.12 or 3.13; model training always uses the pinned project Python 3.12 environment."
        )


def preflight(*, require_a100: bool = True, expected_python: tuple[int, int] | None = None) -> dict[str, Any]:
    """Fail before training when runtime/Python/GPU requirements are not met."""
    if platform.system() != "Linux":
        raise RuntimeError(f"Colab runner requires Linux; got {platform.system()}")
    validate_kernel_python(_kernel_python_version(), expected_python)
    disk = shutil.disk_usage("/content")
    try:
        import torch
    except Exception as exc:
        raise RuntimeError(f"Colab runtime PyTorch probe failed: {type(exc).__name__}: {exc}") from exc
    if not torch.cuda.is_available():
        raise RuntimeError("No CUDA GPU is available. Select a Colab GPU runtime before running this notebook.")
    device = torch.cuda.get_device_name(0)
    total_memory = int(torch.cuda.get_device_properties(0).total_memory)
    try:
        probe = torch.ones((2, 2), device="cuda") @ torch.ones((2, 2), device="cuda")
        torch.cuda.synchronize()
        if tuple(probe.shape) != (2, 2) or not bool(torch.isfinite(probe).all().item()):
            raise RuntimeError("CUDA tensor operation returned an invalid result")
    except Exception as exc:
        raise RuntimeError(f"CUDA device is allocated but a tensor operation failed: {type(exc).__name__}: {exc}") from exc
    if require_a100 and "a100" not in device.casefold():
        raise RuntimeError(f"A100 was requested but Colab assigned {device!r}; no training was started.")
    if disk.free < 8 * 1024**3:
        raise RuntimeError(f"At least 8 GiB free in /content is required; found {disk.free / 1024**3:.1f} GiB.")
    return {
        "platform": platform.platform(),
        "python": sys.version.split()[0],
        "torch": torch.__version__,
        "torch_cuda": torch.version.cuda,
        "cuda_available": bool(torch.cuda.is_available()),
        "gpu_name": device,
        "gpu_memory_bytes": total_memory,
        "content_free_bytes": disk.free,
        "a100_verified": "a100" in device.casefold(),
        "cuda_tensor_op_passed": True,
    }


def python_executable(env_root: Path, environment: str) -> Path:
    suffix = "Scripts/python.exe" if os.name == "nt" else "bin/python"
    return env_root / environment / suffix


def training_python(env: dict[str, str]) -> Path:
    """Return and verify the dedicated Python 3.12 coordinator executable.

    The notebook kernel can be 3.13. It must never be used to create the pinned
    model environments or calculate run identities.
    """
    configured = env.get(TRAINING_PYTHON_ENV) or os.environ.get(TRAINING_PYTHON_ENV)
    if configured:
        python = Path(configured).expanduser().resolve()
    elif _kernel_python_version() == (3, 12):
        python = Path(sys.executable).resolve()
    elif env.get("FADACHI_MODEL_BENCHMARK_ENV_ROOT"):
        candidate = python_executable(Path(env["FADACHI_MODEL_BENCHMARK_ENV_ROOT"]), "rank")
        if not candidate.is_file():
            raise RuntimeError(
                f"{TRAINING_PYTHON_ENV} must point to the project-managed Python 3.12 executable; "
                "the VS Code/Colab Python 3.13 kernel is only for notebook coordination."
            )
        python = candidate.resolve()
    else:
        raise RuntimeError(
            f"{TRAINING_PYTHON_ENV} must point to the project-managed Python 3.12 executable; "
            "the VS Code/Colab Python 3.13 kernel is only for notebook coordination."
        )
    if not python.is_file():
        raise FileNotFoundError(f"managed Python 3.12 executable does not exist: {python}")
    probe = subprocess.run(
        [str(python), "-I", "-c", "import json,sys; print(json.dumps({'version': list(sys.version_info[:2]), 'executable': sys.executable}))"],
        capture_output=True, text=True, encoding="utf-8", check=False,
    )
    if probe.returncode:
        raise RuntimeError(f"Could not probe managed training Python {python}: {probe.stderr[-2000:]}")
    try:
        info = json.loads(probe.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError) as exc:
        raise RuntimeError(f"Managed training Python returned invalid version metadata: {python}") from exc
    if info.get("version") != [3, 12]:
        raise RuntimeError(
            f"{TRAINING_PYTHON_ENV} must use Python 3.12.x; got {info.get('version')} from {python}. "
            "No bootstrap or training process was started."
        )
    return python


def prepare_environments(repo_root: Path, env: dict[str, str]) -> dict[str, Any]:
    """Call the existing pinned bootstrap without changing the Colab kernel."""
    python = training_python(env)
    env = dict(env)
    env[TRAINING_PYTHON_ENV] = str(python)
    manifest_path = Path(env["FADACHI_MODEL_BENCHMARK_TMP_ROOT"]) / "colab-bootstrap-manifest.json"
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    setup_log = manifest_path.parent / "colab-bootstrap.log"
    command = [str(python), "-u", "-m", "research.model_benchmark.bootstrap", "--prepare", "--manifest", str(manifest_path)]
    from collections import deque
    tail: Any = deque(maxlen=30)
    with setup_log.open("w", encoding="utf-8", buffering=1) as log:
        process = subprocess.Popen(
            command, cwd=repo_root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            start_new_session=(os.name != "nt"),
        )
        try:
            assert process.stdout is not None
            for line in process.stdout:
                print(line, end="")
                log.write(line)
                tail.append(line.rstrip())
            return_code = process.wait()
        except KeyboardInterrupt:
            if os.name != "nt" and process.pid:
                try:
                    os.killpg(process.pid, signal.SIGINT)
                except ProcessLookupError:
                    pass
            else:
                process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                if os.name != "nt" and process.pid:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                else:
                    process.kill()
                process.wait()
            raise
    if return_code:
        raise RuntimeError(
            f"Pinned Colab environment setup failed (exit {return_code}). Last log lines:\n"
            + "\n".join(tail)
            + f"\nFull setup log: {setup_log}"
        )
    if not manifest_path.is_file():
        raise RuntimeError("Colab bootstrap exited without its environment manifest.")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if manifest.get("status") != "ready":
        raise RuntimeError("Selected model environments and pinned model assets must be ready before training.")
    return manifest


def verify_torch_environments(env_root: Path, *, require_a100: bool = True) -> dict[str, Any]:
    """Verify the isolated TS interpreters can use the runtime GPU."""
    result: dict[str, Any] = {}
    probe = (
        "import json,torch; d=torch.cuda.get_device_name(0) if torch.cuda.is_available() else None; "
        "m=torch.cuda.get_device_properties(0).total_memory if torch.cuda.is_available() else 0; "
        "z=(torch.ones((2,2),device='cuda')@torch.ones((2,2),device='cuda')) if torch.cuda.is_available() else None; "
        "torch.cuda.synchronize() if torch.cuda.is_available() else None; "
        "print(json.dumps({'torch':torch.__version__,'cuda':torch.version.cuda,'available':torch.cuda.is_available(),'gpu':d,'memory_bytes':m}))"
    )
    for name in ("chronos", "timesfm"):
        python = python_executable(env_root, name)
        if not python.is_file():
            raise FileNotFoundError(f"Missing isolated Python interpreter: {python}")
        completed = subprocess.run([str(python), "-I", "-c", probe], capture_output=True, text=True, check=False)
        if completed.returncode:
            raise RuntimeError(f"CUDA probe failed for {name}: {completed.stderr[-2000:]}")
        info = json.loads(completed.stdout.strip().splitlines()[-1])
        if not info["available"]:
            raise RuntimeError(f"CUDA is unavailable in isolated {name} environment.")
        if require_a100 and "a100" not in str(info["gpu"]).casefold():
            raise RuntimeError(f"Isolated {name} environment sees {info['gpu']!r}, not an A100.")
        info["cuda_tensor_op_passed"] = True
        result[name] = info
    return result


def current_portable_identity(repo_root: Path, env: dict[str, str], *, smoke: bool) -> dict[str, Any]:
    """Build identity in the rank Python 3.12 process, never in the host kernel."""
    env_root = Path(env["FADACHI_MODEL_BENCHMARK_ENV_ROOT"])
    python = python_executable(env_root, "rank")
    if not python.is_file():
        raise FileNotFoundError(f"rank Python 3.12 environment is missing: {python}")
    child_env = dict(env)
    script = (
        "import json,sys; "
        "from pathlib import Path; "
        "from research.model_benchmark.config import dataset_identity,portable_identity; "
        "from research.model_benchmark.runner import _current_identity; "
        "source=dataset_identity(Path(sys.argv[1])); "
        f"envs,fps=_current_identity(source,{bool(smoke)!r}); "
        "print(json.dumps(portable_identity(source,fps,envs),sort_keys=True))"
    )
    completed = subprocess.run(
        [str(python), "-c", script, child_env["FADACHI_MODEL_BENCHMARK_SOURCE_ROOT"]],
        cwd=repo_root, env=child_env, capture_output=True, text=True, encoding="utf-8", check=False,
    )
    if completed.returncode:
        raise RuntimeError(f"Could not build portable identity in rank Python 3.12: {completed.stderr[-4000:]}")
    try:
        identity = json.loads(completed.stdout.strip().splitlines()[-1])
    except (ValueError, IndexError) as exc:
        raise RuntimeError("Rank Python 3.12 returned invalid portable identity JSON") from exc
    environments = identity.get("environments", {})
    fingerprints = identity.get("fingerprints", {})
    if any(value.get("error") for value in environments.values()):
        raise RuntimeError(f"Cannot build restore identity from unready environments: {environments}")
    if not fingerprints:
        raise RuntimeError("Rank Python 3.12 returned no model fingerprints")
    return identity


def _read_new_events(event_file: Path, offset: int) -> tuple[int, list[dict[str, Any]]]:
    if not event_file.is_file():
        return offset, []
    size = event_file.stat().st_size
    if size < offset:
        # A fresh run attempt may atomically rotate its event file.
        offset = 0
    with event_file.open("rb") as stream:
        stream.seek(offset)
        payload = stream.read()
        new_offset = stream.tell()
    lines = payload.splitlines(keepends=True)
    events: list[dict[str, Any]] = []
    consumed = 0
    for line in lines:
        if not line.endswith((b"\n", b"\r")):
            break
        consumed += len(line)
        if line.strip():
            events.append(json.loads(line.decode("utf-8")))
    return offset + consumed, events


def _snapshot_events(
    event_file: Path,
    run_root: Path,
    store: SnapshotStore,
    *,
    offset: int,
    stop_event: threading.Event,
    errors: list[str],
    on_snapshot: Callable[[Path], None] | None,
) -> None:
    seen: set[str] = set()
    while True:
        try:
            offset, events = _read_new_events(event_file, offset)
            for event in events:
                event_id = str(event.get("event_id", ""))
                if event_id in seen:
                    continue
                seen.add(event_id)
                path = store.save_event(run_root, event)
                if on_snapshot:
                    on_snapshot(path)
            if stop_event.is_set():
                # Saving an event can take long enough for the runner to append
                # more records. Drain any complete records before classifying
                # the remaining bytes as a truncated final line.
                next_offset, _ = _read_new_events(event_file, offset)
                if next_offset > offset:
                    continue
                if event_file.is_file() and event_file.stat().st_size > offset:
                    errors.append("stage event log ended with an incomplete JSONL record")
                return
        except Exception as exc:
            errors.append(f"{type(exc).__name__}: {exc}")
            # Stop on a broken stage log; repeatedly retrying a malformed event
            # could hide the true failure and spin while training consumes GPU.
            return
        stop_event.wait(0.5)


def run_with_snapshots(
    command: list[str],
    *,
    repo_root: Path,
    env: dict[str, str],
    run_root: Path,
    store: SnapshotStore,
    log_path: Path,
    on_snapshot: Callable[[Path], None] | None = None,
) -> dict[str, Any]:
    """Stream one runner process while archiving each finalized stage event."""
    event_file = run_root / "stage_events.jsonl"
    env = dict(env)
    coordinator = training_python(env)
    env[TRAINING_PYTHON_ENV] = str(coordinator)
    if len(command) >= 4 and command[1:4] == ["-u", "-m", "research.model_benchmark.runner"]:
        rank_python = python_executable(Path(env["FADACHI_MODEL_BENCHMARK_ENV_ROOT"]), "rank")
        if not rank_python.is_file():
            raise FileNotFoundError(f"rank runner Python environment is missing: {rank_python}")
        rank_probe = subprocess.run(
            [str(rank_python), "-I", "-c", "import json,sys; print(json.dumps({'version': list(sys.version_info[:2])}))"],
            capture_output=True, text=True, encoding="utf-8", check=False,
        )
        if rank_probe.returncode:
            raise RuntimeError(f"Could not probe rank runner Python {rank_python}: {rank_probe.stderr[-2000:]}")
        try:
            rank_version = json.loads(rank_probe.stdout.strip().splitlines()[-1]).get("version")
        except (ValueError, IndexError) as exc:
            raise RuntimeError(f"Rank runner Python returned invalid version metadata: {rank_python}") from exc
        if rank_version != [3, 12]:
            raise RuntimeError(f"The rank runner environment requires Python 3.12.x; got {rank_version} from {rank_python}")
        # Keep the venv entry point (which owns numpy/pandas/etc.) rather than
        # resolving its symlink to the standalone managed Python base.
        command = [str(rank_python), *command[1:]]
    offset = event_file.stat().st_size if event_file.is_file() else 0
    stop_event = threading.Event()
    snapshot_errors: list[str] = []
    watcher = threading.Thread(
        target=_snapshot_events,
        args=(event_file, run_root, store),
        kwargs={"offset": offset, "stop_event": stop_event, "errors": snapshot_errors, "on_snapshot": on_snapshot},
        daemon=True,
        name="fadachi-colab-snapshot-watcher",
    )
    log_path.parent.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()
    watcher.start()
    with log_path.open("a", encoding="utf-8", buffering=1) as log:
        log.write("\n$ " + " ".join(command) + "\n")
        process = subprocess.Popen(
            command, cwd=repo_root, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
            text=True, encoding="utf-8", errors="replace", bufsize=1,
            start_new_session=(os.name != "nt"),
        )
        try:
            assert process.stdout is not None
            for line in process.stdout:
                print(line, end="")
                log.write(line)
            return_code = process.wait()
        except BaseException:
            if os.name != "nt" and process.pid:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            else:
                process.terminate()
            try:
                process.wait(timeout=15)
            except subprocess.TimeoutExpired:
                if os.name != "nt" and process.pid:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                else:
                    process.kill()
                process.wait()
            raise
        finally:
            stop_event.set()
            watcher.join()
    result = {"return_code": return_code, "elapsed_seconds": time.perf_counter() - started, "snapshot_errors": snapshot_errors, "log_path": str(log_path)}
    if snapshot_errors:
        raise RuntimeError("Training process ended but at least one Drive snapshot failed: " + "; ".join(snapshot_errors))
    return result


def commit_notebook_artifacts(
    run_root: Path,
    *,
    runner_log: Path,
    runtime: dict[str, Any],
    ts_gpu: dict[str, Any],
    session_id: str,
    store: SnapshotStore,
) -> dict[str, Any]:
    """Persist closed outer-runner logs and hardware provenance, then snapshot.

    Call only after the runner subprocess has exited and its event watcher has
    drained. Contents are copied to content-addressed immutable run files.
    """
    import hashlib
    from datetime import datetime, timezone

    from .common import atomic_bytes, emit_stage_event

    run_root = run_root.resolve()
    log_path = runner_log.resolve()
    if not log_path.is_file():
        raise FileNotFoundError(f"completed outer-runner log is missing: {log_path}")
    manifest_path = run_root / "run_manifest.json"
    if not manifest_path.is_file():
        raise FileNotFoundError(f"benchmark run manifest is missing: {manifest_path}")
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    portable_id = manifest.get("portable_identity")
    if not isinstance(portable_id, dict) or manifest.get("run_id") != run_root.name:
        raise ValueError("run manifest identity is missing or does not match the run directory")

    artifact_root = run_root / "notebook_artifacts"
    artifact_root.mkdir(parents=True, exist_ok=True)
    log_bytes = log_path.read_bytes()
    log_sha = hashlib.sha256(log_bytes).hexdigest()
    archived_log = artifact_root / "logs" / f"runner-{log_sha}.log"
    if archived_log.exists() and archived_log.read_bytes() != log_bytes:
        raise ValueError("content-addressed runner log path already contains different data")
    if not archived_log.exists():
        atomic_bytes(archived_log, log_bytes)

    hardware = {
        "schema": 1,
        "run_id": run_root.name,
        "session_id": session_id,
        "recorded_utc": datetime.now(timezone.utc).isoformat(),
        "colab_runtime": runtime,
        "timeseries_environments": ts_gpu,
    }
    hardware_bytes = (json.dumps(hardware, sort_keys=True, ensure_ascii=False, indent=2, default=str) + "\n").encode("utf-8")
    hardware_sha = hashlib.sha256(hardware_bytes).hexdigest()
    archived_hardware = artifact_root / "runtime" / f"hardware-{hardware_sha}.json"
    if archived_hardware.exists() and archived_hardware.read_bytes() != hardware_bytes:
        raise ValueError("content-addressed runtime path already contains different data")
    if not archived_hardware.exists():
        atomic_bytes(archived_hardware, hardware_bytes)

    finalized_reports = [
        run_root / name
        for name in ("comparison.md", "comparison.csv", "comparison.json")
        if (run_root / name).is_file()
    ]
    event = emit_stage_event(
        run_root,
        event="run_status_changed",
        model_key=None,
        stage="notebook_completed",
        portable_identity=portable_id,
        artifact_paths=[archived_log, archived_hardware, *finalized_reports],
    )
    archive_path = store.save_event(run_root, event)
    return {
        "event": event,
        "archive_path": str(archive_path),
        "archive_sha256": hashlib.sha256(archive_path.read_bytes()).hexdigest(),
        "runner_log_path": str(archived_log),
        "runtime_metadata_path": str(archived_hardware),
    }


def restore_latest_snapshot(
    store: SnapshotStore,
    *,
    run_id: str,
    source_session_id: str,
    local_runs_root: Path,
    expected_identity: dict[str, Any],
) -> dict[str, Any]:
    candidates = store.list_committed(run_id)
    candidates = [item for item in candidates if item["session_id"] == source_session_id]
    if not candidates:
        raise FileNotFoundError(f"No committed snapshots found for run {run_id!r} in Drive session {source_session_id!r}.")
    matching = [item for item in candidates if item["event"].get("portable_identity") == expected_identity]
    if not matching:
        raise ValueError("Committed snapshot exists, but source/code/OS/Python/CUDA/environment identity does not match.")
    latest = matching[-1]
    archive = latest["archive_path"]
    marker = archive.with_suffix(archive.suffix + ".COMMITTED")
    destination = local_runs_root / run_id
    restored = restore_snapshot(archive, marker, destination, expected_portable_identity=expected_identity)
    return {**restored, "snapshot_path": str(archive), "created_utc": latest["created_utc"]}


def smoke_succeeded(run_manifest_path: Path) -> bool:
    """Smoke runs are intentionally PARTIAL; require all model stages to pass."""
    from .config import MODEL_KEYS
    manifest = json.loads(run_manifest_path.read_text(encoding="utf-8"))
    if manifest.get("smoke") is not True or manifest.get("status_reason") != "SMOKE_ONLY":
        return False
    models = manifest.get("models", {})
    if set(models) != set(MODEL_KEYS):
        return False
    for key in MODEL_KEYS:
        item = models[key]
        if item.get("status") != "SUCCESS" or item.get("evaluation_status") != "PASSED":
            return False
        if not item.get("predict", {}).get("fresh_load"):
            return False
    return True
