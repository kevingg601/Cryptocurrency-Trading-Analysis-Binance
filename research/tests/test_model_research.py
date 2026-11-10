"""
Unit tests for Fadachi LightGBM + Kronos research pipeline:
- UTC 1m -> 1h aggregation & unclosed bar exclusion
- Deduplication & gap detection without forward-filling
- Feature causality & gap invalidation
- Cross-split boundary label exclusion
- Ranking group minimum 10-symbol threshold & 0..4 relevance grades
- Long/Short net returns, 5bps fee + 5bps slippage, positive/negative funding rates,
  settlement boundaries (entry_time, exit_time], and missing funding exclusion
- Worker JSONL stdout isolation, OOM, and missing model handling
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from research.model_research.features_and_labels import (
    EIGHT_HOURS_MS,
    FEATURE_COLUMNS,
    ONE_DAY_MS,
    ONE_HOUR_MS,
    ONE_MINUTE_MS,
    TimeSplitBoundaries,
    aggregate_1m_to_1h_utc,
    assign_relevance_grades,
    assign_time_splits,
    build_research_panel,
    compute_features,
    compute_forward_labels,
    compute_time_split_boundaries,
    validate_and_deduplicate_1h,
)
from research.model_research.lightgbm_ranker import evaluate_ranking_split, train_and_evaluate_lightgbm, rank_at_cutoff, load_lightgbm_models
from research.model_research.offline_eval import run_offline_evaluation
import research.model_research.offline_eval as offline_eval_module
import research.model_research.cli as research_cli


def test_utc_1m_to_1h_aggregation_and_unclosed_exclusion():
    base_hour = 1_760_000_400_000  # Exact UTC hour multiple (488889 * 3600_000)
    assert base_hour % ONE_HOUR_MS == 0

    rows = []
    # Hour 0: Complete 60 closed 1m bars + 1 duplicate on minute 0 to test deduplication
    for m in range(60):
        t = base_hour + m * ONE_MINUTE_MS
        rows.append(
            {
                "symbol": "BTCUSDT",
                "open_time": t,
                "open": 100.0 + m,
                "high": 105.0 + m,
                "low": 95.0 + m,
                "close": 101.0 + m,
                "volume": 10.0,
                "quote_volume": 1000.0,
                "is_final": True,
                "recv_time": t + 100,
            }
        )
    # Duplicate minute 0 with earlier recv_time (should be ignored in favor of later recv_time)
    rows.append(
        {
            "symbol": "BTCUSDT",
            "open_time": base_hour,
            "open": 999.0,
            "high": 999.0,
            "low": 999.0,
            "close": 999.0,
            "volume": 999.0,
            "quote_volume": 99999.0,
            "is_final": True,
            "recv_time": base_hour + 10,
        }
    )

    # Hour 1: Only 59 closed 1m bars + 1 unclosed (is_final=False) bar -> must NOT aggregate, must report gap
    hour1 = base_hour + ONE_HOUR_MS
    for m in range(60):
        t = hour1 + m * ONE_MINUTE_MS
        rows.append(
            {
                "symbol": "BTCUSDT",
                "open_time": t,
                "open": 200.0,
                "high": 210.0,
                "low": 190.0,
                "close": 205.0,
                "volume": 5.0,
                "quote_volume": 500.0,
                "is_final": m < 59,  # 60th bar is not final!
                "recv_time": t + 100,
            }
        )

    # Hour 2: Complete 60 bars, but cutoff_ms is in the middle of Hour 2 -> unclosed hour must be excluded
    hour2 = base_hour + 2 * ONE_HOUR_MS
    for m in range(60):
        t = hour2 + m * ONE_MINUTE_MS
        rows.append(
            {
                "symbol": "BTCUSDT",
                "open_time": t,
                "open": 300.0,
                "high": 310.0,
                "low": 290.0,
                "close": 305.0,
                "volume": 5.0,
                "quote_volume": 500.0,
                "is_final": True,
                "recv_time": t + 100,
            }
        )

    df_1m = pd.DataFrame(rows)
    cutoff = hour2 + 30 * ONE_MINUTE_MS
    agg_1h, gaps = aggregate_1m_to_1h_utc(df_1m, cutoff_ms=cutoff)

    assert len(agg_1h) == 1
    bar0 = agg_1h.iloc[0]
    assert int(bar0["open_time"]) == base_hour
    assert float(bar0["open"]) == 100.0
    assert float(bar0["high"]) == 105.0 + 59
    assert float(bar0["low"]) == 95.0
    assert float(bar0["close"]) == 101.0 + 59
    assert float(bar0["volume"]) == 600.0
    assert float(bar0["quote_volume"]) == 60000.0
    assert bar0["source"] == "local_1m_agg"

    # Hour 1 should be reported as an incomplete 1m hour (59/60)
    assert len(gaps) == 1
    assert gaps[0]["hour_open_time"] == hour1
    assert gaps[0]["bar_count"] == 59


def test_1h_deduplication_and_gap_detection_without_ffill():
    base_hour = 1_760_000_400_000
    rows = [
        # Hour 0: both local_1m_agg and binance_rest_1h -> local_1m_agg must win
        {
            "symbol": "ETHUSDT",
            "open_time": base_hour,
            "open": 2000.0,
            "high": 2010.0,
            "low": 1990.0,
            "close": 2005.0,
            "volume": 100.0,
            "quote_volume": 200000.0,
            "is_final": True,
            "source": "binance_rest_1h",
        },
        {
            "symbol": "ETHUSDT",
            "open_time": base_hour,
            "open": 2001.0,
            "high": 2012.0,
            "low": 1991.0,
            "close": 2006.0,
            "volume": 101.0,
            "quote_volume": 201000.0,
            "is_final": True,
            "source": "local_1m_agg",
        },
        # Hour 1 & Hour 2 are missing (2-hour gap)
        # Hour 3: present
        {
            "symbol": "ETHUSDT",
            "open_time": base_hour + 3 * ONE_HOUR_MS,
            "open": 2020.0,
            "high": 2030.0,
            "low": 2010.0,
            "close": 2025.0,
            "volume": 120.0,
            "quote_volume": 240000.0,
            "is_final": True,
            "source": "binance_rest_1h",
        },
        # Hour 4: unclosed (is_final=False) -> must be excluded
        {
            "symbol": "ETHUSDT",
            "open_time": base_hour + 4 * ONE_HOUR_MS,
            "open": 2025.0,
            "high": 2050.0,
            "low": 2000.0,
            "close": 2040.0,
            "volume": 80.0,
            "quote_volume": 160000.0,
            "is_final": False,
            "source": "binance_rest_1h",
        },
    ]

    clean_df, gaps = validate_and_deduplicate_1h(
        pd.DataFrame(rows),
        cutoff_ms=base_hour + 5 * ONE_HOUR_MS,
        expected_start_ms=base_hour,
        expected_end_ms=base_hour + 4 * ONE_HOUR_MS,
    )

    # Must NOT forward-fill missing hours: only 2 rows should exist
    assert len(clean_df) == 2
    assert clean_df.iloc[0]["source"] == "local_1m_agg"
    assert float(clean_df.iloc[0]["close"]) == 2006.0
    assert int(clean_df.iloc[1]["open_time"]) == base_hour + 3 * ONE_HOUR_MS

    eth_gaps = gaps["ETHUSDT"]
    assert len(eth_gaps) == 1
    assert eth_gaps[0]["from_time"] == base_hour + ONE_HOUR_MS
    assert eth_gaps[0]["to_time"] == base_hour + 3 * ONE_HOUR_MS
    assert eth_gaps[0]["missing_hours"] == 2


def test_feature_causality_and_gap_invalidation():
    base_hour = (1_760_000_000_000 // EIGHT_HOURS_MS) * EIGHT_HOURS_MS
    rng = np.random.default_rng(42)
    symbols = ["BTCUSDT", "ETHUSDT"]
    n_hours = 200

    records = []
    funding_records = []
    for sym_idx, sym in enumerate(symbols):
        price = 100.0 * (sym_idx + 1)
        for h in range(n_hours):
            t = base_hour + h * ONE_HOUR_MS
            ret = rng.normal(0.0005, 0.01)
            open_p = price
            close_p = price * (1.0 + ret)
            high_p = max(open_p, close_p) * 1.005
            low_p = min(open_p, close_p) * 0.995
            price = close_p
            records.append(
                {
                    "symbol": sym,
                    "open_time": t,
                    "open": open_p,
                    "high": high_p,
                    "low": low_p,
                    "close": close_p,
                    "volume": 1000.0 + h,
                    "quote_volume": (1000.0 + h) * close_p,
                    "is_final": True,
                    "source": "binance_rest_1h",
                }
            )
            if t % EIGHT_HOURS_MS == 0:
                funding_records.append(
                    {
                        "symbol": sym,
                        "funding_time": t,
                        "funding_rate": float(rng.normal(0.0001, 0.0003)),
                    }
                )

    df_full = pd.DataFrame(records)
    df_funding_full = pd.DataFrame(funding_records)
    # Mutate all future data after hour 150 by +500% and future funding rates after decision_time of hour 150
    cutoff_open_t = base_hour + 150 * ONE_HOUR_MS
    decision_cutoff_t = cutoff_open_t + ONE_HOUR_MS
    df_mutated = df_full.copy()
    future_mask = df_mutated["open_time"] > cutoff_open_t
    df_mutated.loc[future_mask, ["open", "high", "low", "close", "quote_volume"]] *= 6.0

    df_funding_mutated = df_funding_full.copy()
    df_funding_mutated.loc[df_funding_mutated["funding_time"] > decision_cutoff_t, "funding_rate"] += 0.05

    feat_orig = compute_features(df_full, df_funding=df_funding_full)
    feat_mut = compute_features(df_mutated, df_funding=df_funding_mutated)

    orig_up_to_150 = feat_orig[feat_orig["open_time"] <= cutoff_open_t].reset_index(drop=True)
    mut_up_to_150 = feat_mut[feat_mut["open_time"] <= cutoff_open_t].reset_index(drop=True)

    # Ensure valid rows exist and all new macro/funding features are finite on valid rows
    valid_rows = orig_up_to_150[orig_up_to_150["features_valid"]]
    assert not valid_rows.empty
    for new_col in [
        "ret_48h",
        "ret_72h",
        "trend_4h_sma6_dist",
        "trend_4h_slope",
        "trend_24h_sma4_dist",
        "trend_24h_slope",
        "close_pos_24h",
        "amplitude_24h",
        "funding_rate_latest",
        "funding_rate_zscore_7d",
        "funding_rate_diff",
        "cs_rank_ret_72h",
        "cs_rank_funding_zscore_7d",
    ]:
        assert new_col in FEATURE_COLUMNS
        assert valid_rows[new_col].notna().all()

    for col in FEATURE_COLUMNS:
        np.testing.assert_allclose(
            orig_up_to_150[col].to_numpy(),
            mut_up_to_150[col].to_numpy(),
            rtol=1e-12,
            atol=1e-12,
            equal_nan=True,
        )

    # Verify exact boundary causality for funding_time:
    # A funding settlement at `decision_time = open_time + 1h` IS known at decision time,
    # whereas a settlement at `decision_time + 1ms` is in the future and MUST NOT be included!
    test_h = 120
    test_open_t = base_hour + test_h * ONE_HOUR_MS
    test_decision_t = test_open_t + ONE_HOUR_MS
    df_funding_boundary = df_funding_full[df_funding_full["funding_time"] < test_decision_t].copy()
    f_at_decision = pd.DataFrame(
        [{"symbol": "BTCUSDT", "funding_time": test_decision_t, "funding_rate": 0.0123}]
    )
    f_after_decision = pd.DataFrame(
        [{"symbol": "BTCUSDT", "funding_time": test_decision_t + 1, "funding_rate": 0.0123}]
    )
    feat_at_dec = compute_features(df_full, df_funding=pd.concat([df_funding_boundary, f_at_decision], ignore_index=True))
    feat_after_dec = compute_features(df_full, df_funding=pd.concat([df_funding_boundary, f_after_decision], ignore_index=True))

    row_at = feat_at_dec[(feat_at_dec["symbol"] == "BTCUSDT") & (feat_at_dec["open_time"] == test_open_t)].iloc[0]
    row_after = feat_after_dec[(feat_after_dec["symbol"] == "BTCUSDT") & (feat_after_dec["open_time"] == test_open_t)].iloc[0]
    assert float(row_at["funding_rate_latest"]) == pytest.approx(0.0123)
    assert float(row_after["funding_rate_latest"]) != pytest.approx(0.0123)

    # Now test gap invalidation: remove hour 50 for BTCUSDT -> hours 51..146 that depend on a 97-bar contiguous window must be invalidated
    df_with_gap = df_full[~((df_full["symbol"] == "BTCUSDT") & (df_full["open_time"] == base_hour + 50 * ONE_HOUR_MS))].copy()
    feat_gap = compute_features(df_with_gap, df_funding=df_funding_full)
    btc_after_gap = feat_gap[
        (feat_gap["symbol"] == "BTCUSDT")
        & (feat_gap["open_time"] > base_hour + 50 * ONE_HOUR_MS)
        & (feat_gap["open_time"] <= base_hour + (50 + 96) * ONE_HOUR_MS)
    ]
    assert (~btc_after_gap["features_valid"]).all()


def test_long_short_returns_costs_funding_signs_boundaries_and_missing_exclusion():
    # Align base_hour to 00:00 UTC (multiple of 8 hours)
    base_hour = (1_760_000_000_000 // EIGHT_HOURS_MS) * EIGHT_HOURS_MS
    # Generate 110 hours of constant-step prices so features are valid from hour 96 onward
    rows = []
    for h in range(110):
        t = base_hour + h * ONE_HOUR_MS
        # Make open and close predictable: open[h] = 100 + h
        p_open = 100.0 + h
        p_close = 100.5 + h
        rows.append(
            {
                "symbol": "BTCUSDT",
                "open_time": t,
                "open": p_open,
                "high": p_close + 1.0,
                "low": p_open - 1.0,
                "close": p_close,
                "volume": 100.0,
                "quote_volume": 100.0 * p_close,
                "is_final": True,
                "source": "binance_rest_1h",
            }
        )
    df_1h = pd.DataFrame(rows)
    feat_df = compute_features(df_1h)

    # Hour 72 is at base_hour + 72h (which is a multiple of 8h: 72 = 9 * 8).
    # Let's check decision hours around base_hour + 72h and base_hour + 80h:
    # - For decision at h=71 (open_time = base + 71h):
    #   entry_time = base + 72h (exact 8h boundary!), exit_time = base + 76h.
    #   Holding interval (base + 72h, base + 76h] does NOT include base + 72h!
    # - For decision at h=75 (open_time = base + 75h):
    #   entry_time = base + 76h, exit_time = base + 80h (exact 8h boundary!).
    #   Holding interval (base + 76h, base + 80h] DOES include base + 80h!
    funding_rows = [
        {"symbol": "BTCUSDT", "funding_time": base_hour + 72 * ONE_HOUR_MS, "funding_rate": 0.0010, "mark_price": 172.0},  # +10 bps at 72h
        {"symbol": "BTCUSDT", "funding_time": base_hour + 80 * ONE_HOUR_MS, "funding_rate": -0.0004, "mark_price": 180.0},  # -4 bps at 80h
        # Note: we intentionally omit funding at 88h to test missing funding exclusion!
    ]
    labeled = compute_forward_labels(feat_df, pd.DataFrame(funding_rows), fee_bps=5.0, slippage_bps=5.0)

    # 1. Check h=71: entry at 72h, exit at 76h -> 72h settlement is at entry_time, so NOT in (72h, 76h]
    row_71 = labeled[labeled["open_time"] == base_hour + 71 * ONE_HOUR_MS].iloc[0]
    assert not bool(row_71["funding_missing"])
    assert float(row_71["funding_rate_sum"]) == pytest.approx(0.0)
    expected_gross_long_71 = (176.0 - 172.0) / 172.0
    expected_gross_short_71 = (172.0 - 176.0) / 172.0
    assert float(row_71["gross_return_long"]) == pytest.approx(expected_gross_long_71)
    assert float(row_71["net_return_long"]) == pytest.approx(expected_gross_long_71 - 0.0020)
    assert float(row_71["net_return_short"]) == pytest.approx(expected_gross_short_71 - 0.0020)

    # 2. Check h=70: entry at 71h, exit at 75h -> 72h settlement (+0.0010) IS in (71h, 75h]
    row_70 = labeled[labeled["open_time"] == base_hour + 70 * ONE_HOUR_MS].iloc[0]
    assert not bool(row_70["funding_missing"])
    assert float(row_70["funding_rate_sum"]) == pytest.approx(0.0010)
    gross_l_70 = (175.0 - 171.0) / 171.0
    gross_s_70 = (171.0 - 175.0) / 171.0
    # Positive funding (+0.0010): Long pays (-0.0010), Short receives (+0.0010)
    cost_70 = 0.0010 * 172.0 / 171.0
    assert float(row_70["funding_cost_return"]) == pytest.approx(cost_70)
    assert float(row_70["net_return_long"]) == pytest.approx(gross_l_70 - 0.0020 - cost_70)
    assert float(row_70["net_return_short"]) == pytest.approx(gross_s_70 - 0.0020 + cost_70)

    # 3. Check h=75: entry at 76h, exit at 80h -> 80h settlement (-0.0004) IS in (76h, 80h] (at exit_time boundary)
    row_75 = labeled[labeled["open_time"] == base_hour + 75 * ONE_HOUR_MS].iloc[0]
    assert not bool(row_75["funding_missing"])
    assert float(row_75["funding_rate_sum"]) == pytest.approx(-0.0004)
    gross_l_75 = (180.0 - 176.0) / 176.0
    gross_s_75 = (176.0 - 180.0) / 176.0
    # Negative funding (-0.0004): Long receives (+0.0004), Short pays (-0.0004)
    cost_75 = -0.0004 * 180.0 / 176.0
    assert float(row_75["net_return_long"]) == pytest.approx(gross_l_75 - 0.0020 - cost_75)
    assert float(row_75["net_return_short"]) == pytest.approx(gross_s_75 - 0.0020 + cost_75)

    # 4. Check h=83: entry at 84h, exit at 88h -> 88h settlement is MISSING!
    row_83 = labeled[labeled["open_time"] == base_hour + 83 * ONE_HOUR_MS].iloc[0]
    assert bool(row_83["funding_missing"])
    assert np.isnan(row_83["net_return_long"])
    assert np.isnan(row_83["net_return_short"])


def test_cross_split_label_exclusion_and_ranking_groups(tmp_path: Path):
    # Create a synthetic 12-symbol dataset spanning train/val/test boundaries
    end_day_ms = (1_760_000_000_000 // ONE_DAY_MS) * ONE_DAY_MS
    boundaries = TimeSplitBoundaries(
        start_ms=end_day_ms - 12 * ONE_DAY_MS,
        train_end_ms=end_day_ms - 7 * ONE_DAY_MS,
        val_end_ms=end_day_ms - 2 * ONE_DAY_MS,
        test_end_ms=end_day_ms,
        train_days=5,
        val_days=5,
        test_days=2,
    )
    warmup_start = boundaries.start_ms - 100 * ONE_HOUR_MS
    symbols = [f"COIN{i:02d}USDT" for i in range(12)]
    rng = np.random.default_rng(123)

    kline_rows = []
    funding_rows = []
    hours = int((boundaries.test_end_ms - warmup_start) // ONE_HOUR_MS)

    for sym_i, sym in enumerate(symbols):
        price = 50.0 + sym_i * 10.0
        for h in range(hours):
            t = warmup_start + h * ONE_HOUR_MS
            # For the first 3 symbols, drop one hour in val to test <10 eligible symbols at a timestamp
            if sym_i < 3 and t == boundaries.train_end_ms + 5 * ONE_HOUR_MS:
                continue
            ret = rng.normal(0.0, 0.008)
            o_p = price
            c_p = max(1.0, price * (1.0 + ret))
            h_p = max(o_p, c_p) * 1.003
            l_p = min(o_p, c_p) * 0.997
            price = c_p
            kline_rows.append(
                {
                    "symbol": sym,
                    "open_time": t,
                    "open": o_p,
                    "high": h_p,
                    "low": l_p,
                    "close": c_p,
                    "volume": 500.0,
                    "quote_volume": 500.0 * c_p,
                    "is_final": True,
                    "source": "binance_rest_1h",
                }
            )
            if t % EIGHT_HOURS_MS == 0:
                    funding_rows.append({"symbol": sym, "funding_time": t, "funding_rate": 0.0001 + sym_i * 1e-5, "mark_price": price})
        # Also add final boundary funding
            funding_rows.append({"symbol": sym, "funding_time": boundaries.test_end_ms, "funding_rate": 0.0001 + sym_i * 1e-5, "mark_price": price})

    panel = build_research_panel(
        df_1h=pd.DataFrame(kline_rows),
        df_funding=pd.DataFrame(funding_rows),
        boundaries=boundaries,
    )

    # Verify cross-split boundary exclusion:
    # The next split's opening price is unavailable even when exit_time == split_end.
    # crosses_split_boundary MUST be True and group_eligible MUST be False!
    near_train_end = panel[
        (panel["split"] == "train") & (panel["open_time"] >= boundaries.train_end_ms - 5 * ONE_HOUR_MS)
    ]
    assert not near_train_end.empty
    assert near_train_end["crosses_split_boundary"].all()
    assert (~near_train_end["group_eligible"]).all()

    # Verify timestamp where 3 symbols had a gap (only 9 eligible symbols < 10) is skipped!
    gap_ts_rows = panel[panel["open_time"] == boundaries.train_end_ms + 6 * ONE_HOUR_MS]
    assert (gap_ts_rows["eligible_group_size"] == 9).all()
    assert (~gap_ts_rows["group_eligible"]).all()

    # Verify relevance grades are 0..4 on eligible groups
    elig = panel[panel["group_eligible"]]
    assert set(elig["label_long"].unique()).issubset({0, 1, 2, 3, 4})
    assert set(elig["label_short"].unique()).issubset({0, 1, 2, 3, 4})

    # Train LightGBM on this synthetic panel and verify ranking & conflict detection
    meta = train_and_evaluate_lightgbm(panel, tmp_path / "models", dataset_version="test-ds")
    assert "validation_metrics" in meta
    assert "test_metrics" in meta
    assert meta["pipeline_version"] == 3
    assert meta["ndcg_label_gain"] == [0, 1, 2, 3, 4]

    long_b, short_b, _ = load_lightgbm_models(tmp_path / "models")
    ranking = rank_at_cutoff(
        df_1h=pd.DataFrame(kline_rows),
        long_booster=long_b,
        short_booster=short_b,
        cutoff_ms=boundaries.test_end_ms,
        df_funding=pd.DataFrame(funding_rows),
    )
    assert ranking["status"] == "OK"
    assert len(ranking["long_top5"]) == 5
    assert "fundingRateZScore7d" in ranking["long_top5"][0]
    assert "trend24hSma4Dist" in ranking["long_top5"][0]
    assert len(ranking["short_top5"]) == 5
    assert 1 <= len(ranking["kronos_target_symbols"]) <= 6

    # Real saved boosters must accept missing funding without dropping price-valid symbols.
    # All variants also need strict JSON, since the collector parses the worker's JSONL.
    for sparse_funding in [None, pd.DataFrame(), pd.DataFrame(funding_rows).iloc[:5]]:
        sparse_ranking = rank_at_cutoff(
            pd.DataFrame(kline_rows), long_b, short_b,
            cutoff_ms=boundaries.test_end_ms, df_funding=sparse_funding,
        )
        assert sparse_ranking["status"] == "OK"
        assert sparse_ranking["eligible_count"] == ranking["eligible_count"]
        json.dumps(sparse_ranking, allow_nan=False)
        for entry in sparse_ranking["all_rankings"]:
            assert "fundingRateLatest" not in entry
            assert "fundingRateZScore7d" not in entry
            assert np.isfinite(entry["rankingScore"])

    model_file = tmp_path / "models" / "lgbm_long_ranker.txt"
    model_file.write_text(model_file.read_text(encoding="utf-8") + "\n", encoding="utf-8")
    with pytest.raises(ValueError, match="hash"):
        load_lightgbm_models(tmp_path / "models")


def test_worker_jsonl_protocol_and_error_handling(tmp_path: Path):
    # Test invalid JSON request
    proc_invalid = subprocess.run(
        [sys.executable, "-m", "research.model_research.worker"],
        input="not-valid-json\n",
        text=True,
        capture_output=True,
        cwd=str(Path(__file__).resolve().parents[2]),
    )
    assert proc_invalid.returncode != 0
    out_invalid = json.loads(proc_invalid.stdout.strip().splitlines()[-1])
    assert out_invalid["event"] == "error"
    assert out_invalid["errorCode"] == "INVALID_JSON_REQUEST"

    # Test OOM simulation -> returns structured CUDA_OOM error without falling back to CPU
    proc_oom = subprocess.run(
        [sys.executable, "-m", "research.model_research.worker"],
        input=json.dumps({"action": "run", "dataDir": str(tmp_path), "_simulateFailure": "OOM"}) + "\n",
        text=True,
        capture_output=True,
        cwd=str(Path(__file__).resolve().parents[2]),
    )
    assert proc_oom.returncode == 2
    out_oom = json.loads(proc_oom.stdout.strip().splitlines()[-1])
    assert out_oom["event"] == "error"
    assert out_oom["errorCode"] == "CUDA_OOM"

    # Test missing model/data -> returns structured MODEL_OR_DATA_MISSING error
    proc_missing = subprocess.run(
        [sys.executable, "-m", "research.model_research.worker"],
        input=json.dumps({"action": "run", "dataDir": str(tmp_path)}) + "\n",
        text=True,
        capture_output=True,
        cwd=str(Path(__file__).resolve().parents[2]),
    )
    assert proc_missing.returncode == 3
    out_missing = json.loads(proc_missing.stdout.strip().splitlines()[-1])
    assert out_missing["event"] == "error"
    assert out_missing["errorCode"] == "MODEL_OR_DATA_MISSING"


def test_cli_stdout_and_warmup_gap_computation(tmp_path: Path):
    from research.model_research.data_prep import _compute_missing_1h_intervals

    # 1. Verify CLI status command prints valid JSON to stdout (not hijacked to stderr by worker import)
    proc_cli = subprocess.run(
        [sys.executable, "-m", "research.model_research.cli", "--data-dir", str(tmp_path), "status"],
        text=True,
        capture_output=True,
        cwd=str(Path(__file__).resolve().parents[2]),
    )
    assert proc_cli.returncode == 0
    assert len(proc_cli.stdout.strip()) > 0
    cli_status = json.loads(proc_cli.stdout.strip())
    assert "pythonExecutable" in cli_status and "gpuEnvironment" in cli_status

    # 2. Verify _compute_missing_1h_intervals only returns missing gap intervals not covered by local_1h_df
    t0 = 1_760_000_000_000 // ONE_HOUR_MS * ONE_HOUR_MS
    # Suppose we want [t0, t0 + 6h) and local_1h_df already has t0 + 1h, t0 + 2h, t0 + 4h
    local_df = pd.DataFrame(
        [
            {"symbol": "BTCUSDT", "open_time": t0 + 1 * ONE_HOUR_MS},
            {"symbol": "BTCUSDT", "open_time": t0 + 2 * ONE_HOUR_MS},
            {"symbol": "BTCUSDT", "open_time": t0 + 4 * ONE_HOUR_MS},
        ]
    )
    intervals = _compute_missing_1h_intervals(local_df, "BTCUSDT", t0, t0 + 6 * ONE_HOUR_MS)
    assert intervals == [
        (t0, t0 + 1 * ONE_HOUR_MS),
        (t0 + 3 * ONE_HOUR_MS, t0 + 4 * ONE_HOUR_MS),
        (t0 + 5 * ONE_HOUR_MS, t0 + 6 * ONE_HOUR_MS),
    ]

    # 3. Verify validate_and_deduplicate_1h preserves warmup bars [filter_start_ms, expected_start_ms)
    #    while auditing gaps over [expected_start_ms, expected_end_ms) and reporting 0-bar symbols
    warmup_start = t0 - 2 * ONE_HOUR_MS
    exp_start = t0
    exp_end = t0 + 2 * ONE_HOUR_MS
    raw_bars = pd.DataFrame(
        [
            {
                "symbol": "BTCUSDT",
                "open_time": warmup_start,
                "open": 100.0,
                "high": 101.0,
                "low": 99.0,
                "close": 100.5,
                "volume": 10.0,
                "quote_volume": 1005.0,
                "is_final": True,
                "source": "binance_rest_1h",
            },
            {
                "symbol": "BTCUSDT",
                "open_time": exp_start,
                "open": 100.5,
                "high": 102.0,
                "low": 100.0,
                "close": 101.0,
                "volume": 10.0,
                "quote_volume": 1010.0,
                "is_final": True,
                "source": "binance_rest_1h",
            },
        ]
    )
    cleaned, gaps = validate_and_deduplicate_1h(
        raw_bars,
        cutoff_ms=exp_end,
        expected_start_ms=exp_start,
        expected_end_ms=exp_end,
        filter_start_ms=warmup_start,
        expected_symbols=["BTCUSDT", "ZEROUSDT"],
    )
    # Warmup bar at warmup_start is preserved in cleaned
    assert warmup_start in cleaned["open_time"].to_numpy()
    # BTCUSDT is missing exp_start + 1h inside [exp_start, exp_end)
    assert len(gaps["BTCUSDT"]) == 1
    assert gaps["BTCUSDT"][0]["missing_hours"] == 1
    # ZEROUSDT has 0 rows and is reported with full 2 missing hours
    assert len(gaps["ZEROUSDT"]) == 1
    assert gaps["ZEROUSDT"][0]["missing_hours"] == 2


def _simple_hourly_rows(hours=40):
    return pd.DataFrame([
        {"symbol": "TESTUSDT", "open_time": h * ONE_HOUR_MS, "open": 100.0,
         "high": 101.0, "low": 99.0, "close": 100.0, "volume": 1.0, "quote_volume": 100.0}
        for h in range(hours)
    ])


@pytest.mark.parametrize("event_count", [None, 0, 1, 5, 6])
def test_sparse_funding_is_nan_without_invalidating_price_features(event_count):
    decision = 120 * ONE_HOUR_MS
    funding = None if event_count is None else pd.DataFrame([
        {"symbol": "TESTUSDT", "funding_time": decision - i * EIGHT_HOURS_MS,
         "funding_rate": 0.001 * (i + 1)}
        for i in range(event_count)
    ])
    features = compute_features(_simple_hourly_rows(120), cutoff_ms=decision, df_funding=funding)
    row = features.iloc[-1]
    assert row.features_valid
    funding_cols = ["funding_rate_latest", "funding_rate_zscore_7d", "funding_rate_diff",
                    "cs_rank_funding_zscore_7d"]
    if event_count is None or event_count < 6:
        assert row[funding_cols].isna().all()
    else:
        assert np.isfinite(row[funding_cols].to_numpy(dtype=float)).all()
        assert row.funding_rate_latest == pytest.approx(0.001)


def test_funding_same_minute_future_update_cannot_replace_known_settlement():
    decision = 120 * ONE_HOUR_MS
    history = pd.DataFrame([
        {"symbol": "TESTUSDT", "funding_time": decision - i * EIGHT_HOURS_MS,
         "funding_rate": 0.001 * (i + 1)}
        for i in range(6)
    ])
    future = pd.DataFrame([
        {"symbol": "TESTUSDT", "funding_time": decision + 1, "funding_rate": 0.5}
    ])
    bars = _simple_hourly_rows(122)
    expected = compute_features(bars, df_funding=history)
    with_future = compute_features(bars, df_funding=pd.concat([history, future], ignore_index=True))
    cols = ["funding_rate_latest", "funding_rate_zscore_7d", "funding_rate_diff",
            "cs_rank_funding_zscore_7d"]
    pd.testing.assert_frame_equal(
        expected.loc[expected.open_time < decision, cols],
        with_future.loc[with_future.open_time < decision, cols],
    )
    # A full dataset and a dataset filtered to the decision must yield identical features.
    at_cutoff = compute_features(bars, cutoff_ms=decision, df_funding=pd.concat([history, future]))
    np.testing.assert_allclose(
        with_future.loc[with_future.open_time == decision - ONE_HOUR_MS, cols].to_numpy(dtype=float),
        at_cutoff.iloc[-1:][cols].to_numpy(dtype=float), equal_nan=True,
    )
    # After the update is known it replaces the same-minute record, without counting twice.
    latest_rates = np.array([0.006, 0.005, 0.004, 0.003, 0.002, 0.5])
    assert with_future.iloc[-1].funding_rate_zscore_7d == pytest.approx(
        (0.5 - latest_rates.mean()) / latest_rates.std(ddof=1)
    )


def test_macro_trends_use_only_closed_hours_and_match_trailing_samples():
    bars = _simple_hourly_rows(122)
    bars["close"] = np.arange(122, dtype=float) + 100
    bars["open"] = bars["close"] - 0.5
    bars["high"] = bars["close"] + 1
    bars["low"] = bars["open"] - 1
    decision = 120 * ONE_HOUR_MS
    features = compute_features(bars, cutoff_ms=decision)
    row = features.iloc[-1]
    assert row.open_time == 119 * ONE_HOUR_MS
    closes = bars["close"].to_numpy()
    sma4 = closes[[119, 115, 111, 107, 103, 99]].mean()
    prev4 = closes[[115, 111, 107, 103, 99, 95]].mean()
    sma24 = closes[[119, 95, 71, 47]].mean()
    prev24 = closes[[95, 71, 47, 23]].mean()
    assert row.trend_4h_sma6_dist == pytest.approx(closes[119] / sma4 - 1)
    assert row.trend_4h_slope == pytest.approx(sma4 / prev4 - 1)
    assert row.trend_24h_sma4_dist == pytest.approx(closes[119] / sma24 - 1)
    assert row.trend_24h_slope == pytest.approx(sma24 / prev24 - 1)
    assert row.close_pos_24h == pytest.approx((219 - 194.5) / (220 - 194.5))
    assert row.amplitude_24h == pytest.approx((220 - 194.5) / 195.5)
    bars.loc[bars.open_time >= decision, ["open", "high", "low", "close"]] *= 100
    pd.testing.assert_frame_equal(features, compute_features(bars, cutoff_ms=decision))


def test_funding_window_lower_bound_and_invalid_records():
    decision = 240 * ONE_HOUR_MS
    start = decision - 7 * ONE_DAY_MS
    funding = pd.DataFrame([
        {"symbol": "TESTUSDT", "funding_time": t, "funding_rate": r}
        for t, r in [(start - 1, 0.9), (start, 0.001), (decision - 32 * ONE_HOUR_MS, 0.002),
                     (decision - 24 * ONE_HOUR_MS, 0.003), (decision - 16 * ONE_HOUR_MS, 0.004),
                     (decision - 8 * ONE_HOUR_MS, 0.005), (decision, 0.006),
                     (decision + 1, 0.8), (np.inf, 0.7), (decision - ONE_HOUR_MS, np.inf)]
    ])
    features = compute_features(_simple_hourly_rows(240), df_funding=funding)
    rates = np.arange(1, 7) * 0.001
    row = features.iloc[-1]
    assert row.features_valid
    assert row.funding_rate_latest == pytest.approx(rates[-1])
    assert row.funding_rate_diff == pytest.approx(rates[-1] - rates.mean())
    assert row.funding_rate_zscore_7d == pytest.approx((rates[-1] - rates.mean()) / rates.std(ddof=1))


@pytest.mark.parametrize("cadence,missing_hour,decision_hour", [(1, 11, 8), (4, 12, 8)])
def test_missing_non_eight_hour_funding_is_excluded(cadence, missing_hour, decision_hour):
    funding = pd.DataFrame([
        {"symbol": "TESTUSDT", "funding_time": h * ONE_HOUR_MS, "funding_rate": 0.001, "mark_price": 100.0}
        for h in range(0, 41, cadence) if h != missing_hour
    ])
    labels = compute_forward_labels(_simple_hourly_rows(), funding)
    row = labels[labels.open_time == decision_hour * ONE_HOUR_MS].iloc[0]
    assert row.funding_missing
    assert np.isnan(row.net_return_long) and np.isnan(row.net_return_short)


def test_funding_actual_millisecond_boundaries_and_unknown_coverage():
    funding = pd.DataFrame([
        {"symbol": "TESTUSDT", "funding_time": h * ONE_HOUR_MS + 1, "funding_rate": 0.001, "mark_price": 100.0}
        for h in range(0, 41, 8)
    ])
    labels = compute_forward_labels(_simple_hourly_rows(), funding)
    # entry=8h, exit=12h: 8h+1ms counts; entry=4h, exit=8h: 8h+1ms does not.
    assert labels.iloc[7].funding_rate_sum == pytest.approx(0.001)
    assert labels.iloc[3].funding_rate_sum == pytest.approx(0.0)
    unknown = compute_forward_labels(_simple_hourly_rows(), funding.iloc[:1])
    assert unknown.iloc[8].funding_missing  # one surrounding observation cannot prove coverage


def test_funding_cost_uses_settlement_mark_not_entry_price():
    klines = _simple_hourly_rows(41)
    funding = pd.DataFrame([{
        "symbol": "TESTUSDT", "funding_time": 12 * ONE_HOUR_MS,
        "funding_rate": 0.01, "mark_price": 120.0,
    } if h == 12 else {
        "symbol": "TESTUSDT", "funding_time": h * ONE_HOUR_MS,
        "funding_rate": 0.0, "mark_price": 100.0,
    } for h in [0, 8, 12, 16, 24, 32, 40]])
    labels = compute_forward_labels(klines, funding, fee_bps=5.0, slippage_bps=5.0)
    row = labels[labels.open_time == 7 * ONE_HOUR_MS].iloc[0]  # entry at hour 8, settlement at 12
    assert row.funding_cost_return == pytest.approx(0.01 * 120.0 / row.entry_price)
    assert row.net_return_long == pytest.approx(row.gross_return_long - 0.002 - row.funding_cost_return)


def test_funding_settlement_without_mark_price_is_excluded():
    funding = pd.DataFrame([{
        "symbol": "TESTUSDT", "funding_time": h * ONE_HOUR_MS, "funding_rate": 0.001,
        "mark_price": np.nan,
    } for h in [0, 8, 12, 16, 24, 32, 40]])
    labels = compute_forward_labels(_simple_hourly_rows(), funding)
    row = labels[labels.open_time == 7 * ONE_HOUR_MS].iloc[0]
    assert row.funding_missing
    assert np.isnan(row.net_return_long) and np.isnan(row.net_return_short)


def test_lightgbm_training_refuses_nonempty_output_dir(tmp_path: Path):
    output = tmp_path / "models"
    output.mkdir()
    original = output / "lgbm_long_ranker.txt"
    original.write_text("preserve", encoding="utf-8")
    with pytest.raises(FileExistsError, match="拒絕覆寫"):
        train_and_evaluate_lightgbm(pd.DataFrame(), output, dataset_version="test")
    assert original.read_text(encoding="utf-8") == "preserve"


def test_lightgbm_training_releases_lock_when_training_raises(tmp_path: Path, monkeypatch):
    output = tmp_path / "models"
    panel = pd.DataFrame({"group_eligible": [True, True, True], "split": ["train", "val", "test"]})
    def fail(*args, **kwargs):
        raise RuntimeError("simulated training failure")
    monkeypatch.setattr("research.model_research.lightgbm_ranker._train_single_direction", fail)
    with pytest.raises(RuntimeError, match="simulated training failure"):
        train_and_evaluate_lightgbm(panel, output, dataset_version="test")
    assert not (output / ".training.lock").exists()


def test_lightgbm_training_invalid_panel_preserves_original_error(tmp_path: Path):
    output = tmp_path / "models"
    with pytest.raises(KeyError, match="group_eligible"):
        train_and_evaluate_lightgbm(pd.DataFrame(), output, dataset_version="test")
    assert not (output / ".training.lock").exists()


def test_lightgbm_training_does_not_remove_another_owners_lock(tmp_path: Path, monkeypatch):
    output = tmp_path / "models"
    panel = pd.DataFrame({"group_eligible": [True, True, True], "split": ["train", "val", "test"]})
    lock_path = output / ".training.lock"
    original_open = Path.open

    def race_open(path, mode="r", *args, **kwargs):
        if path == lock_path and mode == "x":
            original_open(path, "w", encoding="utf-8").write("owned by another trainer")
        return original_open(path, mode, *args, **kwargs)

    monkeypatch.setattr(Path, "open", race_open)
    with pytest.raises(FileExistsError, match="訓練工作鎖"):
        train_and_evaluate_lightgbm(panel, output, dataset_version="test")
    assert lock_path.read_text(encoding="utf-8") == "owned by another trainer"


def test_offline_evaluation_never_reuses_symbol_time_only_kronos_cache(tmp_path: Path):
    # Put matching old cache files in place. A fresh evaluation must still reach a
    # model load; the sentinel proves the old cache did not bypass inference.
    import json
    import pandas as pd

    class FreshInferenceRequired(RuntimeError):
        pass

    class SentinelEngine:
        def __init__(self, *args, **kwargs):
            pass
        def load_model(self, model_key):
            raise FreshInferenceRequired("fresh model load reached")
        def unload(self):
            pass

    data_dir = tmp_path / "data"
    models_dir = tmp_path / "models"
    output_dir = tmp_path / "evaluation"
    datasets = data_dir / "model-research" / "datasets"
    for p in [datasets / "klines_1h.parquet", models_dir / "lgbm_test_predictions.parquet"]:
        p.parent.mkdir(parents=True, exist_ok=True)
        p.touch()
    (models_dir / "lgbm_metadata.json").write_text(json.dumps({"pipeline_version": 3}), encoding="utf-8")
    for name in ["kronos_single_coin_verification.json", "common_test_predictions.parquet", "offline_comparison.json"]:
        (output_dir / name).parent.mkdir(parents=True, exist_ok=True)
        (output_dir / name).touch()

    decision = (1_760_000_000_000 // ONE_DAY_MS) * ONE_DAY_MS
    rows = [{"symbol": f"C{i:02d}USDT", "open_time": decision - ONE_HOUR_MS, "decision_time": decision,
             "ret_close_4h": 0.01, "ret_4h": 0.01, "lgbm_score_long": 1.0,
             "lgbm_score_short": 0.0} for i in range(10)]
    original_read = pd.read_parquet
    def read_parquet(path, *args, **kwargs):
        if str(path).endswith("klines_1h.parquet"):
            return pd.DataFrame(rows)
        if str(path).endswith("lgbm_test_predictions.parquet"):
            return pd.DataFrame(rows)
        if str(path).endswith("common_test_predictions.parquet"):
            return pd.DataFrame(rows)
        return original_read(path, *args, **kwargs)

    offline_eval_module.pd.read_parquet = read_parquet
    offline_eval_module.validate_and_deduplicate_1h = lambda df, **kwargs: (df, {})
    offline_eval_module.extract_256_window = lambda *args, **kwargs: pd.DataFrame([{}])
    offline_eval_module.KronosInferenceEngine = SentinelEngine
    try:
        with pytest.raises(FreshInferenceRequired, match="fresh model load reached"):
            run_offline_evaluation(data_dir, models_dir, Path("unused-weights"), output_dir)
    finally:
        offline_eval_module.pd.read_parquet = original_read


def test_cli_verify_kronos_uses_existing_evaluation_directory(tmp_path: Path, monkeypatch):
    data_dir = tmp_path / "data"
    klines = data_dir / "model-research" / "datasets" / "klines_1h.parquet"
    klines.parent.mkdir(parents=True)
    klines.touch()
    captured = {}
    monkeypatch.setattr(sys, "argv", ["cli", "--data-dir", str(data_dir), "verify-kronos"])
    monkeypatch.setattr(research_cli.pd, "read_parquet", lambda *a, **k: pd.DataFrame())
    monkeypatch.setattr(research_cli, "verify_kronos_single_coin", lambda **kwargs: captured.update(kwargs) or {"status": "ok"})
    assert research_cli.main() == 0
    assert captured["output_dir"] == data_dir / "model-research" / "evaluation"


def test_cli_evaluate_honors_new_output_dir_and_preserves_existing_report(tmp_path: Path, monkeypatch):
    data_dir = tmp_path / "data"
    old_report_dir = data_dir / "model-research" / "evaluation"
    old_report_dir.mkdir(parents=True)
    sentinel = old_report_dir / "offline_comparison.json"
    sentinel.write_text("preserve", encoding="utf-8")
    new_output = tmp_path / "new-evaluation"
    captured = {}
    monkeypatch.setattr(sys, "argv", ["cli", "--data-dir", str(data_dir), "evaluate", "--output-dir", str(new_output)])
    monkeypatch.setattr(research_cli, "run_offline_evaluation", lambda **kwargs: captured.update(kwargs) or {
        "kronosForecastComparison": {}, "crossModelRankingComparison": {},
    })
    assert research_cli.main() == 0
    assert captured["output_dir"] == new_output.resolve()
    assert sentinel.read_text(encoding="utf-8") == "preserve"


def test_invalid_ohlcv_is_rejected_before_features():
    rows = _simple_hourly_rows(5)
    rows.loc[1, "high"] = np.inf
    rows.loc[2, "close"] = 102.0  # outside high/low
    rows.loc[3, "quote_volume"] = np.inf
    clean, gaps = validate_and_deduplicate_1h(rows, expected_start_ms=0, expected_end_ms=5 * ONE_HOUR_MS)
    assert clean.open_time.tolist() == [0, 4 * ONE_HOUR_MS]
    assert gaps["TESTUSDT"][0]["missing_hours"] == 3


def test_offline_common_groups_respect_budget_and_reject_empty():
    from research.model_research.offline_eval import select_common_groups
    cohort = pd.DataFrame([{"open_time": t, "symbol": f"S{i}"} for t in [0, ONE_DAY_MS] for i in range(20)])
    assert len(select_common_groups(cohort, 25)) == 20
    for frame, budget in [(cohort, 10), (cohort.iloc[:0], 600), (cohort, 0)]:
        with pytest.raises(ValueError):
            select_common_groups(frame, budget)


def test_worker_refuses_unsafe_or_existing_run_id(tmp_path):
    from research.model_research.worker import handle_run
    for unsafe in ["../datasets", "run-../datasets", "weights", "run-x/child"]:
        with pytest.raises(ValueError):
            handle_run({"dataDir": str(tmp_path), "runId": unsafe})
    existing = tmp_path / "model-research" / "run-immutable"
    existing.mkdir(parents=True)
    sentinel = existing / "result.json"
    sentinel.write_text('{"preserved": true}', encoding="utf-8")
    with pytest.raises(FileExistsError):
        handle_run({"dataDir": str(tmp_path), "runId": "run-immutable"})
    assert sentinel.read_text(encoding="utf-8") == '{"preserved": true}'


def test_worker_no_forecasts_is_insufficient_and_keeps_latest(tmp_path, monkeypatch):
    from research.model_research import worker, kronos_runner, lightgbm_ranker
    data = tmp_path / "model-research"
    datasets = data / "datasets"
    datasets.mkdir(parents=True)
    _simple_hourly_rows().to_parquet(datasets / "klines_1h.parquet")
    (datasets / "dataset_manifest.json").write_text(json.dumps({"pipelineVersion": 2}), encoding="utf-8")
    pointer = data / "latest-run.json"
    pointer.write_text('{"runId": "run-previous"}', encoding="utf-8")
    meta = {"pipeline_version": 2, "long_model": {"sha256": "x", "selected_params": {}},
            "short_model": {"sha256": "y", "selected_params": {}}}
    monkeypatch.setattr(kronos_runner, "check_kronos_installed", lambda *a: {"installed": True})
    monkeypatch.setattr(lightgbm_ranker, "load_lightgbm_models", lambda *a: (None, None, meta))
    cutoffs = []
    def rank(**kwargs):
        cutoffs.append(kwargs["cutoff_ms"])
        return {"status": "OK", "decision_open_time": 39 * ONE_HOUR_MS, "cutoff_time": 40 * ONE_HOUR_MS,
                "eligible_count": 10, "insufficient_symbols": [], "conflict_symbols": [], "long_top5": [],
                "short_top5": [], "all_rankings": [], "kronos_target_symbols": ["TESTUSDT"]}
    monkeypatch.setattr(lightgbm_ranker, "rank_at_cutoff", rank)
    monkeypatch.setattr(kronos_runner, "infer_kronos_for_candidates", lambda **kw: {
        "forecasts": {}, "modelInfo": dict.fromkeys(["repoId", "revision", "modelSha256", "tokenizerRepoId", "tokenizerRevision", "tokenizerSha256"], "test"),
        "targetSymbols": ["TESTUSDT"], "totalElapsedMs": 0, "peakVramAllocatedMb": 0,
        "peakVramReservedMb": 0, "gpuEnv": {}, "skippedSymbols": [{"symbol": "TESTUSDT", "reason": "gap"}],
    })
    result = worker.handle_run({"dataDir": str(tmp_path), "runId": "run-insufficient"})
    assert isinstance(cutoffs[0], int)  # default cutoff excludes future/unclosed candles
    assert result["status"] == "INSUFFICIENT_DATA"
    assert json.loads(pointer.read_text(encoding="utf-8"))["runId"] == "run-previous"
    assert (data / "run-insufficient" / "manifest.json").exists()


def test_empty_download_produces_full_gap_report(tmp_path, monkeypatch):
    from research.model_research import data_prep
    monkeypatch.setattr(data_prep, "select_or_load_universe", lambda **kw: {
        "symbols": ["EMPTYUSDT"], "selectedAtIso": "2026-11-09T00:00:00+00:00",
    })
    monkeypatch.setattr(data_prep, "fetch_binance_1h_klines_for_symbol", lambda *a, **kw: pd.DataFrame())
    monkeypatch.setattr(data_prep, "fetch_binance_funding_rates_for_symbol", lambda *a, **kw: pd.DataFrame())
    manifest = data_prep.prepare_research_dataset(tmp_path, end_utc_ms=200 * ONE_DAY_MS)
    assert manifest["pipelineVersion"] == 3
    assert manifest["symbolQuality"][0]["missingHours"] == 4320
    assert manifest["splitSummary"]["train"]["eligibleRankingHours"] == 0
    assert (tmp_path / "model-research/datasets/data_quality_report.md").exists()

