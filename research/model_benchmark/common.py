"""Shared deterministic serialization, hashing, locking, and state helpers."""
from __future__ import annotations

import hashlib
import json
import os
import tempfile
import time
import uuid
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
