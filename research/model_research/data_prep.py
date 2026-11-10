"""
Binance USDT-M Perpetual universe selection, local 1m Parquet inventory & UTC 1h aggregation,
official 1h kline & funding rate historical backfill, gap audit, and dataset manifest generation.
Strictly reads/writes research Parquet files without opening the live Collector DuckDB.
"""

from __future__ import annotations

import hashlib
import json
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import requests

from .features_and_labels import (
    EIGHT_HOURS_MS,
    MIN_ELIGIBLE_SYMBOLS_PER_GROUP,
    ONE_DAY_MS,
    ONE_HOUR_MS,
    TimeSplitBoundaries,
    aggregate_1m_to_1h_utc,
    build_research_panel,
    compute_time_split_boundaries,
    last_complete_utc_day_ms,
    validate_and_deduplicate_1h,
)

BINANCE_FAPI_BASE = "https://fapi.binance.com"
SURVIVORSHIP_DISCLAIMER = (
    "本資料集為「目前可交易幣種的歷史試驗」，以準備資料當下之 24 小時成交額選取標的，"
    "存在存活偏差（Survivorship Bias）與事後選擇偏差（Selection Bias），不得稱為歷史全市場無偏驗證。"
)


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _http_get_json(url: str, params: dict[str, Any] | None = None, timeout: float = 20.0, retries: int = 3) -> Any:
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            resp = requests.get(url, params=params, timeout=timeout)
            if resp.status_code == 429:
                time.sleep(2.0 * (attempt + 1))
                continue
            resp.raise_for_status()
            return resp.json()
        except Exception as exc:
            last_err = exc
            time.sleep(1.0 * (attempt + 1))
    raise RuntimeError(f"GET {url} failed after {retries} retries: {last_err}")


def select_or_load_universe(
    datasets_dir: Path,
    max_symbols: int = 20,
    force_refresh: bool = False,
) -> dict[str, Any]:
    """
    Select top `max_symbols` Binance USDT-M Perpetual contracts (`status == TRADING`,
    `quoteAsset == USDT`, `contractType == PERPETUAL`) sorted by 24h `quoteVolume` descending.
    Persists fixed list and selection timestamp to `universe.json`.
    """
    datasets_dir.mkdir(parents=True, exist_ok=True)
    universe_path = datasets_dir / "universe.json"
    if universe_path.exists() and not force_refresh:
        with open(universe_path, "r", encoding="utf-8") as f:
            return json.load(f)

    exchange_info = _http_get_json(f"{BINANCE_FAPI_BASE}/fapi/v1/exchangeInfo")
    tickers_24h = _http_get_json(f"{BINANCE_FAPI_BASE}/fapi/v1/ticker/24hr")

    eligible_meta: dict[str, dict[str, Any]] = {}
    for s in exchange_info.get("symbols", []):
        if (
            s.get("status") == "TRADING"
            and s.get("quoteAsset") == "USDT"
            and s.get("contractType") == "PERPETUAL"
            and str(s.get("symbol", "")).endswith("USDT")
        ):
            eligible_meta[str(s["symbol"])] = {
                "symbol": str(s["symbol"]),
                "baseAsset": str(s.get("baseAsset", "")),
                "quoteAsset": "USDT",
                "contractType": "PERPETUAL",
                "onboardDate": int(s.get("onboardDate", 0)),
            }

    ranked: list[dict[str, Any]] = []
    for t in tickers_24h:
        sym = str(t.get("symbol", ""))
        if sym not in eligible_meta:
            continue
        qvol = float(t.get("quoteVolume", 0.0) or 0.0)
        if not np.isfinite(qvol) or qvol <= 0:
            continue
        entry = dict(eligible_meta[sym])
        entry["quoteVolume24h"] = qvol
        entry["lastPrice"] = float(t.get("lastPrice", 0.0) or 0.0)
        ranked.append(entry)

    ranked.sort(key=lambda item: (-item["quoteVolume24h"], item["symbol"]))
    selected = ranked[:max_symbols]
    now_ms = int(time.time() * 1000)

    universe_doc = {
        "selectedAt": now_ms,
        "selectedAtIso": datetime.fromtimestamp(now_ms / 1000.0, tz=timezone.utc).isoformat(),
        "market": "futures",
        "contractType": "PERPETUAL",
        "quoteAsset": "USDT",
        "maxSymbols": max_symbols,
        "symbols": [item["symbol"] for item in selected],
        "symbolDetails": selected,
        "survivorshipBiasWarning": SURVIVORSHIP_DISCLAIMER,
    }
    with open(universe_path, "w", encoding="utf-8") as f:
        json.dump(universe_doc, f, ensure_ascii=False, indent=2)
    return universe_doc


def load_local_1m_parquet_if_available(
    data_dir: Path,
    symbols: list[str],
    start_ms: int,
    end_ms: int,
) -> tuple[pd.DataFrame, list[dict[str, Any]], dict[str, Any]]:
    """
    Inspect local research Parquet files for 1m klines without opening live DuckDB.
    Aggregates complete 60-bar UTC hours into 1h klines.
    """
    candidate_globs = [
        list((data_dir / "parquet" / "klines_1m").rglob("*.parquet")) if (data_dir / "parquet" / "klines_1m").exists() else [],
        list((data_dir / "model-research" / "datasets" / "local_1m").rglob("*.parquet"))
        if (data_dir / "model-research" / "datasets" / "local_1m").exists()
        else [],
    ]
    parquet_files = [p for group in candidate_globs for p in group]
    if not parquet_files:
        empty_df, empty_gaps = aggregate_1m_to_1h_utc(pd.DataFrame(), cutoff_ms=end_ms)
        return (
            empty_df,
            empty_gaps,
            {
                "localParquetFilesFound": 0,
                "local1mRowsRead": 0,
                "aggregated1hBars": 0,
                "incomplete1hHours": 0,
                "note": "本機尚無 1m K 線研究 Parquet，全數由官方歷史 1h K 線補齊（未開啟運行中 DuckDB）。",
            },
        )

    frames: list[pd.DataFrame] = []
    for p in parquet_files:
        try:
            sub = pd.read_parquet(p)
            if "market" in sub.columns:
                sub = sub[sub["market"] == "futures"]
            if "symbol" in sub.columns:
                sub = sub[sub["symbol"].isin(symbols)]
            if "open_time" in sub.columns:
                sub = sub[(sub["open_time"] >= start_ms) & (sub["open_time"] < end_ms)]
            if not sub.empty:
                frames.append(sub)
        except Exception:
            continue

    if not frames:
        empty_df, empty_gaps = aggregate_1m_to_1h_utc(pd.DataFrame(), cutoff_ms=end_ms)
        return (
            empty_df,
            empty_gaps,
            {
                "localParquetFilesFound": len(parquet_files),
                "local1mRowsRead": 0,
                "aggregated1hBars": 0,
                "incomplete1hHours": 0,
                "note": "本機 Parquet 無符合期間與永續標的之 1m K 線。",
            },
        )

    raw_1m = pd.concat(frames, ignore_index=True)
    agg_1h, incomplete_gaps = aggregate_1m_to_1h_utc(raw_1m, cutoff_ms=end_ms)
    return (
        agg_1h,
        incomplete_gaps,
        {
            "localParquetFilesFound": len(parquet_files),
            "local1mRowsRead": int(len(raw_1m)),
            "aggregated1hBars": int(len(agg_1h)),
            "incomplete1hHours": int(len(incomplete_gaps)),
            "note": "已由本機完整 60 根 1m K 線聚合 UTC 1h K 線，缺口由官方 1h K 線補齊。",
        },
    )


def fetch_binance_1h_klines_for_symbol(
    symbol: str,
    start_ms: int,
    end_ms: int,
) -> pd.DataFrame:
    """
    Fetch historical closed 1h klines from Binance USDT-M Futures REST API for `[start_ms, end_ms)`.
    Never fabricates missing bars.
    """
    rows: list[dict[str, Any]] = []
    cursor = int(start_ms)
    limit = 1500

    while cursor < end_ms:
        batch = _http_get_json(
            f"{BINANCE_FAPI_BASE}/fapi/v1/klines",
            params={
                "symbol": symbol,
                "interval": "1h",
                "startTime": cursor,
                "endTime": end_ms - 1,
                "limit": limit,
            },
        )
        if not isinstance(batch, list) or len(batch) == 0:
            break

        for item in batch:
            open_t = int(item[0])
            close_t = int(item[6])
            # Only include closed 1h candles inside [start_ms, end_ms)
            if open_t < start_ms or open_t >= end_ms:
                continue
            if open_t + ONE_HOUR_MS > end_ms:
                continue
            rows.append(
                {
                    "symbol": symbol,
                    "open_time": open_t,
                    "close_time": close_t,
                    "open": float(item[1]),
                    "high": float(item[2]),
                    "low": float(item[3]),
                    "close": float(item[4]),
                    "volume": float(item[5]),
                    "quote_volume": float(item[7]),
                    "trades": int(item[8]),
                    "taker_buy_base": float(item[9]),
                    "taker_buy_quote": float(item[10]),
                    "is_final": True,
                    "source": "binance_rest_1h",
                }
            )

        last_open = int(batch[-1][0])
        if last_open < cursor:
            break
        cursor = last_open + ONE_HOUR_MS
        if len(batch) < limit:
            break
        time.sleep(0.05)

    return pd.DataFrame(rows)


def fetch_binance_funding_rates_for_symbol(
    symbol: str,
    start_ms: int,
    end_ms: int,
) -> pd.DataFrame:
    """
    Fetch all historical funding rate settlements for `symbol` across `[start_ms - 8h, end_ms + 8h]`.
    """
    rows: list[dict[str, Any]] = []
    cursor = int(start_ms - EIGHT_HOURS_MS)
    query_end = int(end_ms + EIGHT_HOURS_MS)
    limit = 1000

    while cursor <= query_end:
        batch = _http_get_json(
            f"{BINANCE_FAPI_BASE}/fapi/v1/fundingRate",
            params={
                "symbol": symbol,
                "startTime": cursor,
                "endTime": query_end,
                "limit": limit,
            },
        )
        if not isinstance(batch, list) or len(batch) == 0:
            break

        for item in batch:
            f_time = int(item["fundingTime"])
            f_rate = float(item["fundingRate"])
            m_price = float(item.get("markPrice") or 0.0) if item.get("markPrice") not in (None, "") else np.nan
            rows.append(
                {
                    "symbol": symbol,
                    "funding_time": f_time,
                    "funding_rate": f_rate,
                    "mark_price": m_price,
                    "source": "binance_rest_funding",
                }
            )

        last_f_time = int(batch[-1]["fundingTime"])
        if last_f_time < cursor:
            break
        cursor = last_f_time + 1000
        if len(batch) < limit:
            break
        time.sleep(0.05)

    return pd.DataFrame(rows)


def _compute_missing_1h_intervals(
    local_1h_df: pd.DataFrame,
    symbol: str,
    start_ms: int,
    end_ms: int,
) -> list[tuple[int, int]]:
    """
    Given aggregated local 1h bars (`local_1h_df`), return only the missing `[gap_start_ms, gap_end_ms)`
    intervals across `[start_ms, end_ms)` that need to be backfilled from official Binance 1h REST klines.
    """
    expected_grid = np.arange(int(start_ms), int(end_ms), ONE_HOUR_MS, dtype=np.int64)
    if expected_grid.size == 0:
        return []
    if local_1h_df is None or local_1h_df.empty or "symbol" not in local_1h_df.columns:
        return [(int(start_ms), int(end_ms))]
    sym_df = local_1h_df[local_1h_df["symbol"] == symbol]
    if sym_df.empty:
        return [(int(start_ms), int(end_ms))]
    present_times = sym_df["open_time"].to_numpy(dtype=np.int64)
    missing = np.setdiff1d(expected_grid, present_times, assume_unique=False)
    if missing.size == 0:
        return []
    intervals: list[tuple[int, int]] = []
    gap_start = int(missing[0])
    prev_t = int(missing[0])
    for m_t in missing[1:]:
        m_int = int(m_t)
        if m_int == prev_t + ONE_HOUR_MS:
            prev_t = m_int
        else:
            intervals.append((gap_start, prev_t + ONE_HOUR_MS))
            gap_start = m_int
            prev_t = m_int
    intervals.append((gap_start, prev_t + ONE_HOUR_MS))
    return intervals


def prepare_research_dataset(
    data_dir: Path,
    max_symbols: int = 20,
    end_utc_ms: int | None = None,
    force_refresh_universe: bool = False,
    force_redownload: bool = False,
    rebuild_panel_only: bool = False,
) -> dict[str, Any]:
    """
    Prepare the 180-day (120d train / 30d val / 30d test) research dataset in
    `data/model-research/datasets/`.
    """
    datasets_dir = data_dir / "model-research" / "datasets"
    datasets_dir.mkdir(parents=True, exist_ok=True)

    klines_path = datasets_dir / "klines_1h.parquet"
    funding_path = datasets_dir / "funding_rates.parquet"
    panel_path = datasets_dir / "research_panel.parquet"
    manifest_path = datasets_dir / "dataset_manifest.json"
    report_md_path = datasets_dir / "data_quality_report.md"

    if (
        not force_redownload
        and not rebuild_panel_only
        and klines_path.exists()
        and funding_path.exists()
        and panel_path.exists()
        and manifest_path.exists()
    ):
        with open(manifest_path, "r", encoding="utf-8") as f:
            cached = json.load(f)
        if cached.get("pipelineVersion", 1) < 3:
            raise ValueError("舊版研究資料尚未依第二輪修正重建；請指定新的 --data-dir，保留舊資料與模型")
        return cached

    universe = select_or_load_universe(
        datasets_dir=datasets_dir,
        max_symbols=max_symbols,
        force_refresh=force_refresh_universe,
    )
    symbols: list[str] = universe["symbols"]

    if rebuild_panel_only and klines_path.exists() and funding_path.exists():
        raw_1h_df = pd.read_parquet(klines_path)
        funding_df = pd.read_parquet(funding_path)
        if end_utc_ms is not None:
            end_day_ms = last_complete_utc_day_ms(end_utc_ms)
        elif manifest_path.exists():
            with open(manifest_path, "r", encoding="utf-8") as f:
                prev_manifest = json.load(f)
            end_day_ms = int(prev_manifest.get("boundaries", {}).get("testEndMs") or (int(raw_1h_df["open_time"].max()) + ONE_HOUR_MS))
        else:
            end_day_ms = last_complete_utc_day_ms(int(raw_1h_df["open_time"].max()) + ONE_HOUR_MS)

        boundaries = compute_time_split_boundaries(end_day_ms, train_days=120, val_days=30, test_days=30)
        warmup_hours = 264
        fetch_start_ms = boundaries.start_ms - warmup_hours * ONE_HOUR_MS
        fetch_end_ms = boundaries.test_end_ms
        clean_1h_df, gaps_by_symbol = validate_and_deduplicate_1h(
            raw_1h_df,
            cutoff_ms=fetch_end_ms,
            expected_start_ms=boundaries.start_ms,
            expected_end_ms=boundaries.test_end_ms,
            filter_start_ms=fetch_start_ms,
            expected_symbols=symbols,
        )
        local_inventory = {
            "localParquetFilesFound": 1,
            "local1mRowsRead": 0,
            "aggregated1hBars": int(len(clean_1h_df)),
            "incomplete1hHours": 0,
            "note": "已由本機既有 klines_1h.parquet 與 funding_rates.parquet 直接重建特徵與研究面板。",
        }
    else:
        ref_ms = end_utc_ms if end_utc_ms is not None else int(time.time() * 1000)
        end_day_ms = last_complete_utc_day_ms(ref_ms)
        boundaries = compute_time_split_boundaries(end_day_ms, train_days=120, val_days=30, test_days=30)

        # Fetch an extra 11 days (264h) before `boundaries.start_ms` so that the very first hour of train
        # has both the 96h LightGBM feature lookback AND the 256h Kronos lookback ready!
        warmup_hours = 264
        fetch_start_ms = boundaries.start_ms - warmup_hours * ONE_HOUR_MS
        fetch_end_ms = boundaries.test_end_ms

        local_1h_df, incomplete_local_hours, local_inventory = load_local_1m_parquet_if_available(
            data_dir=data_dir,
            symbols=symbols,
            start_ms=fetch_start_ms,
            end_ms=fetch_end_ms,
        )

        rest_kline_frames: list[pd.DataFrame] = []
        funding_frames: list[pd.DataFrame] = []

        for sym in symbols:
            missing_intervals = _compute_missing_1h_intervals(
                local_1h_df=local_1h_df,
                symbol=sym,
                start_ms=fetch_start_ms,
                end_ms=fetch_end_ms,
            )
            for gap_start_ms, gap_end_ms in missing_intervals:
                k_df = fetch_binance_1h_klines_for_symbol(sym, start_ms=gap_start_ms, end_ms=gap_end_ms)
                if not k_df.empty:
                    rest_kline_frames.append(k_df)
            f_df = fetch_binance_funding_rates_for_symbol(sym, start_ms=fetch_start_ms, end_ms=fetch_end_ms)
            if not f_df.empty:
                funding_frames.append(f_df)

        available_frames = [df for df in [local_1h_df] + rest_kline_frames if df is not None and not df.empty]
        combined_raw_1h = pd.concat(available_frames, ignore_index=True) if available_frames else pd.DataFrame()
        clean_1h_df, gaps_by_symbol = validate_and_deduplicate_1h(
            combined_raw_1h,
            cutoff_ms=fetch_end_ms,
            expected_start_ms=boundaries.start_ms,
            expected_end_ms=boundaries.test_end_ms,
            filter_start_ms=fetch_start_ms,
            expected_symbols=symbols,
        )

        funding_df = (
            pd.concat(funding_frames, ignore_index=True)
            if funding_frames
            else pd.DataFrame(columns=["symbol", "funding_time", "funding_rate", "mark_price", "source"])
        )
        if not funding_df.empty:
            funding_df = (
                funding_df.sort_values(["symbol", "funding_time"])
                .drop_duplicates(subset=["symbol", "funding_time"], keep="last")
                .reset_index(drop=True)
            )

        clean_1h_df.to_parquet(klines_path, index=False)
        funding_df.to_parquet(funding_path, index=False)

    panel_df = build_research_panel(
        df_1h=clean_1h_df,
        df_funding=funding_df,
        boundaries=boundaries,
        cutoff_ms=boundaries.test_end_ms,
    )
    panel_df.to_parquet(panel_path, index=False)

    # Audit each symbol's data sufficiency across the 180-day window (4320 hours)
    expected_180d_hours = 180 * 24
    symbol_quality: list[dict[str, Any]] = []
    insufficient_symbols: list[dict[str, Any]] = []

    in_window_1h = clean_1h_df[
        (clean_1h_df["open_time"] >= boundaries.start_ms) & (clean_1h_df["open_time"] < boundaries.test_end_ms)
    ]

    for sym in symbols:
        sym_bars = in_window_1h[in_window_1h["symbol"] == sym]
        sym_panel = panel_df[(panel_df["symbol"] == sym) & (panel_df["split"].isin(["train", "val", "test"]))]
        sym_funding = funding_df[
            (funding_df["symbol"] == sym)
            & (funding_df["funding_time"] >= boundaries.start_ms)
            & (funding_df["funding_time"] <= boundaries.test_end_ms)
        ]
        sym_gaps = gaps_by_symbol.get(sym, [])
        missing_hours = sum(int(g["missing_hours"]) for g in sym_gaps)
        bar_count = int(len(sym_bars))
        coverage_ratio = round(bar_count / expected_180d_hours, 6)

        train_valid = int((sym_panel["split"] == "train").sum())
        val_valid = int((sym_panel["split"] == "val").sum())
        test_valid = int((sym_panel["split"] == "test").sum())
        f_missing_cnt = int(sym_panel["funding_missing"].astype(bool).sum()) if not sym_panel.empty else 0

        reasons: list[str] = []
        if bar_count < expected_180d_hours:
            reasons.append(f"180 天期間缺少 {expected_180d_hours - bar_count} 根 1h K 線（涵蓋率 {coverage_ratio*100:.2f}%）")
        if train_valid == 0:
            reasons.append("訓練集（120 天）無有效樣本（可能為近期新上架合約）")
        if val_valid == 0:
            reasons.append("驗證集（30 天）無有效樣本")
        if test_valid == 0:
            reasons.append("測試集（30 天）無有效樣本")
        if f_missing_cnt > 0:
            reasons.append(f"持有期間缺少資金費率紀錄共 {f_missing_cnt} 筆（已依規則自淨績效排除）")

        qual_entry = {
            "symbol": sym,
            "barCount180d": bar_count,
            "expectedHours180d": expected_180d_hours,
            "coverageRatio": coverage_ratio,
            "missingHours": missing_hours,
            "gapIntervals": sym_gaps,
            "fundingEventsCount": int(len(sym_funding)),
            "fundingMissingSampleCount": f_missing_cnt,
            "trainRows": train_valid,
            "valRows": val_valid,
            "testRows": test_valid,
            "fullyCovered": len(reasons) == 0,
            "reasons": reasons,
        }
        symbol_quality.append(qual_entry)
        if reasons:
            insufficient_symbols.append({"symbol": sym, "reasons": reasons})

    # Split summary
    split_summary: dict[str, Any] = {}
    for sp_name in ["train", "val", "test"]:
        sp_df = panel_df[panel_df["split"] == sp_name]
        sp_elig = sp_df[sp_df["group_eligible"].astype(bool)]
        total_hours = int(sp_df["open_time"].nunique()) if not sp_df.empty else 0
        eligible_hours = int(sp_elig["open_time"].nunique()) if not sp_elig.empty else 0
        boundary_excluded = int(sp_df["crosses_split_boundary"].astype(bool).sum()) if not sp_df.empty else 0
        funding_excluded = (
            int((sp_df["features_valid"].astype(bool) & (~sp_df["crosses_split_boundary"].astype(bool)) & sp_df["funding_missing"].astype(bool)).sum())
            if not sp_df.empty
            else 0
        )
        split_summary[sp_name] = {
            "totalHours": total_hours,
            "eligibleRankingHours": eligible_hours,
            "skippedHoursUnder10Symbols": max(0, total_hours - eligible_hours),
            "totalSymbolHourRows": int(len(sp_df)),
            "eligibleSymbolHourRows": int(len(sp_elig)),
            "boundaryExcludedRows": boundary_excluded,
            "fundingMissingExcludedRows": funding_excluded,
        }

    manifest = {
        "pipelineVersion": 3,
        "datasetVersion": f"ds-{end_day_ms}-{sha256_file(klines_path)[:10]}",
        "generatedAt": int(time.time() * 1000),
        "generatedAtIso": datetime.now(tz=timezone.utc).isoformat(),
        "survivorshipBiasDisclaimer": SURVIVORSHIP_DISCLAIMER,
        "universe": universe,
        "boundaries": {
            "warmupStartMs": fetch_start_ms,
            "startMs": boundaries.start_ms,
            "startIso": datetime.fromtimestamp(boundaries.start_ms / 1000.0, tz=timezone.utc).isoformat(),
            "trainEndMs": boundaries.train_end_ms,
            "trainEndIso": datetime.fromtimestamp(boundaries.train_end_ms / 1000.0, tz=timezone.utc).isoformat(),
            "valEndMs": boundaries.val_end_ms,
            "valEndIso": datetime.fromtimestamp(boundaries.val_end_ms / 1000.0, tz=timezone.utc).isoformat(),
            "testEndMs": boundaries.test_end_ms,
            "testEndIso": datetime.fromtimestamp(boundaries.test_end_ms / 1000.0, tz=timezone.utc).isoformat(),
            "trainDays": boundaries.train_days,
            "valDays": boundaries.val_days,
            "testDays": boundaries.test_days,
            "minEligibleSymbolsPerGroup": MIN_ELIGIBLE_SYMBOLS_PER_GROUP,
        },
        "localInventory": local_inventory,
        "files": {
            "klines1hParquet": {
                "path": str(klines_path.relative_to(data_dir)),
                "sha256": sha256_file(klines_path),
                "rows": int(len(clean_1h_df)),
            },
            "fundingRatesParquet": {
                "path": str(funding_path.relative_to(data_dir)),
                "sha256": sha256_file(funding_path),
                "rows": int(len(funding_df)),
            },
            "researchPanelParquet": {
                "path": str(panel_path.relative_to(data_dir)),
                "sha256": sha256_file(panel_path),
                "rows": int(len(panel_df)),
            },
        },
        "splitSummary": split_summary,
        "symbolQuality": symbol_quality,
        "insufficientSymbols": insufficient_symbols,
    }

    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    # Write human-readable Markdown quality & gap report
    md_lines = [
        "# 模型選幣研究資料集品質與缺口報告",
        "",
        f"- **資料版本**：`{manifest['datasetVersion']}`",
        f"- **產生時間 (UTC)**：`{manifest['generatedAtIso']}`",
        f"- **選幣時間 (UTC)**：`{universe['selectedAtIso']}`（共 {len(symbols)} 檔 USDT 永續合約）",
        f"- **研究期間 (180 天)**：`{manifest['boundaries']['startIso']}` 至 `{manifest['boundaries']['testEndIso']}`",
        f"  - 訓練集 (120 天)：`{manifest['boundaries']['startIso']}` ~ `{manifest['boundaries']['trainEndIso']}`",
        f"  - 驗證集 (30 天)：`{manifest['boundaries']['trainEndIso']}` ~ `{manifest['boundaries']['valEndIso']}`",
        f"  - 測試集 (30 天)：`{manifest['boundaries']['valEndIso']}` ~ `{manifest['boundaries']['testEndIso']}`",
        "",
        f"> **偏差聲明**：{SURVIVORSHIP_DISCLAIMER}",
        "",
        "## 1. 切分與跨邊界／缺口排除統計",
        "",
        "| 切分 | 總小時點數 | 合格排名小時點數 (>=10幣) | 合格樣本列數 | 跨切分邊界刪除列數 | 缺資金費排除列數 |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for sp_name, sp_info in split_summary.items():
        md_lines.append(
            f"| {sp_name} | {sp_info['totalHours']} | {sp_info['eligibleRankingHours']} | "
            f"{sp_info['eligibleSymbolHourRows']} | {sp_info['boundaryExcludedRows']} | {sp_info['fundingMissingExcludedRows']} |"
        )

    md_lines.extend(
        [
            "",
            "## 2. 各幣種 180 天資料完整度與缺口明細",
            "",
            "| 標的 | 180d K線數 | 涵蓋率 | 缺口小時數 | 資金費筆數 | 缺資金費樣本數 | 訓練/驗證/測試列數 | 狀態與原因 |",
            "|---|---:|---:|---:|---:|---:|---|---|",
        ]
    )
    for sq in symbol_quality:
        reason_str = "完整" if sq["fullyCovered"] else "；".join(sq["reasons"])
        md_lines.append(
            f"| {sq['symbol']} | {sq['barCount180d']}/{sq['expectedHours180d']} | {sq['coverageRatio']*100:.2f}% | "
            f"{sq['missingHours']} | {sq['fundingEventsCount']} | {sq['fundingMissingSampleCount']} | "
            f"{sq['trainRows']}/{sq['valRows']}/{sq['testRows']} | {reason_str} |"
        )

    with open(report_md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(md_lines) + "\n")

    return manifest
