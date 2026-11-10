from __future__ import annotations

import json
import threading
from pathlib import Path
from typing import Any

from research.model_benchmark.colab import _snapshot_events


class _AppendingStore:
    def __init__(self, event_file: Path, append_on_first: bytes | None = None) -> None:
        self.event_file = event_file
        self.append_on_first = append_on_first
        self.saved: list[str] = []

    def save_event(self, _run_root: Path, event: dict[str, Any]) -> Path:
        self.saved.append(event["event_id"])
        if len(self.saved) == 1 and self.append_on_first is not None:
            with self.event_file.open("ab") as stream:
                stream.write(self.append_on_first)
        return self.event_file


def _line(event_id: str) -> bytes:
    return (json.dumps({"event_id": event_id}) + "\n").encode()


def test_stop_drains_complete_event_appended_during_snapshot(tmp_path: Path) -> None:
    event_file = tmp_path / "stage_events.jsonl"
    event_file.write_bytes(_line("first"))
    store = _AppendingStore(event_file, _line("second"))
    errors: list[str] = []
    stop = threading.Event()
    stop.set()

    _snapshot_events(
        event_file, tmp_path, store, offset=0,
        stop_event=stop, errors=errors, on_snapshot=None,
    )

    assert store.saved == ["first", "second"]
    assert errors == []


def test_stop_reports_truncated_final_jsonl_record(tmp_path: Path) -> None:
    event_file = tmp_path / "stage_events.jsonl"
    event_file.write_bytes(_line("first") + b'{"event_id":"truncated')
    store = _AppendingStore(event_file)
    errors: list[str] = []

    stop = threading.Event()
    stop.set()
    _snapshot_events(event_file, tmp_path, store, offset=0, stop_event=stop, errors=errors, on_snapshot=None)

    assert store.saved == ["first"]
    assert errors == ["stage event log ended with an incomplete JSONL record"]


def test_stop_does_not_swallow_invalid_complete_jsonl_record(tmp_path: Path) -> None:
    event_file = tmp_path / "stage_events.jsonl"
    event_file.write_bytes(_line("first"))
    store = _AppendingStore(event_file, b"not-json\n")
    errors: list[str] = []

    stop = threading.Event()
    stop.set()
    _snapshot_events(event_file, tmp_path, store, offset=0, stop_event=stop, errors=errors, on_snapshot=None)

    assert store.saved == ["first"]
    assert len(errors) == 1 and errors[0].startswith("JSONDecodeError:")
