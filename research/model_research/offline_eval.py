"""
Offline verification and fair comparison between LightGBM, Kronos-small, Kronos-base,
and baselines (No-Change, 4h Momentum) on the test split's daily UTC 00:00 common points.
"""

from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.metrics import ndcg_score

from .features_and_labels import MIN_ELIGIBLE_SYMBOLS_PER_GROUP, ONE_DAY_MS, ONE_HOUR_MS, validate_and_deduplicate_1h
from .kronos_runner import (
    KRONOS_INFERENCE_CONFIG,
    KronosInferenceEngine,
    extract_256_window,
    get_gpu_environment_info,
)

PRETRAIN_OVERLAP_DISCLAIMER = (
    "Kronos 官方預訓練權重之訓練資料截止時間與幣種重疊情況未知，"
    "本報告保留此限制，不宣稱此評估為完全獨立的樣本外驗證（Out-of-Sample Validation）。"
)
COST_ASSUMPTION_DISCLAIMER = (
    "成本假設為 1 倍槓桿、單邊手續費 5 bps、單邊不利滑價 5 bps（雙邊合計 20 bps），"
    "資金費按持有期間（4 小時）實際結算及多空方向計算；此為研究假設，不代表實際帳戶費率。"
)


def _compute_group_ndcg(grades: np.ndarray, scores: np.ndarray, k: int = 5) -> float:
    if len(grades) < 2:
        return 0.0
    if np.all(grades == grades[0]):
        return 1.0
    return float(ndcg_score(grades.reshape(1, -1), scores.reshape(1, -1), k=min(k, len(grades))))


def _to_5_grades(values: np.ndarray) -> np.ndarray:
    s = pd.Series(values)
    n = len(s)
    ranks = s.rank(method="average", ascending=True) - 1.0
    return np.floor((ranks / max(n, 1)) * 5.0).clip(0, 4).to_numpy(dtype=np.float64)


def verify_kronos_single_coin(
    df_1h: pd.DataFrame,
    weights_root: Path,
    output_dir: Path,
    symbol: str = "BTCUSDT",
    cutoff_ms: int | None = None,
) -> dict[str, Any]:
    """
    Execute real single-coin inference on `Kronos-small` first; only after `small` passes
    verification does `Kronos-base` execute on the exact same symbol, cutoff time, 256-bar window,
    sample_count=5, and seed=42.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    clean_1h, _ = validate_and_deduplicate_1h(df_1h, cutoff_ms=cutoff_ms)
    sym_df = clean_1h[clean_1h["symbol"] == symbol].sort_values("open_time")
    if sym_df.empty:
        available_syms = sorted(clean_1h["symbol"].unique().tolist())
        if not available_syms:
            raise ValueError("No valid 1h klines available for single-coin Kronos verification")
        symbol = available_syms[0]
        sym_df = clean_1h[clean_1h["symbol"] == symbol].sort_values("open_time")

    decision_open_time = int(sym_df["open_time"].iloc[-1])
    window_df = extract_256_window(clean_1h, symbol, decision_open_time, lookback=KRONOS_INFERENCE_CONFIG["lookback"])
    if window_df is None:
        raise ValueError(f"Cannot extract 256 consecutive 1h bars for {symbol} at {decision_open_time}")

    gpu_env = get_gpu_environment_info()
    engine = KronosInferenceEngine(weights_root=weights_root, require_cuda=True)

    # Step 1: Verify Kronos-small first
    try:
        t0 = time.perf_counter()
        small_info = engine.load_model("small")
        small_load_ms = round((time.perf_counter() - t0) * 1000.0, 2)
        small_pred = engine.predict_single_window(window_df, symbol=symbol)
    finally:
        engine.unload()

    if len(small_pred.get("predictedCandles", [])) != 4:
        raise RuntimeError("Kronos-small single-coin verification failed to produce 4 forecast candles")

    # Step 2: Only after small passes, verify Kronos-base with identical input and settings
    try:
        t1 = time.perf_counter()
        base_info = engine.load_model("base")
        base_load_ms = round((time.perf_counter() - t1) * 1000.0, 2)
        base_pred = engine.predict_single_window(window_df, symbol=symbol)
    finally:
        engine.unload()

    if len(base_pred.get("predictedCandles", [])) != 4:
        raise RuntimeError("Kronos-base single-coin verification failed to produce 4 forecast candles")

    verification_doc = {
        "verifiedAt": int(time.time() * 1000),
        "verifiedAtIso": datetime.now(tz=timezone.utc).isoformat(),
        "symbol": symbol,
        "decisionOpenTime": decision_open_time,
        "cutoffTime": decision_open_time + ONE_HOUR_MS,
        "gpuEnvironment": gpu_env,
        "inferenceConfig": KRONOS_INFERENCE_CONFIG,
        "small": {
            "passed": True,
            "modelInfo": small_info,
            "loadElapsedMs": small_load_ms,
            "inferenceElapsedMs": small_pred["elapsedMs"],
            "peakVramAllocatedMb": small_pred["peakVramAllocatedMb"],
            "peakVramReservedMb": small_pred["peakVramReservedMb"],
            "predictedClose4h": small_pred["predictedClose4h"],
            "predictedReturn4h": small_pred["predictedReturn4h"],
            "predictedCandles": small_pred["predictedCandles"],
        },
        "base": {
            "passed": True,
            "modelInfo": base_info,
            "loadElapsedMs": base_load_ms,
            "inferenceElapsedMs": base_pred["elapsedMs"],
            "peakVramAllocatedMb": base_pred["peakVramAllocatedMb"],
            "peakVramReservedMb": base_pred["peakVramReservedMb"],
            "predictedClose4h": base_pred["predictedClose4h"],
            "predictedReturn4h": base_pred["predictedReturn4h"],
            "predictedCandles": base_pred["predictedCandles"],
        },
    }

    out_path = output_dir / "kronos_single_coin_verification.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(verification_doc, f, ensure_ascii=False, indent=2)
    return verification_doc


def evaluate_cross_model_ranking_on_common_set(
    common_df: pd.DataFrame,
    score_long_col: str,
    score_short_col: str,
    top_k: int = 5,
) -> dict[str, Any]:
    """
    Evaluate ranking quality on the exact same common (open_time, symbol) set
    using both future 4th-candle close return (`ret_close_4h`) and net return after costs (`net_return_long/short`).
    Never computes return MAE on LightGBM ranking scores.
    """
    ic_close_long: list[float] = []
    ic_net_long: list[float] = []
    ic_net_short: list[float] = []
    ndcg_close_long: list[float] = []
    ndcg_close_short: list[float] = []
    ndcg_net_long: list[float] = []
    ndcg_net_short: list[float] = []

    top5_long_close_rets: list[float] = []
    top5_short_close_rets: list[float] = []
    top5_long_net_rets: list[float] = []
    top5_short_net_rets: list[float] = []
    top5_long_pos_rates: list[float] = []
    top5_short_pos_rates: list[float] = []

    for _, grp in common_df.groupby("open_time", sort=True):
        if len(grp) < MIN_ELIGIBLE_SYMBOLS_PER_GROUP:
            continue

        sc_l = grp[score_long_col].to_numpy(dtype=np.float64)
        sc_s = grp[score_short_col].to_numpy(dtype=np.float64)
        ret_c_l = grp["ret_close_4h"].to_numpy(dtype=np.float64)
        ret_c_s = -ret_c_l
        ret_net_l = grp["net_return_long"].to_numpy(dtype=np.float64)
        ret_net_s = grp["net_return_short"].to_numpy(dtype=np.float64)

        grades_c_l = _to_5_grades(ret_c_l)
        grades_c_s = _to_5_grades(ret_c_s)
        grades_n_l = _to_5_grades(ret_net_l)
        grades_n_s = _to_5_grades(ret_net_s)

        ndcg_close_long.append(_compute_group_ndcg(grades_c_l, sc_l, k=top_k))
        ndcg_close_short.append(_compute_group_ndcg(grades_c_s, sc_s, k=top_k))
        ndcg_net_long.append(_compute_group_ndcg(grades_n_l, sc_l, k=top_k))
        ndcg_net_short.append(_compute_group_ndcg(grades_n_s, sc_s, k=top_k))

        if np.std(sc_l) > 0 and np.std(ret_c_l) > 0:
            ic_c, _ = spearmanr(sc_l, ret_c_l)
            if np.isfinite(ic_c):
                ic_close_long.append(float(ic_c))
        else:
            ic_close_long.append(0.0)

        if np.std(sc_l) > 0 and np.std(ret_net_l) > 0:
            ic_nl, _ = spearmanr(sc_l, ret_net_l)
            if np.isfinite(ic_nl):
                ic_net_long.append(float(ic_nl))
        else:
            ic_net_long.append(0.0)

        if np.std(sc_s) > 0 and np.std(ret_net_s) > 0:
            ic_ns, _ = spearmanr(sc_s, ret_net_s)
            if np.isfinite(ic_ns):
                ic_net_short.append(float(ic_ns))
        else:
            ic_net_short.append(0.0)

        top_l = grp.sort_values([score_long_col, "symbol"], ascending=[False, True]).head(top_k)
        top_s = grp.sort_values([score_short_col, "symbol"], ascending=[False, True]).head(top_k)

        top5_long_close_rets.append(float(np.mean(top_l["ret_close_4h"].to_numpy(dtype=np.float64))))
        top5_short_close_rets.append(float(np.mean(-top_s["ret_close_4h"].to_numpy(dtype=np.float64))))

        nl = top_l["net_return_long"].to_numpy(dtype=np.float64)
        ns = top_s["net_return_short"].to_numpy(dtype=np.float64)
        top5_long_net_rets.append(float(np.mean(nl)))
        top5_short_net_rets.append(float(np.mean(ns)))
        top5_long_pos_rates.append(float(np.mean(nl > 0.0)))
        top5_short_pos_rates.append(float(np.mean(ns > 0.0)))

    return {
        "groupCount": len(ndcg_close_long),
        "sampleCount": int(len(common_df)),
        "spearmanIcClose4h": float(np.mean(ic_close_long)) if ic_close_long else 0.0,
        "long": {
            "ndcgAt5Close4h": float(np.mean(ndcg_close_long)) if ndcg_close_long else 0.0,
            "ndcgAt5NetReturn": float(np.mean(ndcg_net_long)) if ndcg_net_long else 0.0,
            "spearmanIcNetReturn": float(np.mean(ic_net_long)) if ic_net_long else 0.0,
            "top5MeanCloseReturn4h": float(np.mean(top5_long_close_rets)) if top5_long_close_rets else 0.0,
            "top5MeanNetReturn": float(np.mean(top5_long_net_rets)) if top5_long_net_rets else 0.0,
            "top5PositiveNetRate": float(np.mean(top5_long_pos_rates)) if top5_long_pos_rates else 0.0,
        },
        "short": {
            "ndcgAt5Close4h": float(np.mean(ndcg_close_short)) if ndcg_close_short else 0.0,
            "ndcgAt5NetReturn": float(np.mean(ndcg_net_short)) if ndcg_net_short else 0.0,
            "spearmanIcNetReturn": float(np.mean(ic_net_short)) if ic_net_short else 0.0,
            "top5MeanCloseReturn4h": float(np.mean(top5_short_close_rets)) if top5_short_close_rets else 0.0,
            "top5MeanNetReturn": float(np.mean(top5_short_net_rets)) if top5_short_net_rets else 0.0,
            "top5PositiveNetRate": float(np.mean(top5_short_pos_rates)) if top5_short_pos_rates else 0.0,
        },
    }


def compute_forecast_accuracy_metrics(
    actual_ret_4h: np.ndarray,
    pred_ret_4h: np.ndarray,
) -> dict[str, float]:
    """
    Compute future 4th-candle close return MAE and directional hit rate.
    """
    mae = float(np.mean(np.abs(pred_ret_4h - actual_ret_4h)))
    # Directional hit rate: exact sign match on non-zero actual returns
    non_zero = actual_ret_4h != 0.0
    if np.any(non_zero):
        actual_sign = np.sign(actual_ret_4h[non_zero])
        pred_sign = np.sign(pred_ret_4h[non_zero])
        hit_rate = float(np.mean(actual_sign == pred_sign))
    else:
        hit_rate = 0.0
    return {
        "mae4hReturn": mae,
        "directionalHitRate": hit_rate,
    }


def select_common_groups(common_df: pd.DataFrame, max_pairs: int) -> pd.DataFrame:
    """Keep complete UTC groups, never exceed the requested inference budget."""
    if max_pairs < MIN_ELIGIBLE_SYMBOLS_PER_GROUP:
        raise ValueError("max_pairs 至少需 10，才能保留完整排名群組")
    kept = []
    count = 0
    for _, group in common_df.groupby("open_time", sort=True):
        if len(group) < MIN_ELIGIBLE_SYMBOLS_PER_GROUP:
            continue
        if count + len(group) > max_pairs:
            break
        kept.append(group)
        count += len(group)
    if not kept:
        raise ValueError("沒有符合 UTC 00:00、256 根連續 K 線及至少 10 幣的完整共同群組，或 max_pairs 太小")
    return pd.concat(kept).sort_values(["open_time", "symbol"]).reset_index(drop=True)


def run_offline_evaluation(
    data_dir: Path,
    models_dir: Path,
    weights_root: Path,
    output_dir: Path,
    max_pairs: int = 600,
) -> dict[str, Any]:
    """
    Run the complete offline evaluation:
    1. Verify single-coin Kronos-small first, then Kronos-base.
    2. Select common valid daily UTC 00:00 decision points in the test period (up to `max_pairs` = 600).
    3. Run Kronos-small on all common pairs, then unload and run Kronos-base on the exact same pairs.
    4. Compare Kronos-small and Kronos-base against No-Change and 4h-Momentum baselines on 4h close return MAE & directional hit rate.
    5. Compare LightGBM, Kronos-small, Kronos-base, and 4h-Momentum on cross-sectional ranking metrics (using identical timestamps & symbols).
    6. Write JSON, CSV, and Markdown comparison reports.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    datasets_dir = data_dir / "model-research" / "datasets"
    klines_df = pd.read_parquet(datasets_dir / "klines_1h.parquet")
    lgbm_test_df = pd.read_parquet(models_dir / "lgbm_test_predictions.parquet")
    with open(models_dir / "lgbm_metadata.json", "r", encoding="utf-8") as f:
        lgbm_meta = json.load(f)
    if lgbm_meta.get("pipeline_version", 1) < 3:
        raise ValueError("拒絕將第一輪舊版模型重新評估為修正後結果；請使用新資料目錄的 v2 模型")

    # 2. Identify daily UTC 00:00 decision points in test set
    # Decision at UTC 00:00 corresponds to the candle [23:00, 00:00) where decision_time % ONE_DAY_MS == 0
    daily_test = lgbm_test_df[lgbm_test_df["decision_time"] % ONE_DAY_MS == 0].copy()

    clean_1h, _ = validate_and_deduplicate_1h(klines_df)

    # Pre-check which (symbol, open_time) have a valid contiguous 256-bar window
    valid_indices: list[int] = []
    windows_cache: dict[tuple[str, int], pd.DataFrame] = {}
    for idx, row in daily_test.iterrows():
        sym = str(row["symbol"])
        open_t = int(row["open_time"])
        wdf = extract_256_window(clean_1h, sym, open_t, lookback=KRONOS_INFERENCE_CONFIG["lookback"])
        if wdf is not None:
            valid_indices.append(int(idx))
            windows_cache[(sym, open_t)] = wdf

    common_df = daily_test.loc[valid_indices].copy()
    # Keep only decision timestamps with >= MIN_ELIGIBLE_SYMBOLS_PER_GROUP (10) valid symbols
    grp_sizes = common_df.groupby("open_time")["symbol"].transform("count")
    common_df = common_df[grp_sizes >= MIN_ELIGIBLE_SYMBOLS_PER_GROUP].sort_values(["open_time", "symbol"]).reset_index(drop=True)

    common_df = select_common_groups(common_df, max_pairs)

    # Reject empty/budget-ineligible cohorts before starting any GPU inference.

    # Never reuse cached forecasts: keys based only on symbol/time can silently pair old
    # predictions with revised OHLCV, weights, or inference settings.
    single_coin_verif = verify_kronos_single_coin(
        df_1h=klines_df, weights_root=weights_root, output_dir=output_dir, symbol="BTCUSDT",
    )

    # 3. Run Kronos-small across all common pairs
    engine = KronosInferenceEngine(weights_root=weights_root, require_cuda=True)
    small_preds_ret = []
    small_preds_close = []
    small_elapsed_list: list[float] = []
    small_peak_alloc = 0.0
    small_peak_reserved = 0.0

    t_small_start = time.perf_counter()
    try:
        small_info = engine.load_model("small")
        for _, row in common_df.iterrows():
            sym = str(row["symbol"])
            open_t = int(row["open_time"])
            wdf = windows_cache[(sym, open_t)]
            res = engine.predict_single_window(wdf, symbol=sym, history_display_bars=8)
            small_preds_ret.append(float(res["predictedReturn4h"]))
            small_preds_close.append(float(res["predictedClose4h"]))
            small_elapsed_list.append(float(res["elapsedMs"]))
            small_peak_alloc = max(small_peak_alloc, float(res["peakVramAllocatedMb"]))
            small_peak_reserved = max(small_peak_reserved, float(res["peakVramReservedMb"]))
    finally:
        engine.unload()
    small_total_ms = round((time.perf_counter() - t_small_start) * 1000.0, 2)
    small_avg_ms = round(float(np.mean(small_elapsed_list)), 2) if small_elapsed_list else 0.0

    # 4. Run Kronos-base across the exact same common pairs
    base_preds_ret = []
    base_preds_close = []
    base_elapsed_list: list[float] = []
    base_peak_alloc = 0.0
    base_peak_reserved = 0.0

    t_base_start = time.perf_counter()
    try:
        base_info = engine.load_model("base")
        for _, row in common_df.iterrows():
            sym = str(row["symbol"])
            open_t = int(row["open_time"])
            wdf = windows_cache[(sym, open_t)]
            res = engine.predict_single_window(wdf, symbol=sym, history_display_bars=8)
            base_preds_ret.append(float(res["predictedReturn4h"]))
            base_preds_close.append(float(res["predictedClose4h"]))
            base_elapsed_list.append(float(res["elapsedMs"]))
            base_peak_alloc = max(base_peak_alloc, float(res["peakVramAllocatedMb"]))
            base_peak_reserved = max(base_peak_reserved, float(res["peakVramReservedMb"]))
    finally:
        engine.unload()
    base_total_ms = round((time.perf_counter() - t_base_start) * 1000.0, 2)
    base_avg_ms = round(float(np.mean(base_elapsed_list)), 2) if base_elapsed_list else 0.0

    common_df["kronos_small_pred_ret_4h"] = small_preds_ret
    common_df["kronos_small_pred_close_4h"] = small_preds_close
    common_df["kronos_small_short_score"] = -common_df["kronos_small_pred_ret_4h"]
    
    common_df["kronos_base_pred_ret_4h"] = base_preds_ret
    common_df["kronos_base_pred_close_4h"] = base_preds_close
    common_df["kronos_base_short_score"] = -common_df["kronos_base_pred_ret_4h"]
    
    common_df["baseline_no_change_ret_4h"] = 0.0
    common_df["baseline_momentum_ret_4h"] = common_df["ret_4h"]
    common_df["baseline_momentum_short_score"] = -common_df["ret_4h"]
    
    common_df.to_parquet(output_dir / "common_test_predictions.parquet", index=False)
    
    actual_ret = common_df["ret_close_4h"].to_numpy(dtype=np.float64)
    kronos_forecast_comparison = {
        "samplePairCount": int(len(common_df)),
        "decisionTimestampCount": int(common_df["open_time"].nunique()),
        "symbolCount": int(common_df["symbol"].nunique()),
        "kronosSmall": {
            "modelKey": "small",
            "repoId": small_info.get("repoId"),
            "revision": small_info.get("revision"),
            **compute_forecast_accuracy_metrics(actual_ret, common_df["kronos_small_pred_ret_4h"].to_numpy(dtype=np.float64)),
            "totalElapsedMs": small_total_ms,
            "avgSampleElapsedMs": small_avg_ms,
            "peakVramAllocatedMb": small_peak_alloc,
            "peakVramReservedMb": small_peak_reserved,
        },
        "kronosBase": {
            "modelKey": "base",
            "repoId": base_info.get("repoId"),
            "revision": base_info.get("revision"),
            **compute_forecast_accuracy_metrics(actual_ret, common_df["kronos_base_pred_ret_4h"].to_numpy(dtype=np.float64)),
            "totalElapsedMs": base_total_ms,
            "avgSampleElapsedMs": base_avg_ms,
            "peakVramAllocatedMb": base_peak_alloc,
            "peakVramReservedMb": base_peak_reserved,
        },
        "baselineNoChange": {
            "modelKey": "no_change",
            **compute_forecast_accuracy_metrics(actual_ret, common_df["baseline_no_change_ret_4h"].to_numpy(dtype=np.float64)),
        },
        "baselineMomentum4h": {
            "modelKey": "momentum_4h",
            **compute_forecast_accuracy_metrics(actual_ret, common_df["baseline_momentum_ret_4h"].to_numpy(dtype=np.float64)),
        },
    }
    
    cross_model_ranking = {
        "commonTimestampCount": int(common_df["open_time"].nunique()),
        "commonPairCount": int(len(common_df)),
        "lightgbm": evaluate_cross_model_ranking_on_common_set(
            common_df, "lgbm_score_long", "lgbm_score_short", top_k=5
        ),
        "kronosSmall": evaluate_cross_model_ranking_on_common_set(
            common_df, "kronos_small_pred_ret_4h", "kronos_small_short_score", top_k=5
        ),
        "kronosBase": evaluate_cross_model_ranking_on_common_set(
            common_df, "kronos_base_pred_ret_4h", "kronos_base_short_score", top_k=5
        ),
        "baselineMomentum4h": evaluate_cross_model_ranking_on_common_set(
            common_df, "baseline_momentum_ret_4h", "baseline_momentum_short_score", top_k=5
        ),
    }
    
    report_doc = {
        "generatedAt": int(time.time() * 1000),
        "generatedAtIso": datetime.now(tz=timezone.utc).isoformat(),
        "gpuEnvironment": get_gpu_environment_info(),
        "singleCoinVerification": single_coin_verif,
        "lightgbmFullTestMetrics": lgbm_meta.get("test_metrics", {}),
        "lightgbmValidationMetrics": lgbm_meta.get("validation_metrics", {}),
        "kronosForecastComparison": kronos_forecast_comparison,
        "crossModelRankingComparison": cross_model_ranking,
        "disclaimers": {
            "pretrainOverlap": PRETRAIN_OVERLAP_DISCLAIMER,
            "costAssumption": COST_ASSUMPTION_DISCLAIMER,
            "lgbmScoreMeaning": "LightGBM 分數為相對排名分數（Ranking Score），不計算報酬 MAE，亦不得轉稱勝率或預期報酬。",
            "noEquityCurve": "第一版不產生模擬帳戶淨值曲線，避免將重疊的 4 小時研究樣本誤當成可直接累積的交易績效。",
        },
    }

    with open(output_dir / "offline_comparison.json", "w", encoding="utf-8") as f:
        json.dump(report_doc, f, ensure_ascii=False, indent=2)

    # Save flat CSV comparison table
    csv_rows: list[dict[str, Any]] = []
    for key, label, f_metrics, r_metrics in [
        ("lightgbm", "LightGBM Ranker (CPU)", None, cross_model_ranking["lightgbm"]),
        ("kronos_small", "Kronos-small (24.7M)", kronos_forecast_comparison["kronosSmall"], cross_model_ranking["kronosSmall"]),
        ("kronos_base", "Kronos-base (102.3M)", kronos_forecast_comparison["kronosBase"], cross_model_ranking["kronosBase"]),
        ("momentum_4h", "過去 4h 動能基準", kronos_forecast_comparison["baselineMomentum4h"], cross_model_ranking["baselineMomentum4h"]),
        ("no_change", "價格不變基準 (0 報酬)", kronos_forecast_comparison["baselineNoChange"], None),
    ]:
        row_dict: dict[str, Any] = {
            "model_key": key,
            "model_label": label,
            "common_pairs": int(len(common_df)),
            "common_timestamps": int(common_df["open_time"].nunique()),
            "mae_4h_close_return": f_metrics["mae4hReturn"] if f_metrics else np.nan,
            "directional_hit_rate": f_metrics["directionalHitRate"] if f_metrics else np.nan,
            "total_elapsed_ms": f_metrics.get("totalElapsedMs", np.nan) if f_metrics else np.nan,
            "avg_sample_elapsed_ms": f_metrics.get("avgSampleElapsedMs", np.nan) if f_metrics else np.nan,
            "peak_vram_allocated_mb": f_metrics.get("peakVramAllocatedMb", np.nan) if f_metrics else np.nan,
            "peak_vram_reserved_mb": f_metrics.get("peakVramReservedMb", np.nan) if f_metrics else np.nan,
            "spearman_ic_close_4h": r_metrics["spearmanIcClose4h"] if r_metrics else np.nan,
            "long_ndcg_at_5_net": r_metrics["long"]["ndcgAt5NetReturn"] if r_metrics else np.nan,
            "long_spearman_ic_net": r_metrics["long"]["spearmanIcNetReturn"] if r_metrics else np.nan,
            "long_top5_mean_net_return": r_metrics["long"]["top5MeanNetReturn"] if r_metrics else np.nan,
            "long_top5_positive_net_rate": r_metrics["long"]["top5PositiveNetRate"] if r_metrics else np.nan,
            "short_ndcg_at_5_net": r_metrics["short"]["ndcgAt5NetReturn"] if r_metrics else np.nan,
            "short_spearman_ic_net": r_metrics["short"]["spearmanIcNetReturn"] if r_metrics else np.nan,
            "short_top5_mean_net_return": r_metrics["short"]["top5MeanNetReturn"] if r_metrics else np.nan,
            "short_top5_positive_net_rate": r_metrics["short"]["top5PositiveNetRate"] if r_metrics else np.nan,
        }
        csv_rows.append(row_dict)

    pd.DataFrame(csv_rows).to_csv(output_dir / "offline_comparison.csv", index=False, encoding="utf-8")

    # Write Markdown report
    lgbm_full = lgbm_meta.get("test_metrics", {})
    ks = kronos_forecast_comparison["kronosSmall"]
    kb = kronos_forecast_comparison["kronosBase"]
    bno = kronos_forecast_comparison["baselineNoChange"]
    bmom = kronos_forecast_comparison["baselineMomentum4h"]

    md = [
        "# LightGBM 選幣排名與 Kronos-small / Kronos-base 離線公平比較報告",
        "",
        f"- **產生時間 (UTC)**：`{report_doc['generatedAtIso']}`",
        f"- **硬體環境**：`{report_doc['gpuEnvironment'].get('gpuName')}`（總顯存 `{report_doc['gpuEnvironment'].get('totalVramMb')} MiB`, PyTorch `{report_doc['gpuEnvironment'].get('torchVersion')}`）",
        f"- **共同比較樣本**：測試集（30 天）每日 UTC 00:00 共同有效時間點，共 `{cross_model_ranking['commonTimestampCount']}` 個時點、`{cross_model_ranking['commonPairCount']}` 筆標的／時點組合",
        "",
        "## 1. Kronos 單幣實際推論驗證（先 small 後 base）",
        "",
        "| 模型 | Revision | 單幣標的 | 權重載入耗時 (ms) | 單幣推論耗時 (ms) | 峰值分配顯存 (MiB) | 峰值保留顯存 (MiB) | 預測 4h 收盤報酬 |",
        "|---|---|---|---:|---:|---:|---:|---:|",
        f"| Kronos-small | `{single_coin_verif['small']['modelInfo'].get('revision', '')[:12]}` | {single_coin_verif['symbol']} | "
        f"{single_coin_verif['small']['loadElapsedMs']:.1f} | {single_coin_verif['small']['inferenceElapsedMs']:.1f} | "
        f"{single_coin_verif['small']['peakVramAllocatedMb']:.2f} | {single_coin_verif['small']['peakVramReservedMb']:.2f} | "
        f"{single_coin_verif['small']['predictedReturn4h']*100:.3f}% |",
        f"| Kronos-base | `{single_coin_verif['base']['modelInfo'].get('revision', '')[:12]}` | {single_coin_verif['symbol']} | "
        f"{single_coin_verif['base']['loadElapsedMs']:.1f} | {single_coin_verif['base']['inferenceElapsedMs']:.1f} | "
        f"{single_coin_verif['base']['peakVramAllocatedMb']:.2f} | {single_coin_verif['base']['peakVramReservedMb']:.2f} | "
        f"{single_coin_verif['base']['predictedReturn4h']*100:.3f}% |",
        "",
        "## 2. Kronos 未來第 4 根收盤報酬預測誤差與基準比較",
        "",
        "> LightGBM 輸出為相對排名分數（Ranking Score），依規範不計算報酬 MAE。",
        "",
        "| 模型／基準 | 樣本數 | 未來第 4 根收盤報酬 MAE | 方向命中率 | 總耗時 (ms) | 單筆平均耗時 (ms) | 峰值分配顯存 (MiB) | 峰值保留顯存 (MiB) |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
        f"| Kronos-small | {ks['samplePairCount'] if 'samplePairCount' in ks else len(common_df)} | {ks['mae4hReturn']:.6f} | {ks['directionalHitRate']*100:.2f}% | {ks['totalElapsedMs']:.1f} | {ks['avgSampleElapsedMs']:.1f} | {ks['peakVramAllocatedMb']:.2f} | {ks['peakVramReservedMb']:.2f} |",
        f"| Kronos-base | {len(common_df)} | {kb['mae4hReturn']:.6f} | {kb['directionalHitRate']*100:.2f}% | {kb['totalElapsedMs']:.1f} | {kb['avgSampleElapsedMs']:.1f} | {kb['peakVramAllocatedMb']:.2f} | {kb['peakVramReservedMb']:.2f} |",
        f"| 價格不變基準 (0 報酬) | {len(common_df)} | {bno['mae4hReturn']:.6f} | {bno['directionalHitRate']*100:.2f}% | - | - | - | - |",
        f"| 過去 4 小時動能基準 | {len(common_df)} | {bmom['mae4hReturn']:.6f} | {bmom['directionalHitRate']*100:.2f}% | - | - | - | - |",
        "",
        "## 3. 跨模型同時間同標的排名比較（測試集每日 UTC 00:00 共同時點）",
        "",
        "| 模型 | 共同時點數 | 未來4h收盤 Spearman IC | 多頭 NDCG@5 | 多頭 Top5 平均淨報酬 | 多頭 Top5 正淨報酬率 | 空頭 NDCG@5 | 空頭 Top5 平均淨報酬 | 空頭 Top5 正淨報酬率 |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]

    for label, r_m in [
        ("LightGBM Ranker", cross_model_ranking["lightgbm"]),
        ("Kronos-small", cross_model_ranking["kronosSmall"]),
        ("Kronos-base", cross_model_ranking["kronosBase"]),
        ("過去 4h 動能基準", cross_model_ranking["baselineMomentum4h"]),
    ]:
        md.append(
            f"| {label} | {r_m['groupCount']} | {r_m['spearmanIcClose4h']:.4f} | "
            f"{r_m['long']['ndcgAt5NetReturn']:.4f} | {r_m['long']['top5MeanNetReturn']*100:.3f}% | {r_m['long']['top5PositiveNetRate']*100:.2f}% | "
            f"{r_m['short']['ndcgAt5NetReturn']:.4f} | {r_m['short']['top5MeanNetReturn']*100:.3f}% | {r_m['short']['top5PositiveNetRate']*100:.2f}% |"
        )

    if lgbm_full:
        md.extend(
            [
                "",
                "## 4. LightGBM 完整 30 天測試集（逐小時排名）評估指標",
                "",
                f"- **合格排名小時數**：`{lgbm_full.get('group_count', 0)}` 小時（共 `{lgbm_full.get('row_count', 0)}` 筆標的／時點）",
                f"- **缺資金費排除比例**：`{lgbm_full.get('funding_missing_ratio', 0.0)*100:.2f}%`（共 `{lgbm_full.get('funding_missing_count', 0)}` 筆，不當作零成本，已排除於淨績效）",
                f"- **多頭榜 (Long LGBMRanker)**：NDCG@5 = `{lgbm_full.get('long', {}).get('ndcg_at_5', 0.0):.4f}`, Spearman IC = `{lgbm_full.get('long', {}).get('spearman_ic', 0.0):.4f}`, Top 5 平均淨報酬 = `{lgbm_full.get('long', {}).get('top5_mean_net_return', 0.0)*100:.3f}%`, Top 5 正淨報酬比例 = `{lgbm_full.get('long', {}).get('top5_positive_rate', 0.0)*100:.2f}%`",
                f"- **空頭榜 (Short LGBMRanker)**：NDCG@5 = `{lgbm_full.get('short', {}).get('ndcg_at_5', 0.0):.4f}`, Spearman IC = `{lgbm_full.get('short', {}).get('spearman_ic', 0.0):.4f}`, Top 5 平均淨報酬 = `{lgbm_full.get('short', {}).get('top5_mean_net_return', 0.0)*100:.3f}%`, Top 5 正淨報酬比例 = `{lgbm_full.get('short', {}).get('top5_positive_rate', 0.0)*100:.2f}%`",
            ]
        )

    md.extend(
        [
            "",
            "## 5. 研究限制與方法聲明",
            "",
            f"1. **預訓練資料重疊限制**：{PRETRAIN_OVERLAP_DISCLAIMER}",
            f"2. **交易成本與資金費假設**：{COST_ASSUMPTION_DISCLAIMER}",
            "3. **不產生模擬帳戶淨值曲線**：第一版不將重疊的 4 小時研究樣本直接累加為模擬帳戶資金曲線，避免誇大可實現績效。",
            "4. **研究用途聲明**：本模組僅供選幣排名與預測研究比較，即使部分指標未優於基準亦如實呈現，不自動升級為交易訊號或接入下單。",
        ]
    )

    with open(output_dir / "offline_comparison_report.md", "w", encoding="utf-8") as f:
        f.write("\n".join(md) + "\n")

    return report_doc
