"""Shared deterministic serialization, hashing, locking, and state helpers."""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
import uuid
from datetime import datetime, timezone
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator


def canonical_json(value: Any) -> bytes:
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str).encode("utf-8")


def hash_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def hash_file(path: Path, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        while chunk := stream.read(chunk_size):
            digest.update(chunk)
    return digest.hexdigest()


def hash_tree(paths: list[Path], base: Path) -> str:
    entries = []
    for path in sorted(paths, key=lambda p: p.as_posix().lower()):
        if path.is_file():
            entries.append((path.relative_to(base).as_posix(), hash_file(path)))
    return hash_bytes(canonical_json(entries))


def atomic_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True, default=str)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def atomic_bytes(path: Path, value: bytes) -> None:
    """Atomically publish exact immutable bytes beside their final destination."""
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(value)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp_name, path)
    except BaseException:
        try:
            os.unlink(temp_name)
        except OSError:
            pass
        raise


def completed_candidate_artifacts(attempt_dir: Path) -> list[Path]:
    """Find only completed, hash-verified rank candidates inside an attempt.

    The recorded state may carry an absolute path from a previous machine. Its
    basename is used only to locate the candidate beside that state file; paths
    outside the current attempt are never followed.
    """
    attempt_dir = attempt_dir.resolve()
    artifacts: list[Path] = []
    trial_root = attempt_dir / "trials"
    if not trial_root.is_dir():
        return artifacts
    for state_path in sorted(trial_root.rglob("state.json")):
        try:
            state = json.loads(state_path.read_text(encoding="utf-8"))
            if state.get("complete") is not True:
                continue
            recorded = Path(state.get("result", {}).get("best_model_path", ""))
            if not recorded.name:
                continue
            best_path = state_path.parent / recorded.name
            best_path.resolve().relative_to(attempt_dir)
            expected = state.get("best_model_sha256")
            if not expected or not best_path.is_file() or hash_file(best_path) != expected:
                continue
            artifacts.extend((state_path, best_path))
        except (OSError, ValueError, TypeError, KeyError):
            continue
    return artifacts


def emit_stage_event(
    run_dir: Path,
    *,
    event: str,
    model_key: str | None,
    stage: str,
    portable_identity: dict[str, Any],
    artifact_paths: list[Path] | None = None,
    attempt_dir: Path | None = None,
) -> dict[str, Any]:
    """Append a snapshot event whose referenced state and artifacts are immutable.

    Callers must pass artifacts that will no longer be mutated after this call.
    Paths in the event are run-relative POSIX paths so snapshots can be restored
    under a different checkout root.
    """
    run_dir = run_dir.resolve()
    event_id = uuid.uuid4().hex
    manifest_path = run_dir / "run_manifest.json"
    manifest_bytes = manifest_path.read_bytes() if manifest_path.is_file() else b"{}\n"
    manifest_sha = hash_bytes(manifest_bytes)
    state_rel = f"snapshots/state-{manifest_sha}.json"
    state_path = run_dir / Path(state_rel)
    if not state_path.exists():
        atomic_bytes(state_path, manifest_bytes)
    elif hash_file(state_path) != manifest_sha:
        raise ValueError(f"immutable state snapshot hash mismatch: {state_path}")

    try:
        manifest = json.loads(manifest_bytes.decode("utf-8"))
    except Exception:
        manifest = {}
    stable_paths: list[Path] = [state_path]
    cohort_path = run_dir / "common_cohort.json"
    if cohort_path.is_file():
        stable_paths.append(cohort_path)
    baseline_record = manifest.get("lightgbm_baseline", {})
    baseline_path_raw = baseline_record.get("prediction_path")
    baseline_path = Path(baseline_path_raw) if baseline_path_raw else None
    if baseline_path and baseline_path.is_file():
        stable_paths.append(baseline_path)
    for item in manifest.get("models", {}).values():
        if not isinstance(item, dict):
            continue
        attempt_roots: list[Path] = []
        if item.get("attempt_dir"):
            attempt_roots.append(Path(item["attempt_dir"]))
        if item.get("active_attempt"):
            attempt_roots.append(run_dir / item["active_attempt"])
        attempt_roots.extend((Path(path) if Path(path).is_absolute() else run_dir / path)
                             for path in item.get("attempt_dirs", []))
        for attempt in attempt_roots:
            identity_path = attempt / "attempt_identity.json"
            if identity_path.is_file():
                stable_paths.append(identity_path)
            if attempt == Path(item.get("attempt_dir", "")):
                for relative in item.get("artifact_hashes", {}):
                    stable_paths.append(attempt / relative)
            # Only finalized `.log` files are published here; live stream logs
            # use hidden `.active` names and never enter stage snapshots.
            stable_paths.extend(path for path in (attempt / "logs").glob("*.log") if path.is_file())
            # Candidate state/best pairs are admitted only after SHA verification.
            stable_paths.extend(completed_candidate_artifacts(attempt))
        if item.get("predictions_path"):
            stable_paths.append(Path(item["predictions_path"]))
    expanded_paths: list[Path] = []
    for item in artifact_paths or []:
        path = item if item.is_absolute() else run_dir / item
        path = path.resolve()
        if path.is_dir():
            expanded_paths.extend(child for child in path.rglob("*") if child.is_file())
        else:
            expanded_paths.append(path)
    for path in expanded_paths:
        if not path.is_file():
            raise FileNotFoundError(f"event artifact is not a finalized file: {path}")
        try:
            path.relative_to(run_dir)
        except ValueError as exc:
            raise ValueError(f"event artifact must stay within run_dir: {path}") from exc
        stable_paths.append(path)
    for path in stable_paths:
        try:
            path.relative_to(run_dir)
        except ValueError as exc:
            raise ValueError(f"snapshot artifact must stay within run_dir: {path}") from exc
        if not path.is_file():
            raise FileNotFoundError(f"snapshot artifact is missing: {path}")
    unique_paths = sorted(set(stable_paths), key=lambda p: p.relative_to(run_dir).as_posix())
    artifact_manifest = []
    for path in unique_paths:
        artifact_manifest.append({
            "path": path.relative_to(run_dir).as_posix(),
            "sha256": hash_file(path),
            "size_bytes": path.stat().st_size,
        })
    cohort_sha = hash_file(cohort_path) if cohort_path.is_file() else None
    baseline_sha = hash_file(baseline_path) if baseline_path and baseline_path.is_file() else None
    event_row = {
        "schema": 1,
        "event_id": event_id,
        "run_id": run_dir.name,
        "event": event,
        "model_key": model_key,
        "stage": stage,
        "attempt_dir": attempt_dir.resolve().relative_to(run_dir).as_posix() if attempt_dir else None,
        "portable_identity": portable_identity,
        "portable_identity_sha256": hash_bytes(canonical_json(portable_identity)),
        "artifact_manifest": artifact_manifest,
        "snapshot_context": {
            "manifest_path": state_rel,
            "manifest_sha256": manifest_sha,
            "cohort_path": cohort_path.relative_to(run_dir).as_posix() if cohort_path.is_file() else None,
            "cohort_sha256": cohort_sha,
            "baseline_path": baseline_path.relative_to(run_dir).as_posix() if baseline_path and baseline_path.is_file() else None,
            "baseline_sha256": baseline_sha,
        },
        "created_utc": datetime.now(timezone.utc).isoformat(),
    }
    lock_path = run_dir / "stage_events.lock"
    with exclusive_lock(lock_path):
        events_path = run_dir / "stage_events.jsonl"
        with events_path.open("ab") as stream:
            stream.write(canonical_json(event_row) + b"\n")
            stream.flush()
            os.fsync(stream.fileno())
    return event_row


@contextmanager
def exclusive_lock(path: Path) -> Iterator[None]:
    """OS-held nonblocking lock; process exit releases it for safe resume."""
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {"pid": os.getpid(), "owner": uuid.uuid4().hex, "created_unix": time.time(), "host": os.environ.get("COMPUTERNAME", "")}
    stream = path.open("a+b")
    stream.seek(0, os.SEEK_END)
    if stream.tell() == 0:
        stream.write(b"\0")
        stream.flush()
    stream.seek(0)
    try:
        if os.name == "nt":
            import msvcrt
            msvcrt.locking(stream.fileno(), msvcrt.LK_NBLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
    except (OSError, BlockingIOError) as exc:
        try:
            stream.seek(1)
            owner = json.loads(stream.read().decode("utf-8"))
        except Exception:
            owner = {"unreadable": True}
        stream.close()
        raise RuntimeError(f"benchmark lock already held: {path} owner={owner}") from exc
    try:
        stream.seek(1)
        stream.truncate()
        stream.write(canonical_json(payload))
        stream.flush()
        os.fsync(stream.fileno())
        yield
    finally:
        if os.name == "nt":
            import msvcrt
            stream.seek(0)
            msvcrt.locking(stream.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl
            fcntl.flock(stream.fileno(), fcntl.LOCK_UN)
        stream.close()


def verify_artifacts(root: Path, expected: dict[str, str]) -> bool:
    if not expected:
        return False
    for rel, digest in expected.items():
        path = root / rel
        if not path.is_file() or hash_file(path) != digest:
            return False
    return True
