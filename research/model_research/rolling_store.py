"""Local 180-day sliding-window dataset store and zero-leakage panel builder for hourly retraining."""
from __future__ import annotations

import hashlib
import json
import os
import time
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

import numpy as np
import pandas as pd

from .data_prep import (
    _compute_missing_1h_intervals,
    fetch_binance_1h_klines_for_symbol,
    fetch_binance_funding_rates_for_symbol,
)
from .features_and_labels import (
    MIN_ELIGIBLE_SYMBOLS_PER_GROUP,
    ONE_DAY_MS,
    ONE_HOUR_MS,
    TimeSplitBoundaries,
    build_research_panel,
    validate_and_deduplicate_1h,
)

LIVE_SUBDIR = "model-live"
DEFAULT_WINDOW_DAYS = 180
DEFAULT_VAL_DAYS = 30
DEFAULT_WARMUP_DAYS = 15

EXPECTED_KLINES_COLUMNS = [
    "symbol",
    "open_time",
    "close_time",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "quote_volume",
    "trades",
    "taker_buy_base",
    "taker_buy_quote",
    "is_final",
    "source",
]

EXPECTED_FUNDING_COLUMNS = [
    "symbol",
    "funding_time",
    "funding_rate",
    "mark_price",
    "source",
]


class RollingDataNotReadyError(RuntimeError):
    """Raised when closed hourly bars at targetCutoffTime are incomplete across the universe."""


@dataclass(frozen=True)
class LivePaths:
    data_dir: Path
    live_root: Path
    datasets_dir: Path
    universe_path: Path
    klines_path: Path
    funding_path: Path
    state_path: Path
    lgbm_root: Path
    lgbm_versions_dir: Path
    lgbm_current_path: Path
    chronos_root: Path
    chronos_versions_dir: Path
    chronos_current_path: Path
    chronos_status_path: Path


def resolve_live_paths(data_dir: Path) -> LivePaths:
    root = Path(data_dir).resolve()
    live_root = root / LIVE_SUBDIR
    datasets_dir = live_root / "datasets"
    lgbm_root = live_root / "models" / "lgbm"
    chronos_root = live_root / "models" / "chronos2"
    return LivePaths(
        data_dir=root,
        live_root=live_root,
        datasets_dir=datasets_dir,
        universe_path=datasets_dir / "universe.json",
        klines_path=datasets_dir / "klines_1h.parquet",
        funding_path=datasets_dir / "funding_rates.parquet",
        state_path=datasets_dir / "dataset_state.json",
        lgbm_root=lgbm_root,
        lgbm_versions_dir=lgbm_root / "versions",
        lgbm_current_path=lgbm_root / "current.json",
        chronos_root=chronos_root,
        chronos_versions_dir=chronos_root / "versions",
        chronos_current_path=chronos_root / "current.json",
        chronos_status_path=chronos_root / "training_status.json",
    )


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def atomic_write_json(target_path: Path, payload: dict[str, Any]) -> None:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = target_path.parent / f".{target_path.name}.{uuid.uuid4().hex}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, target_path)


def _atomic_write_parquet(df: pd.DataFrame, target_path: Path) -> None:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = target_path.parent / f".{target_path.name}.{uuid.uuid4().hex}.tmp"
    try:
        df.to_parquet(tmp, index=False)
        os.replace(tmp, target_path)
    except BaseException:
        if tmp.exists():
            tmp.unlink(missing_ok=True)
        raise


def load_universe_symbols(data_dir: Path, override_symbols: list[str] | None = None) -> list[str]:
    if override_symbols:
        cleaned = list(dict.fromkeys(str(s).strip().upper() for s in override_symbols if str(s).strip()))
        if cleaned:
            return cleaned

    paths = resolve_live_paths(data_dir)
    for candidate in (
        paths.universe_path,
        paths.data_dir / "model-research" / "datasets" / "universe.json",
        paths.data_dir / "model-research" / "datasets" / "dataset_manifest.json",
    ):
        if candidate.is_file():
            doc = json.loads(candidate.read_text(encoding="utf-8"))
            syms = doc.get("universe", {}).get("symbols") if "universe" in doc else doc.get("symbols")
            if isinstance(syms, list) and syms:
                cleaned = list(dict.fromkeys(str(s).strip().upper() for s in syms if str(s).strip()))
                if cleaned:
                    return cleaned
    raise FileNotFoundError("找不到研究固定幣種清單（universe.json 或 dataset_manifest.json）")


def _normalize_kline_df(df: pd.DataFrame) -> pd.DataFrame:
    if df is None or df.empty:
        return pd.DataFrame(columns=EXPECTED_KLINES_COLUMNS)
    out = df.copy()
    if "is_final" in out.columns and out["is_final"].dtype == object:
        out["is_final"] = out["is_final"].astype(str).str.strip().str.lower().isin(("true", "1"))
    elif "is_final" in out.columns:
        out["is_final"] = out["is_final"].astype(bool)
    else:
        out["is_final"] = True
    for col in EXPECTED_KLINES_COLUMNS:
        if col not in out.columns:
            out[col] = "local" if col == "source" else 0.0
    return out[EXPECTED_KLINES_COLUMNS]


def _normalize_funding_df(df: pd.DataFrame) -> pd.DataFrame:
    if df is None or df.empty:
        return pd.DataFrame(columns=EXPECTED_FUNDING_COLUMNS)
    out = df.copy()
    for col in EXPECTED_FUNDING_COLUMNS:
        if col not in out.columns:
            out[col] = "local" if col == "source" else np.nan
    out["symbol"] = out["symbol"].astype(str).str.strip().str.upper()
    out["funding_time"] = pd.to_numeric(out["funding_time"], errors="coerce")
    out["funding_rate"] = pd.to_numeric(out["funding_rate"], errors="coerce")
    out["mark_price"] = pd.to_numeric(out["mark_price"], errors="coerce")
    out = out.dropna(subset=["symbol", "funding_time", "funding_rate"])
    out["funding_time"] = out["funding_time"].astype("int64")
    return out[EXPECTED_FUNDING_COLUMNS]


def _load_initial_sources(paths: LivePaths, seed_data_dir: Path | None) -> tuple[list[pd.DataFrame], list[pd.DataFrame]]:
    kline_frames: list[pd.DataFrame] = []
    funding_frames: list[pd.DataFrame] = []

    if paths.klines_path.is_file():
        kline_frames.append(_normalize_kline_df(pd.read_parquet(paths.klines_path)))
    if paths.funding_path.is_file():
        funding_frames.append(_normalize_funding_df(pd.read_parquet(paths.funding_path)))

    # Read-only seed from historical research dataset only on first live bootstrap (never modifies seed files)
    if not kline_frames:
        seed_root = Path(seed_data_dir).resolve() if seed_data_dir else paths.data_dir
        seed_klines = seed_root / "model-research" / "datasets" / "klines_1h.parquet"
        seed_funding = seed_root / "model-research" / "datasets" / "funding_rates.parquet"
        if seed_klines.is_file():
            kline_frames.append(_normalize_kline_df(pd.read_parquet(seed_klines)))
        if seed_funding.is_file():
            funding_frames.append(_normalize_funding_df(pd.read_parquet(seed_funding)))

    return kline_frames, funding_frames


def sync_rolling_dataset(
    data_dir: Path,
    target_cutoff_ms: int,
    *,
    universe_symbols: list[str] | None = None,
    window_days: int = DEFAULT_WINDOW_DAYS,
    warmup_days: int = DEFAULT_WARMUP_DAYS,
    seed_data_dir: Path | None = None,
    supplemental_klines_csv: Path | None = None,
    supplemental_funding_csv: Path | None = None,
    fetch_klines_fn: Callable[[str, int, int], pd.DataFrame] | None = None,
    fetch_funding_fn: Callable[[str, int, int], pd.DataFrame] | None = None,
    require_latest_hour: bool = True,
    allow_network: bool = True,
) -> dict[str, Any]:
    """
    Maintain a rolling `[cutoff - (window_days + warmup_days), cutoff)` 1h kline & funding parquet store
    under `<data_dir>/model-live/datasets/`, using `data/model-research/datasets` read-only as initial seed.
    """
    cutoff_ms = int(target_cutoff_ms)
    if cutoff_ms <= 0 or cutoff_ms % ONE_HOUR_MS != 0:
        raise ValueError("target_cutoff_ms 必須為正數 UTC 整點毫秒時間戳")

    paths = resolve_live_paths(data_dir)
    paths.datasets_dir.mkdir(parents=True, exist_ok=True)

    symbols = load_universe_symbols(data_dir, universe_symbols)
    symbol_set = set(symbols)
    if not paths.universe_path.is_file():
        atomic_write_json(
            paths.universe_path,
            {
                "symbols": symbols,
                "seededAt": int(time.time() * 1000),
                "source": "model-research-seed",
            },
        )

    retain_start_ms = cutoff_ms - (int(window_days) + int(warmup_days)) * ONE_DAY_MS
    funding_retain_start_ms = retain_start_ms - 8 * ONE_DAY_MS
    window_start_ms = cutoff_ms - int(window_days) * ONE_DAY_MS

    kline_frames, funding_frames = _load_initial_sources(paths, seed_data_dir)

    for csv_path, expected_cols, target_list, normalizer in [
        (supplemental_klines_csv, EXPECTED_KLINES_COLUMNS, kline_frames, _normalize_kline_df),
        (supplemental_funding_csv, EXPECTED_FUNDING_COLUMNS, funding_frames, _normalize_funding_df),
    ]:
        if csv_path and Path(csv_path).is_file():
            df_csv = pd.read_csv(csv_path)
            if list(df_csv.columns) != expected_cols:
                raise ValueError(f"{Path(csv_path).name} 欄位與規格不一致：{list(df_csv.columns)}")
            if not df_csv.empty:
                target_list.append(normalizer(df_csv))

    raw_1h = pd.concat(kline_frames, ignore_index=True) if kline_frames else pd.DataFrame(columns=EXPECTED_KLINES_COLUMNS)
    raw_1h = raw_1h[raw_1h["symbol"].astype(str).isin(symbol_set)].copy() if not raw_1h.empty else raw_1h
    clean_1h, _ = validate_and_deduplicate_1h(raw_1h, cutoff_ms=cutoff_ms)

    raw_funding = pd.concat(funding_frames, ignore_index=True) if funding_frames else pd.DataFrame(columns=EXPECTED_FUNDING_COLUMNS)
    raw_funding = raw_funding[raw_funding["symbol"].astype(str).isin(symbol_set)].copy() if not raw_funding.empty else raw_funding
    if not raw_funding.empty:
        raw_funding = raw_funding[raw_funding["funding_time"] <= cutoff_ms].copy()

    prev_state: dict[str, Any] = {}
    if paths.state_path.is_file():
        try:
            prev_state = json.loads(paths.state_path.read_text(encoding="utf-8"))
        except Exception:
            prev_state = {}

    if allow_network:
        k_fetcher = fetch_klines_fn or fetch_binance_1h_klines_for_symbol
        f_fetcher = fetch_funding_fn or fetch_binance_funding_rates_for_symbol

        # Once initial 180d history backfill finishes once, only check trailing 48h + tail per hour.
        initial_done = bool(prev_state.get("initialBackfillDone"))
        prev_cutoff = int(prev_state.get("lastSyncedCutoffTime") or prev_state.get("lastCutoffTime") or 0)
        repair_lookback = (
            max(retain_start_ms, prev_cutoff - 48 * ONE_HOUR_MS)
            if (initial_done and prev_cutoff > retain_start_ms)
            else retain_start_ms
        )

        fetched_klines: list[pd.DataFrame] = []
        fetched_funding: list[pd.DataFrame] = []

        funding_max_by_sym: dict[str, int] = {}
        if not raw_funding.empty:
            funding_max_by_sym = {
                str(sym): int(mx)
                for sym, mx in raw_funding.groupby("symbol")["funding_time"].max().items()
            }

        for sym in symbols:
            sym_repair_start = repair_lookback
            if initial_done and not clean_1h.empty:
                sym_rows = clean_1h[clean_1h["symbol"] == sym]
                if not sym_rows.empty:
                    sym_repair_start = max(retain_start_ms, int(sym_rows["open_time"].max()) - 48 * ONE_HOUR_MS)
            missing_intervals = _compute_missing_1h_intervals(clean_1h, sym, sym_repair_start, cutoff_ms)
            for gap_start, gap_end in missing_intervals:
                df_batch = _normalize_kline_df(k_fetcher(sym, gap_start, gap_end))
                if not df_batch.empty:
                    fetched_klines.append(df_batch)

            last_f = funding_max_by_sym.get(sym)
            # Re-check last 24h before last_f in case Binance posted mark_price cleanly or recent settlement arrived
            f_start = max(funding_retain_start_ms, last_f - 24 * ONE_HOUR_MS) if last_f else funding_retain_start_ms
            if f_start <= cutoff_ms:
                df_f = _normalize_funding_df(f_fetcher(sym, f_start, cutoff_ms))
                if not df_f.empty:
                    fetched_funding.append(df_f)

        if fetched_klines:
            combined_k = pd.concat([clean_1h, *fetched_klines], ignore_index=True) if not clean_1h.empty else pd.concat(fetched_klines, ignore_index=True)
            clean_1h, _ = validate_and_deduplicate_1h(combined_k, cutoff_ms=cutoff_ms)

        if fetched_funding:
            raw_funding = pd.concat([raw_funding, *fetched_funding], ignore_index=True) if not raw_funding.empty else pd.concat(fetched_funding, ignore_index=True)

    # Trim sliding window & normalize schema
    if not clean_1h.empty:
        clean_1h = clean_1h[clean_1h["open_time"] >= retain_start_ms].sort_values(["symbol", "open_time"]).reset_index(drop=True)
    clean_1h = _normalize_kline_df(clean_1h)

    if not raw_funding.empty:
        raw_funding = (
            raw_funding[
                (raw_funding["funding_time"] >= funding_retain_start_ms)
                & (raw_funding["funding_time"] <= cutoff_ms)
            ]
            .sort_values(["symbol", "funding_time"])
            .drop_duplicates(subset=["symbol", "funding_time"], keep="last")
            .reset_index(drop=True)
        )
    raw_funding = _normalize_funding_df(raw_funding)

    _atomic_write_parquet(clean_1h, paths.klines_path)
    _atomic_write_parquet(raw_funding, paths.funding_path)

    target_open_time = cutoff_ms - ONE_HOUR_MS
    missing_latest: list[str] = []
    for sym in symbols:
        sym_bars = clean_1h[clean_1h["symbol"] == sym]
        if sym_bars.empty or int(sym_bars["open_time"].max()) != target_open_time:
            missing_latest.append(sym)

    klines_sha = sha256_file(paths.klines_path)
    funding_sha = sha256_file(paths.funding_path)
    now_ms = int(time.time() * 1000)

    if require_latest_hour and missing_latest:
        atomic_write_json(
            paths.state_path,
            {
                **prev_state,
                "pipelineVersion": 3,
                "initialBackfillDone": True,
                "lastSyncedCutoffTime": int(clean_1h["open_time"].max()) + ONE_HOUR_MS if not clean_1h.empty else prev_state.get("lastSyncedCutoffTime"),
                "missingLatestSymbols": missing_latest,
                "updatedAt": now_ms,
            },
        )
        raise RollingDataNotReadyError(
            f"以下標的尚未取得決策小時 {target_open_time} 之已收盤 1h K 線：{', '.join(missing_latest)}"
        )

    dataset_version = f"live-{cutoff_ms}-{klines_sha[:10]}"

    state_doc = {
        "pipelineVersion": 3,
        "initialBackfillDone": True,
        "datasetVersion": dataset_version,
        "windowDays": int(window_days),
        "warmupDays": int(warmup_days),
        "windowStartMs": window_start_ms,
        "lastCutoffTime": cutoff_ms,
        "lastCutoffIso": datetime.fromtimestamp(cutoff_ms / 1000.0, tz=timezone.utc).isoformat(),
        "lastSyncedCutoffTime": cutoff_ms,
        "universeSymbols": symbols,
        "rowCount": int(len(clean_1h)),
        "fundingRowCount": int(len(raw_funding)),
        "klinesSha256": klines_sha,
        "fundingSha256": funding_sha,
        "missingLatestSymbols": missing_latest,
        "updatedAt": now_ms,
    }
    atomic_write_json(paths.state_path, state_doc)

    return {
        "paths": paths,
        "state": state_doc,
        "df_1h": clean_1h,
        "df_funding": raw_funding,
        "symbols": symbols,
        "cutoffTime": cutoff_ms,
    }


def build_rolling_panel_and_splits(
    df_1h: pd.DataFrame,
    df_funding: pd.DataFrame | None,
    target_cutoff_ms: int,
    *,
    window_days: int = DEFAULT_WINDOW_DAYS,
    val_days: int = DEFAULT_VAL_DAYS,
) -> tuple[pd.DataFrame, TimeSplitBoundaries]:
    """
    Build strictly causal v3 features & labels on the `[cutoff - window_days, cutoff)` sliding window.
    Split policy:
    - `train`: `[window_start, cutoff - val_days)` (`exit_time < val_start`)
    - `val`:   `[cutoff - val_days, cutoff)` (`exit_time < cutoff`, excluding unsettled tail >= cutoff - 5h)
    - `test`:  empty (live forward trading is the real out-of-sample test)
    """
    cutoff_ms = int(target_cutoff_ms)
    eff_window_days = max(2, int(window_days))
    eff_val_days = min(max(1, int(val_days)), eff_window_days - 1)
    window_start = cutoff_ms - eff_window_days * ONE_DAY_MS
    val_start = cutoff_ms - eff_val_days * ONE_DAY_MS

    boundaries = TimeSplitBoundaries(
        start_ms=window_start,
        train_end_ms=val_start,
        val_end_ms=cutoff_ms,
        test_end_ms=cutoff_ms,
        train_days=eff_window_days - eff_val_days,
        val_days=eff_val_days,
        test_days=0,
    )
    panel_df = build_research_panel(
        df_1h=df_1h,
        df_funding=df_funding,
        boundaries=boundaries,
        cutoff_ms=cutoff_ms,
        min_group_size=MIN_ELIGIBLE_SYMBOLS_PER_GROUP,
    )
    return panel_df, boundaries
