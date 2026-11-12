"""Tests for the unified local rolling 180-day store, hourly LightGBM retraining, and 6h Chronos-2 LoRA training."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from research.model_research import (
    chronos2_live,
    chronos2_train,
    chronos_runner,
    lightgbm_ranker,
    rolling_store,
    worker,
)
from research.model_research.features_and_labels import ONE_DAY_MS, ONE_HOUR_MS


def _make_klines(symbols: list[str], start_open: int, count: int, *, drift: float = 0.2) -> pd.DataFrame:
    rows = []
    for sym_i, sym in enumerate(symbols):
        for i in range(count):
            t = start_open + i * ONE_HOUR_MS
            wobble = np.sin((i + sym_i) * 0.35) * (0.5 + sym_i * 0.05)
            close_p = 100.0 + sym_i * 4.0 + i * 0.05 * (drift if sym_i % 2 == 0 else -drift) + wobble
            close_p = max(10.0, float(close_p))
            rows.append(
                {
                    "symbol": sym,
                    "open_time": t,
                    "close_time": t + ONE_HOUR_MS - 1,
                    "open": close_p - 0.15,
                    "high": close_p + 0.4,
                    "low": close_p - 0.4,
                    "close": close_p,
                    "volume": 500.0 + i + sym_i * 10,
                    "quote_volume": (500.0 + i + sym_i * 10) * close_p,
                    "trades": 100 + i,
                    "taker_buy_base": 250.0,
                    "taker_buy_quote": 250.0 * close_p,
                    "is_final": True,
                    "source": "binance_rest_1h",
                }
            )
    return pd.DataFrame(rows)[rolling_store.EXPECTED_KLINES_COLUMNS]


def _make_funding(symbols: list[str], start_open: int, end_open: int) -> pd.DataFrame:
    rows = []
    t = (start_open // (8 * ONE_HOUR_MS)) * (8 * ONE_HOUR_MS)
    while t <= end_open:
        for sym_i, sym in enumerate(symbols):
            rows.append(
                {
                    "symbol": sym,
                    "funding_time": t,
                    "funding_rate": 0.0001 * ((sym_i % 5) - 2),
                    "mark_price": 100.0 + sym_i * 4.0,
                    "source": "binance_rest_funding",
                }
            )
        t += 8 * ONE_HOUR_MS
    return pd.DataFrame(rows)[rolling_store.EXPECTED_FUNDING_COLUMNS]


def test_sync_rolling_dataset_trims_sliding_window_and_preserves_seed(tmp_path: Path) -> None:
    symbols = [f"C{i}USDT" for i in range(12)]
    cutoff = 1_760_000_400_000 + 25 * ONE_DAY_MS
    seed_start = cutoff - 40 * ONE_DAY_MS
    seed_bars = 38 * 24

    seed_dir = tmp_path / "model-research" / "datasets"
    seed_dir.mkdir(parents=True)
    seed_klines = _make_klines(symbols, seed_start, seed_bars)
    seed_funding = _make_funding(symbols, seed_start - 8 * ONE_DAY_MS, cutoff)
    seed_klines.to_parquet(seed_dir / "klines_1h.parquet", index=False)
    seed_funding.to_parquet(seed_dir / "funding_rates.parquet", index=False)
    (seed_dir / "dataset_manifest.json").write_text(
        json.dumps({"universe": {"symbols": symbols}}),
        encoding="utf-8",
    )
    seed_hash_before = hashlib.sha256((seed_dir / "klines_1h.parquet").read_bytes()).hexdigest()

    # Window = 20 days, warmup = 5 days -> retain starts at cutoff - 25d
    res = rolling_store.sync_rolling_dataset(
        data_dir=tmp_path,
        target_cutoff_ms=cutoff,
        window_days=20,
        warmup_days=5,
        fetch_klines_fn=lambda sym, s, e: _make_klines([sym], s, max(0, (e - s) // ONE_HOUR_MS)),
        fetch_funding_fn=lambda sym, s, e: _make_funding([sym], s, e),
        require_latest_hour=True,
    )

    assert hashlib.sha256((seed_dir / "klines_1h.parquet").read_bytes()).hexdigest() == seed_hash_before
    df = res["df_1h"]
    assert int(df["open_time"].min()) >= cutoff - 25 * ONE_DAY_MS
    assert int(df["open_time"].max()) == cutoff - ONE_HOUR_MS
    assert res["state"]["lastCutoffTime"] == cutoff

    # Missing latest bar at next cutoff raises RollingDataNotReadyError cleanly
    with pytest.raises(rolling_store.RollingDataNotReadyError):
        rolling_store.sync_rolling_dataset(
            data_dir=tmp_path,
            target_cutoff_ms=cutoff + ONE_HOUR_MS,
            window_days=20,
            warmup_days=5,
            fetch_klines_fn=lambda sym, s, e: pd.DataFrame(columns=rolling_store.EXPECTED_KLINES_COLUMNS),
            fetch_funding_fn=lambda sym, s, e: pd.DataFrame(columns=rolling_store.EXPECTED_FUNDING_COLUMNS),
            require_latest_hour=True,
        )


def test_rolling_lgbm_zero_leakage_and_atomic_promotion(tmp_path: Path) -> None:
    symbols = [f"C{i}USDT" for i in range(12)]
    cutoff = 1_760_000_400_000 + 25 * ONE_DAY_MS
    start = cutoff - 22 * ONE_DAY_MS
    count = 22 * 24

    df_1h = _make_klines(symbols, start, count)
    df_funding = _make_funding(symbols, start - 8 * ONE_DAY_MS, cutoff)

    panel_df, boundaries = rolling_store.build_rolling_panel_and_splits(
        df_1h=df_1h,
        df_funding=df_funding,
        target_cutoff_ms=cutoff,
        window_days=14,
        val_days=4,
    )
    eligible = panel_df[panel_df["group_eligible"].astype(bool)]
    assert not eligible[eligible["split"] == "train"].empty
    assert not eligible[eligible["split"] == "val"].empty
    assert eligible[eligible["split"] == "test"].empty
    # Every labeled val sample must have exited strictly before cutoff_ms
    assert (eligible["exit_time"] < boundaries.val_end_ms).all()

    paths = rolling_store.resolve_live_paths(tmp_path)
    cur = lightgbm_ranker.publish_rolling_lgbm_version(
        panel_df=panel_df,
        lgbm_root=paths.lgbm_root,
        dataset_version="ds-test-1",
        cutoff_time=cutoff,
    )
    assert paths.lgbm_current_path.is_file()
    lb, sb, meta, loaded_cur = lightgbm_ranker.load_active_rolling_lightgbm(paths.lgbm_root)
    assert loaded_cur["versionId"] == cur["versionId"]
    assert meta["mode"] == "rolling"

    rank_res = lightgbm_ranker.rank_at_cutoff(
        df_1h=df_1h,
        long_booster=lb,
        short_booster=sb,
        feature_columns=meta["feature_columns"],
        cutoff_ms=cutoff,
        df_funding=df_funding,
        top_k=5,
    )
    assert rank_res["status"] == "OK"
    assert rank_res["decision_open_time"] == cutoff - ONE_HOUR_MS

    # Corrupting current model file must fail hash check
    long_txt = paths.lgbm_versions_dir / cur["versionId"] / "lgbm_long_ranker.txt"
    long_txt.write_text("tampered", encoding="utf-8")
    with pytest.raises(ValueError, match="hash"):
        lightgbm_ranker.load_active_rolling_lightgbm(paths.lgbm_root)


def test_rolling_chronos_train_failure_preserves_current_and_live_loads_current_json(
    tmp_path: Path, monkeypatch
) -> None:
    symbols = [f"C{i}USDT" for i in range(12)]
    cutoff = 1_760_000_400_000 + 25 * ONE_DAY_MS
    start = cutoff - 22 * ONE_DAY_MS
    df_1h = _make_klines(symbols, start, 22 * 24)

    paths = rolling_store.resolve_live_paths(tmp_path)
    paths.datasets_dir.mkdir(parents=True, exist_ok=True)
    df_1h.to_parquet(paths.klines_path, index=False)
    (paths.state_path).write_text(json.dumps({"lastCutoffTime": cutoff}), encoding="utf-8")

    # Verify strict causal TS window assembly (no future window leaks past cutoff)
    train_rows, val_rows = chronos2_train.build_rolling_ts_windows(
        df_1h,
        cutoff_ms=cutoff,
        window_days=14,
        val_days=4,
        lookback=256,
        horizon=4,
        window_stride=6,
        min_val_group_symbols=10,
    )
    assert train_rows and val_rows
    val_start = cutoff - 4 * ONE_DAY_MS
    assert all(r["open_time"] + 4 * ONE_HOUR_MS <= val_start for r in train_rows)
    assert all(r["open_time"] >= val_start and r["open_time"] + 4 * ONE_HOUR_MS <= cutoff for r in val_rows)

    fake_base = tmp_path / "base-cache"
    fake_base.mkdir(parents=True)
    fake_model_bytes = b"base-weights"
    (fake_base / "config.json").write_text("{}", encoding="utf-8")
    (fake_base / "model.safetensors").write_bytes(fake_model_bytes)
    lock_file = tmp_path / "model-assets.lock.json"
    lock_file.write_text(
        json.dumps(
            {
                "models": {
                    "chronos2": {
                        "repo_id": "amazon/chronos-2",
                        "revision": "pinned-rev-123",
                        "files": {
                            "config.json": hashlib.sha256(b"{}").hexdigest(),
                            "model.safetensors": hashlib.sha256(fake_model_bytes).hexdigest(),
                        },
                    }
                }
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(chronos2_train, "ASSET_LOCK_PATH", lock_file)
    monkeypatch.setattr(chronos2_train, "DEFAULT_BASE_CACHE", fake_base)
    monkeypatch.setattr(chronos_runner, "ROOT", tmp_path)

    # Setup fake lock resolution inside tmp_path/research/model_benchmark too for chronos_runner
    (tmp_path / "research" / "model_benchmark").mkdir(parents=True)
    (tmp_path / "research" / "model_benchmark" / "model-assets.lock.json").write_text(
        lock_file.read_text(encoding="utf-8"), encoding="utf-8"
    )
    (tmp_path / ".benchmark-cache" / "models" / "chronos2").mkdir(parents=True)
    (tmp_path / ".benchmark-cache" / "models" / "chronos2" / "config.json").write_text("{}", encoding="utf-8")
    (tmp_path / ".benchmark-cache" / "models" / "chronos2" / "model.safetensors").write_bytes(fake_model_bytes)
    py_dir = tmp_path / ".benchmark-envs" / "chronos" / ("Scripts" if chronos_runner.os.name == "nt" else "bin")
    py_dir.mkdir(parents=True)
    (py_dir / ("python.exe" if chronos_runner.os.name == "nt" else "python")).write_bytes(b"py")

    import torch

    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)

    def _fake_fit(base_dir, train_rows, val_rows, tmp_work_dir, adapter_out_dir, cfg):
        adapter_out_dir.mkdir(parents=True, exist_ok=True)
        (adapter_out_dir / "adapter_config.json").write_text('{"r": 8}', encoding="utf-8")
        (adapter_out_dir / "adapter_model.safetensors").write_bytes(b"lora-v1")
        return {
            "device": "cuda",
            "gpuName": "Mock RTX 4050",
            "dtype": "bfloat16",
            "optimizerUpdates": 60,
            "bestStep": 60,
            "valReturnMae": 0.012,
            "valDirectionHitRate": 0.55,
            "valPretrainedReturnMae": 0.015,
            "valPretrainedDirectionHitRate": 0.50,
            "trainableParameters": 1234,
            "peakVramAllocatedMb": 512.0,
            "peakVramReservedMb": 640.0,
        }

    monkeypatch.setattr(chronos2_train, "_run_chronos_lora_fit", _fake_fit)

    cur_doc = chronos2_train.train_rolling_chronos2(
        {
            "dataDir": str(tmp_path),
            "cutoffTime": cutoff,
            "windowDays": 14,
            "valDays": 4,
            "retrainIntervalHours": 6,
        }
    )
    assert cur_doc["retrainIntervalHours"] == 6
    assert cur_doc["nextRetrainAt"] == cur_doc["trainedAt"] + 6 * ONE_HOUR_MS
    assert paths.chronos_current_path.is_file()

    # Subsequent failure must NOT clobber existing `current.json`
    def _failing_fit(*_a, **_kw):
        raise RuntimeError("boom during second train")

    monkeypatch.setattr(chronos2_train, "_run_chronos_lora_fit", _failing_fit)
    with pytest.raises(RuntimeError, match="boom"):
        chronos2_train.train_rolling_chronos2(
            {"dataDir": str(tmp_path), "cutoffTime": cutoff, "windowDays": 14, "valDays": 4}
        )
    preserved = json.loads(paths.chronos_current_path.read_text(encoding="utf-8"))
    assert preserved["versionId"] == cur_doc["versionId"]
    status_doc = json.loads(paths.chronos_status_path.read_text(encoding="utf-8"))
    assert "boom" in status_doc["lastError"]

    # chronos_runner.rolling_installed_status verifies live current.json
    st = chronos_runner.rolling_installed_status(tmp_path)
    assert st["installed"] is True
    assert st["versionId"] == cur_doc["versionId"]

    # chronos2_live reads liveChronosCurrentJson + liveKlinesParquet without any benchmark run dir
    import sys
    import types
    import research.model_benchmark.ts_adapters as ts_adapters

    class _FakeModel:
        def to(self, *args, **kwargs):
            return self

        def eval(self):
            return self

    fake_peft = types.ModuleType("peft")
    fake_peft.PeftModel = types.SimpleNamespace(from_pretrained=lambda *_a, **_k: _FakeModel())
    monkeypatch.setitem(sys.modules, "peft", fake_peft)
    monkeypatch.setattr(torch.cuda, "get_device_name", lambda _i=0: "Mock RTX 4050")
    monkeypatch.setattr(ts_adapters, "_base_model", lambda *_a: _FakeModel())
    monkeypatch.setattr(
        ts_adapters,
        "_prediction_mean",
        lambda _k, _m, contexts, _d: np.tile(np.array([101.0, 102.0, 103.0, 105.0]), (len(contexts), 1)),
    )

    out_live = tmp_path / "chronos_live.json"
    live_res = chronos2_live.run_chronos2_live(
        {
            "liveChronosCurrentJson": str(paths.chronos_current_path),
            "liveKlinesParquet": str(paths.klines_path),
            "symbols": symbols[:2],
            "decisionOpenTime": cutoff - ONE_HOUR_MS,
            "requireCuda": True,
        },
        out_live,
    )
    assert live_res["modelInfo"]["mode"] == "local-rolling"
    assert live_res["modelInfo"]["versionId"] == cur_doc["versionId"]
    assert live_res["forecasts"][symbols[0]]["predictedClose4h"] == pytest.approx(105.0)


def test_worker_rolling_prepare_and_commit_research_end_to_end(tmp_path: Path, monkeypatch) -> None:
    symbols = [f"C{i}USDT" for i in range(12)]
    cutoff = 1_760_000_400_000 + 25 * ONE_DAY_MS
    start = cutoff - 22 * ONE_DAY_MS

    seed_dir = tmp_path / "model-research" / "datasets"
    seed_dir.mkdir(parents=True)
    _make_klines(symbols, start, 22 * 24).to_parquet(seed_dir / "klines_1h.parquet", index=False)
    _make_funding(symbols, start - 8 * ONE_DAY_MS, cutoff).to_parquet(seed_dir / "funding_rates.parquet", index=False)
    (seed_dir / "dataset_manifest.json").write_text(
        json.dumps({"universe": {"symbols": symbols}}),
        encoding="utf-8",
    )

    rank_res = worker.handle_rolling_prepare_and_train_rank(
        {
            "dataDir": str(tmp_path),
            "targetCutoffTime": cutoff,
            "windowDays": 14,
            "valDays": 4,
            "allowNetwork": False,
        }
    )
    assert rank_res["inputMode"] == "live"
    assert rank_res["cutoffTime"] == cutoff
    assert rank_res["decisionOpenTime"] == cutoff - ONE_HOUR_MS
    assert rank_res["chronosTrainDue"] is True
    assert rank_res["rollingPipeline"]["lgbm"]["ready"] is True

    chronos_mock = {
        "decisionOpenTime": cutoff - ONE_HOUR_MS,
        "forecasts": {
            rank_res["chronosTargetSymbols"][0]: {
                "symbol": rank_res["chronosTargetSymbols"][0],
                "lastClose": 110.0,
                "predictedClose4h": 112.0,
                "predictedPath": [110.5, 111.0, 111.5, 112.0],
            }
        },
        "skipped": [],
        "elapsedMs": 120.0,
        "modelInfo": {
            "versionId": "chr2-mock-1",
            "trainedAt": cutoff - 1000,
            "valReturnMae": 0.011,
            "baseRepoId": "amazon/chronos-2",
            "baseRevision": "rev-1",
            "adapterHashes": {"adapter/adapter_model.safetensors": "abc123"},
            "gpuName": "Mock RTX 4050",
            "cudaAvailable": True,
        },
    }
    res = worker.handle_commit_rolling_research(
        {
            "dataDir": str(tmp_path),
            "runId": "run-rolling-shared-1",
            "rankResult": rank_res,
            "chronosResult": chronos_mock,
        }
    )
    assert res["status"] == "SUCCESS"
    assert res["kronosModel"] == "chronos2"
    latest_ptr = json.loads((tmp_path / "model-research" / "latest-run.json").read_text(encoding="utf-8"))
    assert latest_ptr["runId"] == "run-rolling-shared-1"


def test_standalone_lgbm_hourly_update_publishes_ranking_and_dedups(tmp_path: Path) -> None:
    symbols = [f"C{i}USDT" for i in range(12)]
    cutoff = 1_760_000_400_000 + 25 * ONE_DAY_MS
    start = cutoff - 22 * ONE_DAY_MS

    seed_dir = tmp_path / "model-research" / "datasets"
    seed_dir.mkdir(parents=True)
    _make_klines(symbols, start, 22 * 24).to_parquet(seed_dir / "klines_1h.parquet", index=False)
    _make_funding(symbols, start - 8 * ONE_DAY_MS, cutoff).to_parquet(seed_dir / "funding_rates.parquet", index=False)
    (seed_dir / "dataset_manifest.json").write_text(
        json.dumps({"universe": {"symbols": symbols}}),
        encoding="utf-8",
    )

    first = worker.handle_rolling_update_lgbm_rank(
        {
            "dataDir": str(tmp_path),
            "targetCutoffTime": cutoff,
            "windowDays": 14,
            "valDays": 4,
            "allowNetwork": False,
        }
    )
    assert first["snapshotId"].startswith(f"lgbm-{cutoff}-")
    assert first["trainAudit"]["retrained"] is True
    assert first["trainAudit"]["dedupedSameCutoff"] is False
    assert first["trainAudit"]["elapsedMs"] >= 0
    assert (tmp_path / "model-live" / "models" / "lgbm" / "latest-ranking.json").is_file()
    assert (tmp_path / "model-live" / "models" / "lgbm" / "rankings" / f"{cutoff}.json").is_file()

    # Same cutoff second run deduplicates training cleanly without Chronos dependency
    second = worker.handle_rolling_update_lgbm_rank(
        {
            "dataDir": str(tmp_path),
            "targetCutoffTime": cutoff,
            "windowDays": 14,
            "valDays": 4,
            "allowNetwork": False,
            "skipTrainingIfSameCutoff": False,
        }
    )
    assert second["trainAudit"]["dedupedSameCutoff"] is True
    assert second["trainAudit"]["retrained"] is False
    assert second["lightgbm"]["versionId"] == first["lightgbm"]["versionId"]


def test_standalone_lgbm_rejects_future_and_stale_cutoffs_before_mutating_live_data(tmp_path: Path, monkeypatch) -> None:
    cutoff = 1_760_000_400_000
    paths = rolling_store.resolve_live_paths(tmp_path)
    paths.datasets_dir.mkdir(parents=True)
    paths.state_path.write_text(json.dumps({"lastCutoffTime": cutoff}), encoding="utf-8")
    before = paths.state_path.read_bytes()

    def forbidden_sync(**_kwargs):
        pytest.fail("stale/future request must not synchronize or retrain")

    monkeypatch.setattr(rolling_store, "sync_rolling_dataset", forbidden_sync)
    monkeypatch.setattr(worker.time, "time", lambda: (cutoff + 1000) / 1000)
    with pytest.raises(worker.DataNotReadyError, match="未來"):
        worker.handle_rolling_update_lgbm_rank({"dataDir": str(tmp_path), "targetCutoffTime": cutoff + ONE_HOUR_MS})
    with pytest.raises(worker.DataNotReadyError, match="舊 cutoff"):
        worker.handle_rolling_update_lgbm_rank({"dataDir": str(tmp_path), "targetCutoffTime": cutoff - ONE_HOUR_MS})
    assert paths.state_path.read_bytes() == before
    assert not paths.lgbm_current_path.exists()
    assert not (paths.lgbm_root / "latest-ranking.json").exists()
