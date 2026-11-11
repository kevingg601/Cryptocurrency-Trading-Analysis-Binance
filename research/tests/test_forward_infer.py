"""Tests for forward_rank (worker.py) and chronos2_live.py."""
from __future__ import annotations

import hashlib
import io
import json
import subprocess
import sys
import types
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from research.model_research import chronos2_live, worker
from research.model_research.features_and_labels import ONE_HOUR_MS


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    h.update(path.read_bytes())
    return h.hexdigest()


def _make_klines_df(symbols: list[str], start_open: int, count: int, *, base_price: float = 100.0) -> pd.DataFrame:
    rows = []
    for sym_idx, sym in enumerate(symbols):
        for i in range(count):
            t = start_open + i * ONE_HOUR_MS
            close_p = base_price + sym_idx * 5.0 + i * 0.1
            rows.append(
                {
                    "symbol": sym,
                    "open_time": t,
                    "close_time": t + ONE_HOUR_MS - 1,
                    "open": close_p - 0.5,
                    "high": close_p + 1.0,
                    "low": close_p - 1.0,
                    "close": close_p,
                    "volume": 100.0 + i,
                    "quote_volume": (100.0 + i) * close_p,
                    "trades": 50 + i,
                    "taker_buy_base": 50.0,
                    "taker_buy_quote": 50.0 * close_p,
                    "is_final": True,
                    "source": "binance_rest_1h",
                }
            )
    return pd.DataFrame(rows)[worker.EXPECTED_KLINES_COLUMNS]


def _make_funding_df(symbols: list[str], start_open: int, end_open: int) -> pd.DataFrame:
    rows = []
    t = start_open
    while t <= end_open:
        for sym in symbols:
            rows.append(
                {
                    "symbol": sym,
                    "funding_time": t,
                    "funding_rate": 0.0001,
                    "mark_price": 100.0,
                    "source": "binance_rest_funding",
                }
            )
        t += 8 * ONE_HOUR_MS
    return pd.DataFrame(rows)[worker.EXPECTED_FUNDING_COLUMNS]


class _FakeBooster:
    def __init__(self, bias: float = 1.0) -> None:
        self.bias = bias

    def predict(self, X: np.ndarray) -> np.ndarray:
        return np.arange(len(X), dtype=np.float64) * self.bias + 1.0


def _setup_rank_env(tmp_path: Path, symbols: list[str], base_start: int, base_bars: int):
    mr_dir = tmp_path / "model-research"
    datasets_dir = mr_dir / "datasets"
    models_dir = mr_dir / "models"
    datasets_dir.mkdir(parents=True)
    models_dir.mkdir(parents=True)

    base_df = _make_klines_df(symbols, base_start, base_bars)
    base_df.to_parquet(datasets_dir / "klines_1h.parquet", index=False)
    funding_df = _make_funding_df(symbols, base_start, base_start + base_bars * ONE_HOUR_MS)
    funding_df.to_parquet(datasets_dir / "funding_rates.parquet", index=False)

    meta = {
        "pipeline_version": 3,
        "feature_columns": None,
        "long_model": {"sha256": "long-sha-1", "selected_params": {}},
        "short_model": {"sha256": "short-sha-1", "selected_params": {}},
    }
    return datasets_dir, models_dir, meta


def test_forward_rank_merges_csv_excludes_unclosed_and_never_touches_latest_run(tmp_path: Path, monkeypatch):
    symbols = [f"COIN{i}USDT" for i in range(12)]
    all_symbols_in_parquet = symbols + ["EXTRAUSDT"]
    base_start = 1_760_000_400_000  # aligned UTC hour
    base_bars = 105
    H = base_start + base_bars * ONE_HOUR_MS  # target decision_open_time
    cutoff = H + ONE_HOUR_MS

    datasets_dir, _, meta = _setup_rank_env(tmp_path, all_symbols_in_parquet, base_start, base_bars)
    pointer = tmp_path / "model-research" / "latest-run.json"
    pointer.write_text('{"runId": "run-old-kronos"}', encoding="utf-8")

    # Supplemental CSV provides closed bar H AND unclosed bars (is_final=False at H, plus future H+1h)
    closed_supp = _make_klines_df(symbols, H, 1, base_price=200.0)
    unclosed_supp = _make_klines_df(symbols[:2], H, 1, base_price=999.0)
    unclosed_supp["is_final"] = False
    future_supp = _make_klines_df(symbols, cutoff, 1, base_price=888.0)
    supp_df = pd.concat([closed_supp, unclosed_supp, future_supp], ignore_index=True)
    supp_csv = tmp_path / "supp_klines.csv"
    supp_df.to_csv(supp_csv, index=False)

    supp_funding = _make_funding_df(symbols, cutoff - 8 * ONE_HOUR_MS, cutoff + ONE_HOUR_MS)
    supp_funding_csv = tmp_path / "supp_funding.csv"
    supp_funding.to_csv(supp_funding_csv, index=False)

    monkeypatch.setattr(
        "research.model_research.lightgbm_ranker.load_lightgbm_models",
        lambda *_a: (_FakeBooster(1.0), _FakeBooster(-1.0), meta),
    )
    monkeypatch.setattr(worker.time, "time", lambda: (cutoff + 30_000) / 1000.0)

    out_path = tmp_path / "out" / "rank.json"
    res = worker.handle_forward_rank(
        {
            "action": "forward_rank",
            "dataDir": str(tmp_path),
            "inputMode": "live",
            "targetCutoffTime": cutoff,
            "universeSymbols": symbols,
            "supplementalKlinesCsv": str(supp_csv),
            "supplementalFundingCsv": str(supp_funding_csv),
            "outputPath": str(out_path),
        }
    )

    assert res["inputMode"] == "live"
    assert res["replay"] is False
    assert res["decisionOpenTime"] == H
    assert res["cutoffTime"] == cutoff
    assert res["eligibleCount"] == 12
    assert "EXTRAUSDT" not in [r["symbol"] for r in res["longTop5"] + res["shortTop5"]]
    # Close price must come from closed bar H (200.0 + ...), not unclosed (999) or future (888)
    for entry in res["longTop5"] + res["shortTop5"]:
        assert 190.0 <= entry["closePrice"] <= 270.0
    assert isinstance(res["inputSha256"], str) and len(res["inputSha256"]) == 64
    assert res["inputHashes"]["before"]["supplementalKlinesSha256"] is not None
    assert res["lightgbm"]["longSha256"] == "long-sha-1"
    assert out_path.is_file()
    # Existing Kronos latest-run.json must remain untouched
    assert json.loads(pointer.read_text(encoding="utf-8"))["runId"] == "run-old-kronos"


def test_forward_rank_live_missing_hour_raises_data_not_ready_via_cli(tmp_path: Path, monkeypatch):
    symbols = [f"COIN{i}USDT" for i in range(12)]
    base_start = 1_760_000_400_000
    base_bars = 105
    H = base_start + base_bars * ONE_HOUR_MS  # missing in parquet (parquet only has up to H - 1h)
    cutoff = H + ONE_HOUR_MS

    _, _, meta = _setup_rank_env(tmp_path, symbols, base_start, base_bars)
    monkeypatch.setattr(
        "research.model_research.lightgbm_ranker.load_lightgbm_models",
        lambda *_a: (_FakeBooster(1.0), _FakeBooster(-1.0), meta),
    )
    monkeypatch.setattr(worker.time, "time", lambda: (cutoff + 30_000) / 1000.0)

    with pytest.raises(worker.DataNotReadyError):
        worker.handle_forward_rank(
            {
                "action": "forward_rank",
                "dataDir": str(tmp_path),
                "inputMode": "live",
                "targetCutoffTime": cutoff,
                "universeSymbols": symbols,
                "outputPath": str(tmp_path / "rank.json"),
            }
        )

    # Also verify live rejects stale cutoff (> 2h old)
    monkeypatch.setattr(worker.time, "time", lambda: (cutoff + 3 * ONE_HOUR_MS) / 1000.0)
    with pytest.raises(ValueError, match="2h"):
        worker.handle_forward_rank(
            {
                "action": "forward_rank",
                "dataDir": str(tmp_path),
                "inputMode": "live",
                "targetCutoffTime": cutoff,
                "universeSymbols": symbols,
                "outputPath": str(tmp_path / "rank.json"),
            }
        )

    # Replay mode allows past cutoff and tags replay=True
    res_replay = worker.handle_forward_rank(
        {
            "action": "forward_rank",
            "dataDir": str(tmp_path),
            "inputMode": "replay",
            "targetCutoffTime": H,  # H-1h exists in parquet!
            "universeSymbols": symbols,
            "outputPath": str(tmp_path / "rank_replay.json"),
        }
    )
    assert res_replay["replay"] is True
    assert res_replay["inputMode"] == "replay"
    assert res_replay["decisionOpenTime"] == H - ONE_HOUR_MS


def test_forward_rank_rejects_mismatched_csv_columns(tmp_path: Path, monkeypatch):
    symbols = [f"COIN{i}USDT" for i in range(12)]
    base_start = 1_760_000_400_000
    _, _, meta = _setup_rank_env(tmp_path, symbols, base_start, 105)
    H = base_start + 104 * ONE_HOUR_MS
    cutoff = H + ONE_HOUR_MS
    monkeypatch.setattr(
        "research.model_research.lightgbm_ranker.load_lightgbm_models",
        lambda *_a: (_FakeBooster(1.0), _FakeBooster(-1.0), meta),
    )
    monkeypatch.setattr(worker.time, "time", lambda: (cutoff + 10_000) / 1000.0)

    bad_csv = tmp_path / "bad.csv"
    pd.DataFrame([{"symbol": "COIN0USDT", "open_time": H}]).to_csv(bad_csv, index=False)
    with pytest.raises(ValueError, match="欄位與規格不一致"):
        worker.handle_forward_rank(
            {
                "action": "forward_rank",
                "dataDir": str(tmp_path),
                "inputMode": "live",
                "targetCutoffTime": cutoff,
                "universeSymbols": symbols,
                "supplementalKlinesCsv": str(bad_csv),
                "outputPath": str(tmp_path / "rank.json"),
            }
        )


def test_worker_main_emits_data_not_ready_protocol_error(tmp_path: Path, monkeypatch):
    monkeypatch.setattr(
        worker,
        "handle_forward_rank",
        lambda _req: (_ for _ in ()).throw(worker.DataNotReadyError("missing H")),
    )
    buf = io.StringIO()
    monkeypatch.setattr(worker, "_PROTOCOL_STDOUT", buf)
    monkeypatch.setattr(sys, "stdin", io.StringIO(json.dumps({"action": "forward_rank"}) + "\n"))
    monkeypatch.setattr(sys, "stdout", buf)

    code = worker.main()
    assert code == 4
    lines = [json.loads(line) for line in buf.getvalue().strip().splitlines() if line]
    assert len(lines) == 1
    assert lines[0]["event"] == "error"
    assert lines[0]["errorCode"] == "DATA_NOT_READY"


def _create_fake_benchmark_run(tmp_path: Path, *, portable_linux_path: bool = False):
    run_id = "run-chronos-test-1"
    run_dir = tmp_path / "runs" / run_id
    attempt_dir = run_dir / "models" / "chronos2" / "attempt-01-cuda-abc123"
    adapter_dir = attempt_dir / "adapter"
    adapter_dir.mkdir(parents=True)

    (adapter_dir / "adapter_config.json").write_text(json.dumps({"r": 8}), encoding="utf-8")
    (adapter_dir / "adapter_model.safetensors").write_bytes(b"fake-adapter-weights-v1")
    (adapter_dir / "README.md").write_text("adapter readme", encoding="utf-8")

    inner_hashes = {
        "README.md": _sha256_file(adapter_dir / "README.md"),
        "adapter_config.json": _sha256_file(adapter_dir / "adapter_config.json"),
        "adapter_model.safetensors": _sha256_file(adapter_dir / "adapter_model.safetensors"),
    }
    (adapter_dir / "adapter.sha256.json").write_text(json.dumps(inner_hashes, indent=2), encoding="utf-8")

    artifact_hashes = {
        "adapter/README.md": _sha256_file(adapter_dir / "README.md"),
        "adapter/adapter.sha256.json": _sha256_file(adapter_dir / "adapter.sha256.json"),
        "adapter/adapter_config.json": _sha256_file(adapter_dir / "adapter_config.json"),
        "adapter/adapter_model.safetensors": _sha256_file(adapter_dir / "adapter_model.safetensors"),
    }
    raw_attempt_str = (
        f"/content/colab/runs/{run_id}/models/chronos2/attempt-01-cuda-abc123"
        if portable_linux_path
        else str(attempt_dir)
    )
    lock_info = json.loads(
        (Path(__file__).resolve().parents[1] / "model_benchmark" / "model-assets.lock.json").read_text(encoding="utf-8")
    )["models"]["chronos2"]

    manifest = {
        "schema": 1,
        "run_id": run_id,
        "models": {
            "chronos2": {
                "status": "SUCCESS",
                "attempt_dir": raw_attempt_str,
                "artifact_hashes": {k.replace("/", "\\"): v for k, v in artifact_hashes.items()},
                "fingerprint": "fp-test-123",
                "training": {"revision": lock_info["revision"]},
            }
        },
    }
    (run_dir / "run_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    return run_dir, adapter_dir, artifact_hashes, lock_info["revision"]


def test_chronos2_live_cuda_unavailable_exits_3_with_protocol_error(tmp_path: Path, monkeypatch):
    run_dir, _, hashes, revision = _create_fake_benchmark_run(tmp_path)
    req_path = tmp_path / "req.json"
    out_path = tmp_path / "chronos.json"
    req_path.write_text(
        json.dumps(
            {
                "adapterRunDir": str(run_dir),
                "expectedAdapterHashes": hashes,
                "expectedBaseRevision": revision,
                "baseKlinesParquet": str(tmp_path / "missing.parquet"),
                "symbols": ["BTCUSDT"],
                "decisionOpenTime": 1_760_000_400_000,
                "requireCuda": True,
            }
        ),
        encoding="utf-8",
    )

    import torch

    monkeypatch.setattr(torch.cuda, "is_available", lambda: False)
    stdout_buf = io.StringIO()
    monkeypatch.setattr(sys, "stdout", stdout_buf)

    code = chronos2_live.main(["--request", str(req_path), "--output", str(out_path)])
    assert code == 3
    lines = [json.loads(line) for line in stdout_buf.getvalue().strip().splitlines() if line]
    assert len(lines) == 1
    assert lines[0]["event"] == "error"
    assert lines[0]["errorCode"] == "CUDA_UNAVAILABLE"
    assert not out_path.exists()


def test_chronos2_live_rejects_tampered_adapter_or_wrong_revision(tmp_path: Path, monkeypatch):
    run_dir, adapter_dir, hashes, revision = _create_fake_benchmark_run(tmp_path, portable_linux_path=True)

    import torch

    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)

    # Wrong base revision
    req_bad_rev = {
        "adapterRunDir": str(run_dir),
        "expectedAdapterHashes": hashes,
        "expectedBaseRevision": "wrong-revision",
        "baseKlinesParquet": str(tmp_path / "base.parquet"),
        "symbols": [],
        "decisionOpenTime": 1_760_000_400_000,
        "requireCuda": True,
    }
    with pytest.raises(chronos2_live.AdapterVerificationError, match="revision"):
        chronos2_live.run_chronos2_live(req_bad_rev, tmp_path / "out.json")

    # Tamper adapter file on disk
    (adapter_dir / "adapter_model.safetensors").write_bytes(b"tampered-weights")
    req_tampered = {
        **req_bad_rev,
        "expectedBaseRevision": revision,
    }
    with pytest.raises(chronos2_live.AdapterVerificationError, match="雜湊驗證失敗"):
        chronos2_live.run_chronos2_live(req_tampered, tmp_path / "out.json")

    # Tamper adapter.sha256.json directly while resetting artifact_hashes to match
    (adapter_dir / "adapter.sha256.json").write_text('{"adapter_model.safetensors": "0000"}', encoding="utf-8")
    manifest_path = run_dir / "run_manifest.json"
    manifest_doc = json.loads(manifest_path.read_text(encoding="utf-8"))
    new_hashes = dict(hashes)
    new_hashes["adapter/adapter.sha256.json"] = _sha256_file(adapter_dir / "adapter.sha256.json")
    manifest_doc["models"]["chronos2"]["artifact_hashes"] = new_hashes
    manifest_path.write_text(json.dumps(manifest_doc), encoding="utf-8")
    req_bad_inner = {
        **req_tampered,
        "expectedAdapterHashes": new_hashes,
    }
    req_path = tmp_path / "bad_inner.json"
    req_path.write_text(json.dumps(req_bad_inner), encoding="utf-8")
    buf = io.StringIO()
    monkeypatch.setattr(sys, "stdout", buf)
    code = chronos2_live.main(["--request", str(req_path), "--output", str(tmp_path / "out_inner.json")])
    assert code == 2
    err_doc = json.loads(buf.getvalue().strip())
    assert err_doc["errorCode"] == "ADAPTER_VERIFICATION_FAILED"


def test_chronos2_live_256_window_and_prediction_mean_mocked(tmp_path: Path, monkeypatch):
    run_dir, _, hashes, revision = _create_fake_benchmark_run(tmp_path, portable_linux_path=True)

    base_start = 1_760_000_400_000
    H = base_start + 255 * ONE_HOUR_MS  # exactly 256 bars [base_start .. H]

    # BTCUSDT: 254 in parquet + 2 in CSV = 256 contiguous
    # ETHUSDT: missing bar H-5h (gap -> skipped)
    # SOLUSDT: only 200 bars (short -> skipped)
    btc_base = _make_klines_df(["BTCUSDT"], base_start, 254, base_price=50_000.0)
    eth_all = _make_klines_df(["ETHUSDT"], base_start, 256, base_price=3_000.0)
    eth_gapped = eth_all[eth_all["open_time"] != H - 5 * ONE_HOUR_MS]
    sol_short = _make_klines_df(["SOLUSDT"], H - 199 * ONE_HOUR_MS, 200, base_price=150.0)

    base_parquet = tmp_path / "klines_1h.parquet"
    pd.concat([btc_base, eth_gapped, sol_short], ignore_index=True).to_parquet(base_parquet, index=False)

    # CSV adds remaining 2 closed bars for BTC + an unclosed bar at H+1h (must be excluded!)
    btc_csv = pd.concat(
        [
            _make_klines_df(["BTCUSDT"], H - ONE_HOUR_MS, 2, base_price=50_000.0 + 254 * 0.1),
            _make_klines_df(["BTCUSDT"], H + ONE_HOUR_MS, 1, base_price=99_999.0),
        ],
        ignore_index=True,
    )
    csv_path = tmp_path / "klines_1h.csv"
    btc_csv.to_csv(csv_path, index=False)

    import torch
    import research.model_benchmark.ts_adapters as ts_adapters

    class _FakeModel:
        def to(self, *args, **kwargs):
            return self

        def eval(self):
            return self

    fake_peft = types.ModuleType("peft")
    fake_peft.PeftModel = types.SimpleNamespace(
        from_pretrained=lambda base, adapter_dir, is_trainable=False: _FakeModel()
    )
    monkeypatch.setitem(sys.modules, "peft", fake_peft)
    monkeypatch.setattr(torch.cuda, "is_available", lambda: True)
    monkeypatch.setattr(torch.cuda, "get_device_name", lambda _idx=0: "Mock RTX GPU")
    monkeypatch.setattr(ts_adapters, "_base_model", lambda model_key, device: _FakeModel())

    captured_contexts = []

    def _fake_pred_mean(model_key, model, contexts, device):
        assert model_key == "chronos2"
        assert device == "cuda"
        captured_contexts.extend(contexts)
        return np.array([[50_100.0, 50_200.0, 50_300.0, 50_450.0]], dtype=np.float64)

    monkeypatch.setattr(ts_adapters, "_prediction_mean", _fake_pred_mean)

    req_path = tmp_path / "req.json"
    out_path = tmp_path / "chronos.json"
    req_path.write_text(
        json.dumps(
            {
                "adapterRunDir": str(run_dir),
                "expectedAdapterHashes": hashes,
                "expectedBaseRevision": revision,
                "klinesCsv": str(csv_path),
                "baseKlinesParquet": str(base_parquet),
                "symbols": ["BTCUSDT", "ETHUSDT", "SOLUSDT"],
                "decisionOpenTime": H,
                "requireCuda": True,
            }
        ),
        encoding="utf-8",
    )

    stdout_buf = io.StringIO()
    monkeypatch.setattr(sys, "stdout", stdout_buf)
    code = chronos2_live.main(["--request", str(req_path), "--output", str(out_path)])
    assert code == 0

    lines = [json.loads(line) for line in stdout_buf.getvalue().strip().splitlines() if line]
    assert len(lines) == 1
    assert lines[0]["event"] == "result"

    out_doc = json.loads(out_path.read_text(encoding="utf-8"))
    assert len(captured_contexts) == 1
    assert captured_contexts[0].shape == (256,)
    assert "BTCUSDT" in out_doc["forecasts"]
    assert out_doc["forecasts"]["BTCUSDT"]["predictedClose4h"] == pytest.approx(50_450.0)
    assert out_doc["forecasts"]["BTCUSDT"]["predictedPath"] == pytest.approx([50_100.0, 50_200.0, 50_300.0, 50_450.0])
    assert {s["symbol"] for s in out_doc["skipped"]} == {"ETHUSDT", "SOLUSDT"}
    assert out_doc["modelInfo"]["gpuName"] == "Mock RTX GPU"
