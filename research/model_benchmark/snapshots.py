"""Committed, hash-verified run snapshots for Colab's ephemeral local disk."""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
import uuid
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any

from .common import atomic_json, exclusive_lock, hash_file

SNAPSHOT_SCHEMA = 1
SNAPSHOT_MANIFEST = "snapshot_manifest.json"
EVENT_FILE = "event.json"
COMMIT_SUFFIX = ".COMMITTED"
_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")


def _safe_relative(value: str) -> PurePosixPath:
    if not isinstance(value, str) or not value or "\\" in value:
        raise ValueError(f"invalid snapshot path: {value!r}")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in ("", ".", "..") for part in path.parts) or ":" in path.parts[0]:
        raise ValueError(f"unsafe snapshot path: {value!r}")
    return path


def _artifact_relative(value: str, *, source_system: str) -> PurePosixPath:
    """Normalize Windows-native artifact keys only for Windows run metadata."""
    if "\\" not in value:
        return _safe_relative(value)
    if source_system != "Windows":
        raise ValueError(f"backslash artifact path is not valid for {source_system}: {value!r}")
    normalized = value.replace("\\", "/")
    # Reject drive letters, UNC roots, and traversal before PurePosixPath can
    # normalize or discard any components.
    if normalized.startswith("/") or re.match(r"^[A-Za-z]:", normalized):
        raise ValueError(f"absolute Windows artifact path is not permitted: {value!r}")
    return _safe_relative(normalized)


def _stable_json(value: Any) -> bytes:
    return (json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), default=str) + "\n").encode("utf-8")


def _portable_hash(identity: dict[str, Any]) -> str:
    return hashlib.sha256(_stable_json(identity)).hexdigest()


def _validate_event(event: dict[str, Any]) -> tuple[str, str, list[dict[str, Any]]]:
    if event.get("schema") != 1:
        raise ValueError("unsupported stage event schema")
    event_id = str(event.get("event_id", ""))
    run_id = str(event.get("run_id", ""))
    if not _ID_RE.fullmatch(event_id) or not _ID_RE.fullmatch(run_id):
        raise ValueError("stage event contains invalid event or run id")
    if not isinstance(event.get("portable_identity"), dict) or not event["portable_identity"]:
        raise ValueError("stage event has no portable identity")
    context = event.get("snapshot_context")
    if not isinstance(context, dict):
        raise ValueError("stage event has no immutable snapshot context")
    manifest_path = _safe_relative(context.get("manifest_path", ""))
    if not manifest_path.parts or manifest_path.parts[0] != "snapshots":
        raise ValueError("snapshot context must reference an immutable run state under snapshots/")
    if not re.fullmatch(r"[0-9a-f]{64}", str(context.get("manifest_sha256", ""))):
        raise ValueError("snapshot context state hash is invalid")
    cohort_path = _safe_relative(context.get("cohort_path", ""))
    if not cohort_path.parts or cohort_path.parts[0] != "common_cohort.json" and cohort_path.parts[-1] != "common_cohort.json":
        raise ValueError("snapshot context has no common cohort")
    for key in ("cohort_sha256",):
        if not re.fullmatch(r"[0-9a-f]{64}", str(context.get(key, ""))):
            raise ValueError(f"snapshot context {key} is invalid")
    baseline_path = context.get("baseline_path")
    baseline_hash = context.get("baseline_sha256")
    if (baseline_path is None) != (baseline_hash is None):
        raise ValueError("baseline path and hash must either both be set or both be null")
    if baseline_path is not None:
        _safe_relative(str(baseline_path))
        if not re.fullmatch(r"[0-9a-f]{64}", str(baseline_hash)):
            raise ValueError("baseline hash is invalid")
    artifacts = event.get("artifact_manifest")
    if not isinstance(artifacts, list) or not artifacts:
        raise ValueError("stage event has no artifact manifest")
    normalized: dict[str, dict[str, Any]] = {}
    for item in artifacts:
        if not isinstance(item, dict):
            raise ValueError("artifact manifest records must be objects")
        rel = _safe_relative(item.get("path", "")).as_posix()
        digest = str(item.get("sha256", ""))
        size = item.get("size_bytes")
        if not re.fullmatch(r"[0-9a-f]{64}", digest) or not isinstance(size, int) or size < 0:
            raise ValueError(f"invalid artifact manifest record: {rel}")
        if rel in normalized:
            raise ValueError(f"duplicate artifact manifest path: {rel}")
        normalized[rel] = {"path": rel, "sha256": digest, "size_bytes": size}
    required = {
        manifest_path.as_posix(): str(context["manifest_sha256"]),
        cohort_path.as_posix(): str(context["cohort_sha256"]),
    }
    if baseline_path is not None:
        required[_safe_relative(str(baseline_path)).as_posix()] = str(baseline_hash)
    for path, digest in required.items():
        if path not in normalized or normalized[path]["sha256"] != digest:
            raise ValueError(f"snapshot_context reference missing from artifact manifest or hash differs: {path}")
    return run_id, event_id, sorted(normalized.values(), key=lambda item: item["path"])


def _member_hash(archive: zipfile.ZipFile, name: str) -> str:
    h = hashlib.sha256()
    with archive.open(name) as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def verify_committed_archive(archive_path: Path, marker_path: Path) -> dict[str, Any]:
    if not marker_path.is_file():
        raise ValueError("snapshot has no COMMITTED marker")
    marker = json.loads(marker_path.read_text(encoding="utf-8"))
    archive_hash = hash_file(archive_path)
    if archive_hash != marker.get("archive_sha256"):
        raise ValueError("snapshot archive hash does not match COMMITTED marker")
    with zipfile.ZipFile(archive_path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)):
            raise ValueError("snapshot contains duplicate paths")
        if SNAPSHOT_MANIFEST not in names or EVENT_FILE not in names:
            raise ValueError("snapshot manifest or event missing")
        manifest = json.loads(archive.read(SNAPSHOT_MANIFEST).decode("utf-8"))
        event = json.loads(archive.read(EVENT_FILE).decode("utf-8"))
        if manifest.get("schema") != SNAPSHOT_SCHEMA:
            raise ValueError("unsupported snapshot schema")
        declared_manifest_hash = manifest.get("manifest_sha256")
        hashable_manifest = {key: value for key, value in manifest.items() if key != "manifest_sha256"}
        manifest_hash = hashlib.sha256(_stable_json(hashable_manifest)).hexdigest()
        if manifest_hash != marker.get("manifest_sha256") or manifest_hash != declared_manifest_hash:
            raise ValueError("snapshot manifest hash does not match COMMITTED marker")
        records = manifest.get("files")
        if not isinstance(records, list):
            raise ValueError("snapshot file list missing")
        expected = {record["path"]: record for record in records}
        if len(expected) != len(records):
            raise ValueError("snapshot file list has duplicate paths")
        expected_names = {SNAPSHOT_MANIFEST, EVENT_FILE, *expected}
        if set(names) != expected_names:
            raise ValueError("snapshot archive entries do not match manifest")
        for record in records:
            rel = _safe_relative(record["path"]).as_posix()
            if int(archive.getinfo(rel).file_size) != int(record["size_bytes"]):
                raise ValueError(f"snapshot size mismatch: {rel}")
            if _member_hash(archive, rel) != record["sha256"]:
                raise ValueError(f"snapshot hash mismatch: {rel}")
        run_id, event_id, _ = _validate_event(event)
        if manifest.get("run_id") != run_id or manifest.get("event_id") != event_id:
            raise ValueError("snapshot manifest and event identities disagree")
        if marker.get("run_id") != run_id or marker.get("event_id") != event_id:
            raise ValueError("COMMITTED marker and event identities disagree")
        return {"archive_sha256": archive_hash, "manifest_sha256": manifest_hash, "manifest": manifest, "event": event}


class SnapshotStore:
    """Write immutable per-event archives; the marker is the final commit step."""

    def __init__(self, drive_root: Path, session_id: str, *, local_lock_root: Path | None = None):
        if not _ID_RE.fullmatch(session_id):
            raise ValueError("invalid session id")
        self.drive_root = drive_root
        self.session_id = session_id
        self.local_lock_root = local_lock_root or Path(tempfile.gettempdir()) / "fadachi-colab-snapshot-locks"

    def _session_root(self, run_id: str) -> Path:
        if not _ID_RE.fullmatch(run_id):
            raise ValueError("invalid run id")
        return self.drive_root / "sessions" / self.session_id / run_id

    def save_event(self, run_root: Path, event: dict[str, Any]) -> Path:
        run_id, event_id, artifacts = _validate_event(event)
        run_root = run_root.resolve()
        # Verify each declared immutable artifact before any Drive write.
        for record in artifacts:
            source = run_root.joinpath(*_safe_relative(record["path"]).parts)
            if not source.is_file() or source.is_symlink():
                raise FileNotFoundError(f"snapshot artifact missing or symbolic link: {record['path']}")
            if source.stat().st_size != record["size_bytes"] or hash_file(source) != record["sha256"]:
                raise ValueError(f"snapshot artifact hash changed after event: {record['path']}")
        identity_hash = _portable_hash(event["portable_identity"])
        snapshot_id = f"{event_id}-{identity_hash[:12]}"
        session_root = self._session_root(run_id)
        generation_root = session_root / "generations"
        generation_root.mkdir(parents=True, exist_ok=True)
        archive_final = generation_root / f"{snapshot_id}.zip"
        marker_final = archive_final.with_suffix(archive_final.suffix + COMMIT_SUFFIX)
        lock_key = hashlib.sha256(str(session_root.resolve()).encode("utf-8")).hexdigest()
        # Drive is only snapshot storage. The owner lock lives on the local VM;
        # separate Drive session namespaces prevent cross-VM lock assumptions.
        lock = self.local_lock_root / f"{lock_key}.lock"
        with exclusive_lock(lock):
            if marker_final.exists():
                verify_committed_archive(archive_final, marker_final)
                return archive_final
            local_temp_root = self.local_lock_root / "tmp"
            local_temp_root.mkdir(parents=True, exist_ok=True)
            local_tmp_root = Path(tempfile.mkdtemp(prefix="fadachi-snapshot-", dir=local_temp_root))
            local_archive = local_tmp_root / "generation.zip"
            try:
                records = []
                with zipfile.ZipFile(local_archive, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=3) as archive:
                    archive.writestr(EVENT_FILE, _stable_json(event))
                    for record in artifacts:
                        rel = record["path"]
                        source = run_root.joinpath(*_safe_relative(rel).parts)
                        # Recheck after reading to catch a writer violating the immutable-event contract.
                        before_hash = hash_file(source)
                        if before_hash != record["sha256"]:
                            raise ValueError(f"artifact changed before snapshot copy: {rel}")
                        archive.write(source, rel)
                        after_hash = hash_file(source)
                        if before_hash != after_hash:
                            raise ValueError(f"artifact changed while snapshotting: {rel}")
                        records.append(dict(record))
                    manifest = {
                        "schema": SNAPSHOT_SCHEMA,
                        "snapshot_id": snapshot_id,
                        "run_id": run_id,
                        "event_id": event_id,
                        "origin_run_root": str(run_root),
                        "portable_identity_sha256": identity_hash,
                        "files": records,
                    }
                    manifest_digest = hashlib.sha256(_stable_json(manifest)).hexdigest()
                    manifest["manifest_sha256"] = manifest_digest
                    archive.writestr(SNAPSHOT_MANIFEST, _stable_json(manifest))
                archive_digest = hash_file(local_archive)
                uploading = archive_final.with_suffix(archive_final.suffix + ".uploading")
                shutil.copyfile(local_archive, uploading)
                if hash_file(uploading) != archive_digest:
                    uploading.unlink(missing_ok=True)
                    raise IOError("Drive snapshot archive readback hash mismatch")
                os.replace(uploading, archive_final)
                marker = {
                    "schema": SNAPSHOT_SCHEMA,
                    "snapshot_id": snapshot_id,
                    "run_id": run_id,
                    "event_id": event_id,
                    "archive_sha256": archive_digest,
                    "manifest_sha256": manifest_digest,
                }
                # Marker written only after the archive has been copied, reread and finalized.
                atomic_json(marker_final, marker)
                verify_committed_archive(archive_final, marker_final)
                return archive_final
            finally:
                shutil.rmtree(local_tmp_root, ignore_errors=True)

    def list_committed(self, run_id: str, *, portable_identity: dict[str, Any] | None = None) -> list[dict[str, Any]]:
        root = self.drive_root / "sessions"
        found: list[dict[str, Any]] = []
        if not root.exists():
            return []
        for archive_path in root.glob(f"*/{run_id}/generations/*.zip"):
            marker = archive_path.with_suffix(archive_path.suffix + COMMIT_SUFFIX)
            try:
                verified = verify_committed_archive(archive_path, marker)
                event = verified["event"]
                if portable_identity is not None and event["portable_identity"] != portable_identity:
                    continue
                found.append({
                    "archive_path": archive_path,
                    "session_id": archive_path.parents[2].name,
                    "run_id": run_id,
                    "event_id": event["event_id"],
                    "event": event,
                    "manifest": verified["manifest"],
                    "archive_sha256": verified["archive_sha256"],
                    "created_utc": event.get("created_utc", ""),
                })
            except (OSError, ValueError, KeyError, json.JSONDecodeError, zipfile.BadZipFile):
                continue
        return sorted(found, key=lambda item: (item["created_utc"], item["event_id"]))


def restore_snapshot(
    archive_path: Path,
    marker_path: Path,
    destination_run_root: Path,
    *,
    expected_portable_identity: dict[str, Any],
    current_source_root: Path | None = None,
) -> dict[str, Any]:
    """Restore only a fully committed generation with the exact platform identity."""
    verified = verify_committed_archive(archive_path, marker_path)
    event, manifest = verified["event"], verified["manifest"]
    if event["portable_identity"] != expected_portable_identity:
        raise ValueError("snapshot platform/source/environment identity differs; refusing cross-identity resume")
    destination_run_root = destination_run_root.resolve()
    run_id, _, artifacts = _validate_event(event)
    if destination_run_root.name != run_id:
        raise ValueError("restore destination must preserve the run id")
    if destination_run_root.exists() and any(destination_run_root.iterdir()):
        raise FileExistsError("restore destination is not empty; refusing to overwrite run state")
    destination_run_root.parent.mkdir(parents=True, exist_ok=True)
    stage = Path(tempfile.mkdtemp(prefix=f".{run_id}.restore-", dir=destination_run_root.parent))
    try:
        with zipfile.ZipFile(archive_path) as archive:
            for record in manifest["files"]:
                rel = _safe_relative(record["path"])
                path = stage.joinpath(*rel.parts)
                path.parent.mkdir(parents=True, exist_ok=True)
                with archive.open(rel.as_posix()) as source, path.open("wb") as target:
                    shutil.copyfileobj(source, target)
                if path.stat().st_size != record["size_bytes"] or hash_file(path) != record["sha256"]:
                    raise ValueError(f"restored file failed verification: {rel}")
        context = event["snapshot_context"]
        state = stage.joinpath(*_safe_relative(context["manifest_path"]).parts)
        cohort = stage.joinpath(*_safe_relative(context["cohort_path"]).parts)
        if hash_file(state) != context["manifest_sha256"] or hash_file(cohort) != context["cohort_sha256"]:
            raise ValueError("restored run state or cohort failed snapshot_context verification")
        if context.get("baseline_path"):
            baseline = stage.joinpath(*_safe_relative(context["baseline_path"]).parts)
            if hash_file(baseline) != context["baseline_sha256"]:
                raise ValueError("restored LightGBM baseline failed snapshot_context verification")
        # The immutable state copy is the source of truth for runner resume.
        # Its original bytes remain in snapshots/; this canonical runtime copy
        # receives only path relocation for the new local checkout.
        original_manifest = json.loads(state.read_text(encoding="utf-8"))
        if original_manifest.get("run_id") != run_id:
            raise ValueError("immutable state copy contains a different run id")
        origin_run_root = Path(str(manifest.get("origin_run_root", "")))
        if not origin_run_root.is_absolute() or origin_run_root.name != run_id:
            raise ValueError("snapshot has no valid original run root provenance")
        origin_source_root = Path(str(original_manifest.get("source_root", "")))
        configured_source_root = current_source_root or (Path(os.environ["FADACHI_MODEL_BENCHMARK_SOURCE_ROOT"]) if os.environ.get("FADACHI_MODEL_BENCHMARK_SOURCE_ROOT") else None)
        if configured_source_root is None:
            raise ValueError("current source root is required to restore a run")
        target_source_root = configured_source_root.resolve()

        def relocate(value: Any, key: str = "") -> Any:
            if isinstance(value, dict):
                return {name: relocate(item, name) for name, item in value.items()}
            if isinstance(value, list):
                return [relocate(item, key) for item in value]
            if not isinstance(value, str):
                return value
            if key == "source_root":
                return str(target_source_root)
            candidate = Path(value)
            if not candidate.is_absolute():
                return value
            try:
                return str(destination_run_root / candidate.relative_to(origin_run_root))
            except ValueError:
                pass
            if str(origin_source_root):
                try:
                    return str(target_source_root / candidate.relative_to(origin_source_root))
                except ValueError:
                    pass
            return value

        relocated = relocate(original_manifest)
        if relocated.get("source_root") != str(target_source_root) or relocated.get("run_id") != run_id:
            raise ValueError("run manifest root relocation did not preserve the run identity")
        canonical_state = stage / "run_manifest.json"
        canonical_state.write_text(json.dumps(relocated, ensure_ascii=False, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        # Previously completed model artifacts must still match their declared hashes.
        source_system = str(event.get("portable_identity", {}).get("platform", {}).get("system", ""))
        for key, model in relocated.get("models", {}).items():
            if model.get("status") != "SUCCESS":
                continue
            attempt = Path(model.get("attempt_dir", ""))
            if not attempt.is_absolute():
                raise ValueError(f"completed model {key} has no restored attempt directory")
            try:
                attempt_rel = attempt.relative_to(destination_run_root)
            except ValueError as exc:
                raise ValueError(f"completed model {key} attempt is outside the restored run") from exc
            staged_attempt = stage / attempt_rel
            if not staged_attempt.is_dir():
                raise ValueError(f"completed model {key} has no restored attempt directory")
            for rel, digest in model.get("artifact_hashes", {}).items():
                artifact = staged_attempt / _artifact_relative(str(rel), source_system=source_system)
                if not artifact.is_file() or hash_file(artifact) != digest:
                    raise ValueError(f"completed model {key} artifact failed restore hash check: {rel}")
            predictions = Path(model.get("predictions_path", ""))
            try:
                predictions_rel = predictions.relative_to(destination_run_root)
            except ValueError as exc:
                raise ValueError(f"completed model {key} predictions are outside the restored run") from exc
            staged_predictions = stage / predictions_rel
            expected_predictions_hash = model.get("predict", {}).get("predictions_sha256")
            if not expected_predictions_hash or not staged_predictions.is_file() or hash_file(staged_predictions) != expected_predictions_hash:
                raise ValueError(f"completed model {key} predictions failed restore hash check")
        if destination_run_root.exists():
            destination_run_root.rmdir()
        os.replace(stage, destination_run_root)
        stage = None  # type: ignore[assignment]
        return {
            "run_id": run_id,
            "event_id": event["event_id"],
            "source_session_id": archive_path.parents[2].name,
            "destination": str(destination_run_root),
            "portable_identity_sha256": manifest["portable_identity_sha256"],
            "restored_files": len(manifest["files"]),
        }
    finally:
        if stage is not None and stage.exists():
            shutil.rmtree(stage, ignore_errors=True)
