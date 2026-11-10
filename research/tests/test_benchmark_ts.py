from __future__ import annotations

import json
import builtins
import subprocess
import sys
import time
from types import SimpleNamespace
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
import torch

from research.model_benchmark import bootstrap
from research.model_benchmark import ts_adapters
from research.model_benchmark.ts_adapters import HOUR_MS, TsAdapter, _require_peft, _timesfm_future_tensor, _window_rows


def _klines(symbols: int = 12, end_hour: int = 1500) -> pd.DataFrame:
    rows = []
    for number in range(symbols):
        for hour in range(end_hour):
            rows.append(
                {
                    "symbol": f"S{number:02d}",
                    "open_time": hour * HOUR_MS,
                    "close": 100.0 + number + hour * 0.01,
                    "is_final": True,
                }
            )
    return pd.DataFrame(rows)


def _boundaries() -> dict[str, int]:
    return {
        "startMs": 256 * HOUR_MS,
        "trainEndMs": 600 * HOUR_MS,
        "valEndMs": 1000 * HOUR_MS,
        "testEndMs": 1400 * HOUR_MS,
    }


def test_train_windows_are_single_symbol_fixed_256_plus_4_and_split_local() -> None:
    rows = _window_rows(_klines(), _boundaries(), "train", max_windows=64)
    assert rows
    assert len(rows[0]["context"]) == 256
    assert len(rows[0]["target"]) == 4
    assert rows[0]["open_time"] >= _boundaries()["startMs"]
    assert rows[0]["open_time"] + 4 * HOUR_MS <= _boundaries()["trainEndMs"]
    assert np.all(np.diff(rows[0]["context"]) > 0)


def test_midnight_windows_skip_gaps_and_require_complete_symbol_groups() -> None:
    bars = _klines(symbols=12)
    # Remove one closed hour from a single coin so its 256->4 window at 600h is invalid.
    bars = bars.loc[~((bars.symbol == "S00") & (bars.open_time == 500 * HOUR_MS))].copy()
    rows = _window_rows(bars, _boundaries(), "val", midnight_only=True)
    assert rows
    assert all(r["open_time"] % (24 * HOUR_MS) == 0 for r in rows)
    assert all(_boundaries()["trainEndMs"] <= r["open_time"] for r in rows)
    assert all(r["open_time"] + 4 * HOUR_MS <= _boundaries()["valEndMs"] for r in rows)
    assert not any(r["symbol"] == "S00" and r["open_time"] == 600 * HOUR_MS for r in rows)
    assert sum(r["open_time"] == 600 * HOUR_MS for r in rows) >= 10


def test_frozen_test_cohort_maps_last_input_bar_to_next_target_hour(tmp_path: Path) -> None:
    cohort_path = tmp_path / "common_cohort.json"
    cohort_path.write_text(
        json.dumps({"rows": [{"symbol": f"S{i:02d}", "open_time": 1391 * HOUR_MS} for i in range(10)]}),
        encoding="utf-8",
    )
    # The input candle opens at 1391; its close is known at 1392, which is the
    # first hour of the four-bar forecast horizon.
    rows = _window_rows(_klines(), _boundaries(), "test", midnight_only=True, cohort_path=cohort_path)
    assert len(rows) == 10
    assert all(r["open_time"] == 1392 * HOUR_MS for r in rows)


def test_prediction_key_is_the_last_context_bar_used_by_the_common_cohort(monkeypatch: pytest.MonkeyPatch) -> None:
    row = {"symbol": "S01", "open_time": 600 * HOUR_MS, "context": np.ones(256), "target": np.ones(4)}
    monkeypatch.setattr(ts_adapters, "_prediction_mean", lambda *_args: np.ones((1, 4), dtype=np.float64))
    metrics, predictions = ts_adapters._score("timesfm25", object(), [row], "cpu", "finetuned")
    assert predictions[0]["open_time"] == 599 * HOUR_MS
    assert metrics["direction_hit_rate"] is None
    assert metrics["valid_direction_count"] == 0


def test_zero_prediction_is_not_a_hit_for_positive_actual_return(monkeypatch: pytest.MonkeyPatch) -> None:
    row = {"symbol": "S01", "open_time": 600 * HOUR_MS, "context": np.ones(256), "target": np.full(4, 1.1)}
    monkeypatch.setattr(ts_adapters, "_prediction_mean", lambda *_args: np.ones((1, 4), dtype=np.float64))
    metrics, _ = ts_adapters._score("timesfm25", object(), [row], "cpu", "finetuned")
    assert metrics["direction_hit_rate"] == 0.0
    assert metrics["valid_direction_count"] == 1


def test_timesfm_training_target_is_exactly_four_steps() -> None:
    target = _timesfm_future_tensor(np.array([1.0, 2.0, 3.0, 4.0]), "cpu")
    assert tuple(target.shape) == (1, 4)
    assert torch.equal(target, torch.tensor([[1.0, 2.0, 3.0, 4.0]]))
    with pytest.raises(ValueError, match="exactly four"):
        _timesfm_future_tensor(np.arange(5, dtype=np.float32), "cpu")


def test_chronos_fails_closed_when_peft_cannot_be_imported(monkeypatch: pytest.MonkeyPatch) -> None:
    original_import = builtins.__import__

    def import_without_peft(name, *args, **kwargs):
        if name == "peft":
            raise ImportError("simulated missing PEFT")
        return original_import(name, *args, **kwargs)

    monkeypatch.setattr(builtins, "__import__", import_without_peft)
    with pytest.raises(RuntimeError, match="refusing silent full fine-tuning fallback"):
        _require_peft()


def test_ts_saved_nested_artifact_hashes_use_posix_relative_paths(tmp_path: Path) -> None:
    class FakeModel:
        def save_pretrained(self, destination, safe_serialization=True):
            Path(destination, "README.md").write_text("adapter artifact", encoding="utf-8")

    attempt = tmp_path / "attempt"
    adapter = TsAdapter("chronos2")
    adapter.model = FakeModel()
    artifact_hashes = adapter.save({"attempt_dir": str(attempt)})
    assert set(artifact_hashes) == {"adapter/README.md", "adapter/adapter.sha256.json"}
    assert all("\\" not in key for key in artifact_hashes)


def test_bootstrap_uses_prebuilt_lock_and_retries_install(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    env_root = tmp_path / "envs"
    benchmark_root = tmp_path / "benchmark"
    benchmark_root.mkdir()
    env_dir = env_root / "rank"
    env_dir.mkdir(parents=True)
    python = env_dir / "Scripts" / "python.exe"
    python.parent.mkdir()
    python.touch()
    req = benchmark_root / "requirements.txt"
    req.write_text("pinned-top-level==1.0\n", encoding="utf-8")
    lock = benchmark_root / "requirements.lock.txt"
    lock.write_text("pinned-transitive==1.0\n", encoding="utf-8")
    monkeypatch.setattr(bootstrap, "ENV_ROOT", env_root)
    monkeypatch.setattr(bootstrap, "ENV_REQUIREMENTS", {"rank": req})
    monkeypatch.setattr(bootstrap, "ENV_LOCKS", {"rank": lock})
    monkeypatch.setattr(bootstrap, "CACHE_ROOT", tmp_path / "cache")
    calls: list[list[str]] = []

    def fake_run(command, **kwargs):
        calls.append(command)
        if "pip" in command:
            pip_attempt = sum("pip" in call for call in calls)
            if pip_attempt < 3:
                raise subprocess.CalledProcessError(1, command)
            return SimpleNamespace(stdout="", returncode=0)
        return SimpleNamespace(stdout="Python 3.12.14\n", returncode=0)

    monkeypatch.setattr(bootstrap.subprocess, "run", fake_run)
    monkeypatch.setattr(bootstrap, "_runtime_info", lambda _python, **_kwargs: {
        "python_version": "3.12.14", "implementation": "cpython", "cache_tag": "cpython-312",
        "system": "Windows", "machine": "amd64", "torch_version": "2.6.0+cu126", "torch_cuda": "12.6",
        "platform": "Windows-test",
    })
    monkeypatch.setattr(bootstrap.time, "sleep", lambda _seconds: None)
    result = bootstrap._prepare_env("rank")
    install_call = next(call for call in calls if "pip" in call)
    assert result["status"] == "ready"
    assert install_call[-1] == str(lock)
    assert not any(str(req) in call for call in calls)
    assert (env_dir / "requirements.lock").read_text(encoding="utf-8") == lock.read_text(encoding="utf-8")
    assert sum("pip" in call for call in calls) == 3


def test_bootstrap_continues_when_one_environment_fails(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    env_root = tmp_path / "envs"
    monkeypatch.setattr(bootstrap, "ENV_ROOT", env_root)
    monkeypatch.setattr(bootstrap, "CACHE_ROOT", tmp_path / "cache")
    monkeypatch.setattr(bootstrap, "ASSET_LOCK", tmp_path / "assets.lock.json")
    monkeypatch.setattr(bootstrap.config, "RUNS_ROOT", tmp_path / "data" / "model-benchmark" / "runs")
    visited: list[str] = []

    def setup(name: str, *, force: bool = False):
        visited.append(name)
        return {"name": name, "python": str(env_root / name / "python.exe"), "status": "failed" if name == "rank" else "ready"}

    monkeypatch.setattr(bootstrap, "_prepare_env", setup)
    asset_result = {
        "status": "ready",
        "models": {
            "chronos2": {"status": "ready", "repo_id": "amazon/chronos-2", "revision": "a" * 40, "files": {}, "local_dir": "c"},
            "timesfm25": {"status": "ready", "repo_id": "google/timesfm-2.5-200m-transformers", "revision": "b" * 40, "files": {}, "local_dir": "t"},
        },
    }

    def fake_run(*_args, **_kwargs):
        return SimpleNamespace(returncode=0, stdout=json.dumps(asset_result), stderr="")

    monkeypatch.setattr(bootstrap.subprocess, "run", fake_run)
    result = bootstrap.prepare()
    assert visited == ["rank", "chronos", "timesfm"]
    assert result["status"] == "partial"
    assert result["environments"]["chronos"]["status"] == "ready"
    assert result["environments"]["timesfm"]["status"] == "ready"


def test_bootstrap_refuses_to_write_while_runner_owns_lock(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(bootstrap.config, "RUNS_ROOT", tmp_path / "data" / "model-benchmark" / "runs")
    monkeypatch.setattr(bootstrap, "ENV_ROOT", tmp_path / "envs")
    monkeypatch.setattr(bootstrap, "CACHE_ROOT", tmp_path / "cache")
    manifest_path = tmp_path / "bootstrap.json"
    setup_calls: list[str] = []
    monkeypatch.setattr(bootstrap, "_prepare_env", lambda name, **_kwargs: setup_calls.append(name))
    lock_path = bootstrap.config.RUNS_ROOT.parent / ".benchmark-owner.lock"
    lock_code = (
        "import sys,time; from pathlib import Path; "
        "from research.model_benchmark.common import exclusive_lock; "
        f"lock=Path({str(lock_path)!r}); "
        "ctx=exclusive_lock(lock); ctx.__enter__(); print('owner-ready',flush=True); time.sleep(30)"
    )
    owner = subprocess.Popen(
        [sys.executable, "-c", lock_code], cwd=Path(__file__).resolve().parents[2],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        assert owner.stdout is not None
        assert owner.stdout.readline().strip() == "owner-ready"
        with pytest.raises(RuntimeError, match="benchmark lock already held"):
            bootstrap.prepare(manifest_path=manifest_path)
        assert not setup_calls
        assert not (tmp_path / "envs").exists()
        assert not (tmp_path / "cache").exists()
        assert not manifest_path.exists()
    finally:
        owner.terminate()
        owner.wait(timeout=10)


def test_parallel_bootstraps_cannot_enter_setup_concurrently(tmp_path: Path) -> None:
    project = Path(__file__).resolve().parents[2]
    setup_marker = tmp_path / "setup-entered.txt"
    child_code = r"""
import json, sys, time
from pathlib import Path
from types import SimpleNamespace
from research.model_benchmark import bootstrap
base = Path(sys.argv[1])
bootstrap.config.RUNS_ROOT = base / 'data' / 'model-benchmark' / 'runs'
bootstrap.ENV_ROOT = base / '.benchmark-envs'
bootstrap.CACHE_ROOT = base / '.benchmark-cache'
bootstrap.ASSET_LOCK = base / 'assets.lock.json'
marker = base / 'setup-entered.txt'
def setup(name, **kwargs):
    with marker.open('a', encoding='utf-8') as stream:
        stream.write(name + '\n')
        stream.flush()
    if name == 'rank':
        time.sleep(3)
    return {'name': name, 'python': str(base / name / 'python.exe'), 'status': 'ready'}
bootstrap._prepare_env = setup
models = {
    'chronos2': {'status': 'ready', 'repo_id': 'amazon/chronos-2', 'revision': 'a'*40, 'files': {}, 'local_dir': 'c'},
    'timesfm25': {'status': 'ready', 'repo_id': 'google/timesfm-2.5-200m-transformers', 'revision': 'b'*40, 'files': {}, 'local_dir': 't'},
}
bootstrap.subprocess.run = lambda *a, **kw: SimpleNamespace(returncode=0, stdout=json.dumps({'status':'ready','models':models}), stderr='')
print('RESULT', bootstrap.prepare()['status'], flush=True)
"""
    first = subprocess.Popen(
        [sys.executable, "-c", child_code, str(tmp_path)], cwd=project,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline and not setup_marker.exists():
            if first.poll() is not None:
                pytest.fail(f"first bootstrap exited early: {first.stderr.read() if first.stderr else ''}")
            time.sleep(0.05)
        assert setup_marker.exists(), "first bootstrap never entered setup"
        second = subprocess.run(
            [sys.executable, "-c", child_code, str(tmp_path)], cwd=project,
            capture_output=True, text=True, timeout=10,
        )
        first_out, first_err = first.communicate(timeout=10)
        assert first.returncode == 0, first_err
        assert "RESULT ready" in first_out
        assert second.returncode != 0
        assert "benchmark lock already held" in second.stderr
        assert setup_marker.read_text(encoding="utf-8").splitlines() == ["rank", "chronos", "timesfm"]
    finally:
        if first.poll() is None:
            first.terminate()
            first.wait(timeout=10)

