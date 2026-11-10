"""
Data aggregation, gap detection, causal feature engineering, forward labeling,
funding/cost accounting, and time-split assignment for LightGBM & Kronos research.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
import numpy as np
import pandas as pd

ONE_MINUTE_MS = 60_000
ONE_HOUR_MS = 3_600_000
ONE_DAY_MS = 24 * ONE_HOUR_MS
EIGHT_HOURS_MS = 8 * ONE_HOUR_MS

MIN_ELIGIBLE_SYMBOLS_PER_GROUP = 10
HOLDING_HOURS = 4
FEATURE_LOOKBACK_HOURS = 96  # 24h SMA4 (4*24=96h) requires 97 consecutive hourly bars [t-96h .. t]
FUNDING_ZSCORE_WINDOW_MS = 7 * ONE_DAY_MS
MIN_FUNDING_EVENTS_FOR_ZSCORE = 6

FEATURE_COLUMNS: list[str] = [
    "ret_1h",
    "ret_4h",
    "ret_12h",
    "ret_24h",
    "ret_48h",
    "ret_72h",
    "vol_24h",
    "vol_72h",
    "quote_vol_24h",
    "vol_ratio_1h",
    "amplitude_1h",
    "close_pos_1h",
    "dist_sma20",
    "dist_sma60",
    "rsi_14",
    # 4h & 24h macro timeframe trend features (strictly causal up to t)
    "trend_4h_sma6_dist",
    "trend_4h_slope",
    "trend_24h_sma4_dist",
    "trend_24h_slope",
    "close_pos_24h",
    "amplitude_24h",
    # Funding rate anomaly features (strictly causal: funding_time <= decision_time = t + 1h)
    "funding_rate_latest",
    "funding_rate_zscore_7d",
    "funding_rate_diff",
    # Cross-sectional ranks at decision timestamp
    "cs_rank_ret_1h",
    "cs_rank_ret_4h",
    "cs_rank_ret_24h",
    "cs_rank_ret_72h",
    "cs_rank_quote_vol_24h",
    "cs_rank_funding_zscore_7d",
]


@dataclass(frozen=True)
class TimeSplitBoundaries:
    start_ms: int
    train_end_ms: int
    val_end_ms: int
    test_end_ms: int
    train_days: int = 120
    val_days: int = 30
    test_days: int = 30


def last_complete_utc_day_ms(reference_ms: int) -> int:
    """Return the UTC 00:00:00.000 timestamp of the last complete UTC day."""
    return (int(reference_ms) // ONE_DAY_MS) * ONE_DAY_MS


def compute_time_split_boundaries(
    end_utc_day_ms: int,
    train_days: int = 120,
    val_days: int = 30,
    test_days: int = 30,
) -> TimeSplitBoundaries:
    """
    Compute shared 180-day UTC boundaries ending at the last complete UTC day:
    120d train, 30d val, 30d test.
    """
    test_end_ms = last_complete_utc_day_ms(end_utc_day_ms)
    total_days = train_days + val_days + test_days
    start_ms = test_end_ms - total_days * ONE_DAY_MS
    train_end_ms = start_ms + train_days * ONE_DAY_MS
    val_end_ms = train_end_ms + val_days * ONE_DAY_MS
    return TimeSplitBoundaries(
        start_ms=start_ms,
        train_end_ms=train_end_ms,
        val_end_ms=val_end_ms,
        test_end_ms=test_end_ms,
        train_days=train_days,
        val_days=val_days,
        test_days=test_days,
    )


def aggregate_1m_to_1h_utc(
    df_1m: pd.DataFrame,
    cutoff_ms: int | None = None,
) -> tuple[pd.DataFrame, list[dict[str, Any]]]:
    """
    Aggregate closed 1-minute klines into UTC 1-hour klines.
    Rules:
    - Exclude unclosed 1m bars (is_final == False or open_time + 60_000 > cutoff_ms).
    - Exclude unclosed 1h buckets (hour_open_time + 3_600_000 > cutoff_ms).
    - Deduplicate by (symbol, open_time).
    - Only hours with exactly 60 closed 1-minute bars (aligned on 1m boundaries)
      are aggregated into a valid 1h bar. Incomplete hours are reported as gaps.
    """
    empty_cols = [
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
    if df_1m is None or df_1m.empty:
        return pd.DataFrame(columns=empty_cols), []

    df = df_1m.copy()
    if "is_final" in df.columns:
        df = df[df["is_final"].astype(bool)]

    df["open_time"] = df["open_time"].astype("int64")
    # Must be aligned to 1-minute boundary
    df = df[df["open_time"] % ONE_MINUTE_MS == 0]

    if cutoff_ms is not None:
        df = df[df["open_time"] + ONE_MINUTE_MS <= int(cutoff_ms)]

    if df.empty:
        return pd.DataFrame(columns=empty_cols), []

    # Filter out invalid OHLCV rows
    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    if "quote_volume" not in df.columns:
        df["quote_volume"] = df["volume"] * df["close"]
    else:
        df["quote_volume"] = pd.to_numeric(df["quote_volume"], errors="coerce")

    valid_mask = (
        np.isfinite(df[["open", "high", "low", "close", "volume", "quote_volume"]]).all(axis=1)
        & (df["open"] > 0)
        & (df["high"] >= df["low"])
        & (df["low"] > 0)
        & (df["close"] > 0)
        & (df["high"] >= df[["open", "close"]].max(axis=1))
        & (df["low"] <= df[["open", "close"]].min(axis=1))
        & (df["volume"] >= 0)
        & (df["quote_volume"] >= 0)
    )
    df = df[valid_mask]
    if df.empty:
        return pd.DataFrame(columns=empty_cols), []

    # Deduplicate (symbol, open_time), keeping latest
    sort_cols = ["symbol", "open_time"]
    if "recv_time" in df.columns:
        sort_cols.append("recv_time")
    df = df.sort_values(sort_cols).drop_duplicates(subset=["symbol", "open_time"], keep="last")

    df["hour_open_time"] = (df["open_time"] // ONE_HOUR_MS) * ONE_HOUR_MS
    if cutoff_ms is not None:
        df = df[df["hour_open_time"] + ONE_HOUR_MS <= int(cutoff_ms)]

    if df.empty:
        return pd.DataFrame(columns=empty_cols), []

    for opt_col in ["trades", "taker_buy_base", "taker_buy_quote"]:
        if opt_col not in df.columns:
            df[opt_col] = 0.0
        else:
            df[opt_col] = pd.to_numeric(df[opt_col], errors="coerce").fillna(0.0)

    df = df.sort_values(["symbol", "open_time"])
    grouped = df.groupby(["symbol", "hour_open_time"], as_index=False)

    agg_df = grouped.agg(
        bar_count=("open_time", "count"),
        first_min=("open_time", "min"),
        last_min=("open_time", "max"),
        open=("open", "first"),
        high=("high", "max"),
        low=("low", "min"),
        close=("close", "last"),
        volume=("volume", "sum"),
        quote_volume=("quote_volume", "sum"),
        trades=("trades", "sum"),
        taker_buy_base=("taker_buy_base", "sum"),
        taker_buy_quote=("taker_buy_quote", "sum"),
    )

    complete_mask = (
        (agg_df["bar_count"] == 60)
        & (agg_df["first_min"] == agg_df["hour_open_time"])
        & (agg_df["last_min"] == agg_df["hour_open_time"] + 59 * ONE_MINUTE_MS)
    )

    incomplete_rows = agg_df[~complete_mask]
    incomplete_gaps: list[dict[str, Any]] = []
    for _, row in incomplete_rows.iterrows():
        incomplete_gaps.append(
            {
                "symbol": str(row["symbol"]),
                "hour_open_time": int(row["hour_open_time"]),
                "bar_count": int(row["bar_count"]),
                "reason": f"incomplete_1m_hour({int(row['bar_count'])}/60)",
            }
        )

    valid_1h = agg_df[complete_mask].copy()
    if valid_1h.empty:
        return pd.DataFrame(columns=empty_cols), incomplete_gaps

    valid_1h = valid_1h.rename(columns={"hour_open_time": "open_time"})
    valid_1h["close_time"] = valid_1h["open_time"] + ONE_HOUR_MS - 1
    valid_1h["trades"] = valid_1h["trades"].astype("int64")
    valid_1h["is_final"] = True
    valid_1h["source"] = "local_1m_agg"

    return valid_1h[empty_cols].sort_values(["symbol", "open_time"]).reset_index(drop=True), incomplete_gaps


def _build_missing_gaps(missing: np.ndarray) -> list[dict[str, int]]:
    sym_gaps: list[dict[str, int]] = []
    if missing.size == 0:
        return sym_gaps
    gap_start = int(missing[0])
    prev_t = int(missing[0])
    for m_t in missing[1:]:
        m_int = int(m_t)
        if m_int == prev_t + ONE_HOUR_MS:
            prev_t = m_int
        else:
            sym_gaps.append(
                {
                    "from_time": gap_start,
                    "to_time": prev_t + ONE_HOUR_MS,
                    "missing_hours": (prev_t - gap_start) // ONE_HOUR_MS + 1,
                }
            )
            gap_start = m_int
            prev_t = m_int
    sym_gaps.append(
        {
            "from_time": gap_start,
            "to_time": prev_t + ONE_HOUR_MS,
            "missing_hours": (prev_t - gap_start) // ONE_HOUR_MS + 1,
        }
    )
    return sym_gaps


def validate_and_deduplicate_1h(
    df_1h: pd.DataFrame,
    cutoff_ms: int | None = None,
    expected_start_ms: int | None = None,
    expected_end_ms: int | None = None,
    filter_start_ms: int | None = None,
    expected_symbols: list[str] | None = None,
) -> tuple[pd.DataFrame, dict[str, list[dict[str, int]]]]:
    """
    Validate, filter out unclosed bars, deduplicate (preferring local_1m_agg over binance_rest_1h),
    and detect any missing 1h candles without fabricating or forward-filling prices.
    When filter_start_ms is provided, bars in [filter_start_ms, expected_start_ms) are kept as warmup
    while gap auditing is evaluated over [expected_start_ms, expected_end_ms).
    """
    required_cols = [
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

    def _empty_result() -> tuple[pd.DataFrame, dict[str, list[dict[str, int]]]]:
        empty_gaps: dict[str, list[dict[str, int]]] = {}
        if expected_symbols and expected_start_ms is not None and expected_end_ms is not None:
            full_grid = np.arange(int(expected_start_ms), int(expected_end_ms), ONE_HOUR_MS, dtype=np.int64)
            full_gap = _build_missing_gaps(full_grid)
            for s in expected_symbols:
                empty_gaps[str(s)] = list(full_gap)
        return pd.DataFrame(columns=required_cols), empty_gaps

    if df_1h is None or df_1h.empty:
        return _empty_result()

    df = df_1h.copy()
    if "is_final" in df.columns:
        df = df[df["is_final"].astype(bool)]
    else:
        df["is_final"] = True

    df["open_time"] = df["open_time"].astype("int64")
    df = df[df["open_time"] % ONE_HOUR_MS == 0]

    if cutoff_ms is not None:
        df = df[df["open_time"] + ONE_HOUR_MS <= int(cutoff_ms)]

    lower_bound_ms = filter_start_ms if filter_start_ms is not None else expected_start_ms
    if lower_bound_ms is not None:
        df = df[df["open_time"] >= int(lower_bound_ms)]
    if expected_end_ms is not None:
        df = df[df["open_time"] < int(expected_end_ms)]

    if df.empty:
        return _empty_result()

    for col in ["open", "high", "low", "close", "volume"]:
        df[col] = pd.to_numeric(df[col], errors="coerce")
    if "quote_volume" not in df.columns:
        df["quote_volume"] = df["volume"] * df["close"]
    else:
        df["quote_volume"] = pd.to_numeric(df["quote_volume"], errors="coerce")

    valid_mask = (
        np.isfinite(df[["open", "high", "low", "close", "volume", "quote_volume"]]).all(axis=1)
        & (df["open"] > 0)
        & (df["high"] >= df["low"])
        & (df["low"] > 0)
        & (df["close"] > 0)
        & (df["high"] >= df[["open", "close"]].max(axis=1))
        & (df["low"] <= df[["open", "close"]].min(axis=1))
        & (df["volume"] >= 0)
        & (df["quote_volume"] >= 0)
    )
    df = df[valid_mask].copy()
    if df.empty:
        return _empty_result()

    if "close_time" not in df.columns:
        df["close_time"] = df["open_time"] + ONE_HOUR_MS - 1
    if "source" not in df.columns:
        df["source"] = "binance_rest_1h"
    for opt_col in ["trades", "taker_buy_base", "taker_buy_quote"]:
        if opt_col not in df.columns:
            df[opt_col] = 0
    df["trades"] = pd.to_numeric(df["trades"], errors="coerce").fillna(0).astype("int64")
    df["taker_buy_base"] = pd.to_numeric(df["taker_buy_base"], errors="coerce").fillna(0.0)
    df["taker_buy_quote"] = pd.to_numeric(df["taker_buy_quote"], errors="coerce").fillna(0.0)

    # Prefer local_1m_agg over binance_rest_1h when deduplicating
    df["_source_priority"] = np.where(df["source"] == "local_1m_agg", 1, 0)
    df = (
        df.sort_values(["symbol", "open_time", "_source_priority"])
        .drop_duplicates(subset=["symbol", "open_time"], keep="last")
        .drop(columns=["_source_priority"])
        .sort_values(["symbol", "open_time"])
        .reset_index(drop=True)
    )

    gaps_by_symbol: dict[str, list[dict[str, int]]] = {}
    present_symbols = set()
    for sym, sym_df in df.groupby("symbol"):
        sym_str = str(sym)
        present_symbols.add(sym_str)
        times = sym_df["open_time"].to_numpy(dtype=np.int64)
        start_t = int(expected_start_ms) if expected_start_ms is not None else int(times[0])
        end_t = int(expected_end_ms) if expected_end_ms is not None else int(times[-1] + ONE_HOUR_MS)
        expected_grid = np.arange(start_t, end_t, ONE_HOUR_MS, dtype=np.int64)
        missing = np.setdiff1d(expected_grid, times, assume_unique=False)
        gaps_by_symbol[sym_str] = _build_missing_gaps(missing)

    if expected_symbols and expected_start_ms is not None and expected_end_ms is not None:
        full_grid = np.arange(int(expected_start_ms), int(expected_end_ms), ONE_HOUR_MS, dtype=np.int64)
        full_gap = _build_missing_gaps(full_grid)
        for s in expected_symbols:
            s_str = str(s)
            if s_str not in present_symbols:
                gaps_by_symbol[s_str] = list(full_gap)

    return df[required_cols], gaps_by_symbol


def _compute_rsi_14_causal(close_series: pd.Series, period: int = 14) -> pd.Series:
    """
    Compute 14-period RSI using simple rolling average of gains/losses over 14 consecutive bars
    so that any NaN in the 14-bar window invalidates only the affected window and remains strictly causal
    with a finite 14-bar memory. When both gain and loss are 0 (flat market), RSI = 50.0.
    """
    delta = close_series.diff(1)
    gain = delta.clip(lower=0.0)
    loss = (-delta).clip(lower=0.0)
    avg_gain = gain.rolling(window=period, min_periods=period).mean()
    avg_loss = loss.rolling(window=period, min_periods=period).mean()

    rs = avg_gain / avg_loss.replace(0.0, np.nan)
    rsi = 100.0 - (100.0 / (1.0 + rs))
    # Where avg_loss == 0 and avg_gain > 0 -> 100; where both == 0 -> 50
    both_zero = (avg_gain == 0.0) & (avg_loss == 0.0)
    loss_zero_only = (avg_loss == 0.0) & (avg_gain > 0.0)
    rsi = rsi.where(~loss_zero_only, 100.0)
    rsi = rsi.where(~both_zero, 50.0)
    return rsi


def _prepare_funding_lookup(
    df_funding: pd.DataFrame | None,
    cutoff_ms: int | None = None,
) -> dict[str, tuple[np.ndarray, np.ndarray]]:
    """
    Prepare sorted (funding_time_ms, funding_rate) arrays per symbol,
    filtering out any records with funding_time > cutoff_ms if cutoff_ms is provided.
    Retains same-minute updates until each decision's causal window is selected.
    """
    if df_funding is None or df_funding.empty:
        return {}
    f_df = df_funding.copy()
    f_df["funding_time"] = pd.to_numeric(f_df["funding_time"], errors="coerce")
    f_df["funding_rate"] = pd.to_numeric(f_df["funding_rate"], errors="coerce")
    f_df = f_df.dropna(subset=["symbol", "funding_time", "funding_rate"])
    f_df = f_df[np.isfinite(f_df["funding_rate"]) & np.isfinite(f_df["funding_time"])]
    if f_df.empty:
        return {}
    f_df["funding_time"] = f_df["funding_time"].astype("int64")
    if cutoff_ms is not None:
        f_df = f_df[f_df["funding_time"] <= int(cutoff_ms)]
    if f_df.empty:
        return {}
    f_df = f_df.sort_values(["symbol", "funding_time"], kind="stable").drop_duplicates(
        subset=["symbol", "funding_time"], keep="last"
    )
    lookup: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for sym, grp in f_df.groupby("symbol", sort=False):
        t_arr = grp["funding_time"].to_numpy(dtype=np.int64)
        r_arr = grp["funding_rate"].to_numpy(dtype=np.float64)
        lookup[str(sym)] = (t_arr, r_arr)
    return lookup


def _compute_causal_funding_features_for_symbol(
    open_times: np.ndarray,
    sym_funding: tuple[np.ndarray, np.ndarray] | None,
    window_ms: int = FUNDING_ZSCORE_WINDOW_MS,
    min_events: int = MIN_FUNDING_EVENTS_FOR_ZSCORE,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """
    Compute strictly causal funding rate features at each decision timestamp `decision_time = open_time + 1h`:
    - Only settlements with `funding_time <= decision_time` and `funding_time >= decision_time - window_ms` are used.
    - Missing funding or fewer than `min_events` settlements in the window yields NaN,
      allowing LightGBM to use its missing-value branches for otherwise price-valid rows.
    - Same-minute updates are deduplicated only after filtering to the decision's window.
    """
    n = len(open_times)
    latest_arr = np.full(n, np.nan, dtype=np.float64)
    zscore_arr = np.full(n, np.nan, dtype=np.float64)
    diff_arr = np.full(n, np.nan, dtype=np.float64)

    if sym_funding is None:
        return latest_arr, zscore_arr, diff_arr

    f_times, f_rates = sym_funding
    if len(f_times) < min_events:
        return latest_arr, zscore_arr, diff_arr

    decision_times = open_times.astype(np.int64) + ONE_HOUR_MS
    right_indices = np.searchsorted(f_times, decision_times, side="right")
    left_indices = np.searchsorted(f_times, decision_times - int(window_ms), side="left")

    for i in range(n):
        r_idx = int(right_indices[i])
        l_idx = int(left_indices[i])
        if r_idx - l_idx < min_events:
            continue
        # A later update (even decision_time + 1ms) must not remove a known
        # settlement before this causal slice is formed.
        minute_keys = (f_times[l_idx:r_idx] + 30_000) // ONE_MINUTE_MS
        keep_latest = np.r_[np.diff(minute_keys) != 0, True]
        window_rates = f_rates[l_idx:r_idx][keep_latest]
        if len(window_rates) < min_events:
            continue
        latest_val = float(window_rates[-1])
        mean_val = float(np.mean(window_rates))
        std_val = float(np.std(window_rates, ddof=1))
        latest_arr[i] = latest_val
        diff_arr[i] = latest_val - mean_val
        if std_val > 1e-12:
            zscore_arr[i] = float(np.clip((latest_val - mean_val) / std_val, -10.0, 10.0))
        else:
            zscore_arr[i] = 0.0

    return latest_arr, zscore_arr, diff_arr


def compute_features(
    df_1h: pd.DataFrame,
    cutoff_ms: int | None = None,
    df_funding: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """
    Compute strictly causal hourly features for LightGBM ranking, including:
    - Short/medium horizon returns & volatility (1h, 4h, 12h, 24h, 48h, 72h)
    - Macro timeframe trend features (4h & 24h rolling causal K-line structure & moving average distances/slopes)
    - Funding rate anomaly features (7-day rolling causal Z-Score, latest funding rate, deviation from 7d mean)
    Features at open_time `t` (decision time = close of hour `t`, i.e., `t + 3600_000`)
    use ONLY closed hourly bars in `[t - 96h, t]` and historical funding settlements with `funding_time <= t + 3600_000`.
    Any missing hourly bar inside `[t - 96h, t]` invalidates the features at `t` (set to NaN),
    never bridging across a gap or forward-filling missing candles.
    """
    if df_1h is None or df_1h.empty:
        return pd.DataFrame()

    clean_df, _ = validate_and_deduplicate_1h(df_1h, cutoff_ms=cutoff_ms)
    if clean_df.empty:
        return pd.DataFrame()

    has_funding_input = df_funding is not None and not df_funding.empty
    funding_lookup = _prepare_funding_lookup(df_funding, cutoff_ms=cutoff_ms) if has_funding_input else {}

    base_feature_cols = [
        "ret_1h",
        "ret_4h",
        "ret_12h",
        "ret_24h",
        "ret_48h",
        "ret_72h",
        "vol_24h",
        "vol_72h",
        "quote_vol_24h",
        "vol_ratio_1h",
        "amplitude_1h",
        "close_pos_1h",
        "dist_sma20",
        "dist_sma60",
        "rsi_14",
        "trend_4h_sma6_dist",
        "trend_4h_slope",
        "trend_24h_sma4_dist",
        "trend_24h_slope",
        "close_pos_24h",
        "amplitude_24h",
        "funding_rate_latest",
        "funding_rate_zscore_7d",
        "funding_rate_diff",
    ]

    per_symbol_frames: list[pd.DataFrame] = []
    for sym, sym_df in clean_df.groupby("symbol", sort=False):
        sym_str = str(sym)
        sym_df = sym_df.sort_values("open_time").reset_index(drop=True)
        min_t = int(sym_df["open_time"].min())
        max_t = int(sym_df["open_time"].max())
        full_grid = pd.Index(range(min_t, max_t + ONE_HOUR_MS, ONE_HOUR_MS), name="open_time", dtype="int64")

        # Reindex onto regular 1h grid WITHOUT forward-filling so gaps become NaNs
        grid_df = sym_df.set_index("open_time").reindex(full_grid)
        close = grid_df["close"]
        open_p = grid_df["open"]
        high = grid_df["high"]
        low = grid_df["low"]
        qvol = grid_df["quote_volume"]

        # Contiguous bar check: require all 97 bars [t-96h .. t] to be present
        present = close.notna().astype(float)
        contiguous_lookback = (
            present.rolling(window=FEATURE_LOOKBACK_HOURS + 1, min_periods=FEATURE_LOOKBACK_HOURS + 1).sum()
            == (FEATURE_LOOKBACK_HOURS + 1)
        )

        ret_1h = close / close.shift(1) - 1.0
        ret_4h = close / close.shift(4) - 1.0
        ret_12h = close / close.shift(12) - 1.0
        ret_24h = close / close.shift(24) - 1.0
        ret_48h = close / close.shift(48) - 1.0
        ret_72h = close / close.shift(72) - 1.0

        vol_24h = ret_1h.rolling(window=24, min_periods=24).std(ddof=1)
        vol_72h = ret_1h.rolling(window=72, min_periods=72).std(ddof=1)

        qvol_24h_sum = qvol.rolling(window=24, min_periods=24).sum()
        quote_vol_24h = np.log1p(qvol_24h_sum.clip(lower=0.0))
        qvol_24h_mean = qvol_24h_sum / 24.0
        vol_ratio_1h = np.where(qvol_24h_mean > 0, qvol / qvol_24h_mean, 0.0)

        amplitude_1h = (high - low) / open_p
        hl_range = high - low
        close_pos_1h = np.where(hl_range > 0, (close - low) / hl_range, 0.5)

        sma_20 = close.rolling(window=20, min_periods=20).mean()
        sma_60 = close.rolling(window=60, min_periods=60).mean()
        dist_sma20 = close / sma_20 - 1.0
        dist_sma60 = close / sma_60 - 1.0

        rsi_14 = _compute_rsi_14_causal(close, period=14)

        # Macro 4h & 24h causal trend features (sampled at 4h / 24h steps ending at closed hour t)
        sma_4h_6 = (
            close
            + close.shift(4)
            + close.shift(8)
            + close.shift(12)
            + close.shift(16)
            + close.shift(20)
        ) / 6.0
        trend_4h_sma6_dist = close / sma_4h_6 - 1.0
        trend_4h_slope = sma_4h_6 / sma_4h_6.shift(4) - 1.0

        sma_24h_4 = (close + close.shift(24) + close.shift(48) + close.shift(72)) / 4.0
        trend_24h_sma4_dist = close / sma_24h_4 - 1.0
        trend_24h_slope = sma_24h_4 / sma_24h_4.shift(24) - 1.0

        high_24h = high.rolling(window=24, min_periods=24).max()
        low_24h = low.rolling(window=24, min_periods=24).min()
        hl_range_24h = high_24h - low_24h
        close_pos_24h = np.where(hl_range_24h > 0, (close - low_24h) / hl_range_24h, 0.5)
        open_24h_ago = open_p.shift(23)
        amplitude_24h = (high_24h - low_24h) / open_24h_ago

        feat_df = pd.DataFrame(
            {
                "symbol": sym_str,
                "open_time": full_grid,
                "close_time": grid_df["close_time"],
                "open": open_p,
                "high": high,
                "low": low,
                "close": close,
                "volume": grid_df["volume"],
                "quote_volume": qvol,
                "source": grid_df["source"],
                "ret_1h": ret_1h,
                "ret_4h": ret_4h,
                "ret_12h": ret_12h,
                "ret_24h": ret_24h,
                "ret_48h": ret_48h,
                "ret_72h": ret_72h,
                "vol_24h": vol_24h,
                "vol_72h": vol_72h,
                "quote_vol_24h": quote_vol_24h,
                "vol_ratio_1h": pd.Series(vol_ratio_1h, index=full_grid),
                "amplitude_1h": amplitude_1h,
                "close_pos_1h": pd.Series(close_pos_1h, index=full_grid),
                "dist_sma20": dist_sma20,
                "dist_sma60": dist_sma60,
                "rsi_14": rsi_14,
                "trend_4h_sma6_dist": trend_4h_sma6_dist,
                "trend_4h_slope": trend_4h_slope,
                "trend_24h_sma4_dist": trend_24h_sma4_dist,
                "trend_24h_slope": trend_24h_slope,
                "close_pos_24h": pd.Series(close_pos_24h, index=full_grid),
                "amplitude_24h": amplitude_24h,
                "contiguous_73h": contiguous_lookback,
                "contiguous_lookback": contiguous_lookback,
            }
        )

        # Keep only actual existing bars
        feat_df = feat_df[feat_df["close"].notna()].copy()

        # Compute causal funding rate anomaly features for existing bars
        sym_funding_entry = (
            funding_lookup.get(sym_str, (np.array([], dtype=np.int64), np.array([], dtype=np.float64)))
            if has_funding_input
            else None
        )
        f_latest, f_zscore, f_diff = _compute_causal_funding_features_for_symbol(
            feat_df["open_time"].to_numpy(dtype=np.int64),
            sym_funding_entry,
        )
        feat_df["funding_rate_latest"] = f_latest
        feat_df["funding_rate_zscore_7d"] = f_zscore
        feat_df["funding_rate_diff"] = f_diff

        # Invalidate any feature row where the 96h lookback had a gap
        feat_df.loc[~feat_df["contiguous_lookback"], base_feature_cols] = np.nan
        per_symbol_frames.append(feat_df.reset_index(drop=True))

    combined = pd.concat(per_symbol_frames, ignore_index=True)
    combined = combined.sort_values(["open_time", "symbol"]).reset_index(drop=True)

    # Funding is optional: missing funding must not invalidate complete price history
    # or remove symbols from price cross-sectional ranks and model inference.
    price_feature_cols = [col for col in base_feature_cols if not col.startswith("funding_rate_")]
    valid_base = combined[price_feature_cols].notna().all(axis=1)
    combined["features_valid"] = valid_base

    for src_col, rank_col in [
        ("ret_1h", "cs_rank_ret_1h"),
        ("ret_4h", "cs_rank_ret_4h"),
        ("ret_24h", "cs_rank_ret_24h"),
        ("ret_72h", "cs_rank_ret_72h"),
        ("quote_vol_24h", "cs_rank_quote_vol_24h"),
        ("funding_rate_zscore_7d", "cs_rank_funding_zscore_7d"),
    ]:
        masked_vals = combined[src_col].where(valid_base, np.nan)
        combined[rank_col] = masked_vals.groupby(combined["open_time"]).rank(pct=True, method="average")

    return combined


def compute_forward_labels(
    df_features: pd.DataFrame,
    df_funding: pd.DataFrame | None = None,
    fee_bps: float = 5.0,
    slippage_bps: float = 5.0,
    holding_hours: int = HOLDING_HOURS,
) -> pd.DataFrame:
    """
    Compute 4-hour forward labels and net returns:
    - Decision at close of candle `t` (open_time = t, decision_time = t + 1h).
    - Entry at open of candle `t + 1h` (entry_time = t + 1h).
    - Exit at open of candle `t + 1h + holding_hours` (exit_time = t + 5h).
    - Requires all future bars t+1h .. t+5h to exist without gaps.
    - Also computes 4th future candle close return `(close[t+4h] - close[t]) / close[t]` for Kronos evaluation.
    - Costs: 1x leverage, one-way fee = 5 bps, one-way adverse slippage = 5 bps (round-trip = 20 bps).
    - Funding fee: actual settlement timestamps in `(entry_time, exit_time]`.
      Rounded timestamps are used only for schedule coverage checks, never cost summation.
      The shortest locally observed 1h/4h/8h cadence is checked conservatively.
      If an expected settlement boundary in `(entry_time, exit_time]` is missing from `df_funding`
      (or `df_funding` has no coverage for that symbol), `funding_missing = True` and net returns are `NaN`
      (never treated as zero cost).
    """
    if df_features is None or df_features.empty:
        return pd.DataFrame()

    df = df_features.copy().sort_values(["symbol", "open_time"]).reset_index(drop=True)
    round_trip_cost = 2.0 * (float(fee_bps) + float(slippage_bps)) / 10_000.0

    # Prepare normalized funding map per symbol: symbol -> dict[normalized_minute_ms, float]
    funding_map: dict[str, dict[int, float]] = {}
    actual_funding_map: dict[str, pd.DataFrame] = {}
    if df_funding is not None and not df_funding.empty:
        f_df = df_funding.copy()
        f_df["funding_time"] = pd.to_numeric(f_df["funding_time"], errors="coerce")
        f_df["funding_rate"] = pd.to_numeric(f_df["funding_rate"], errors="coerce")
        f_df = f_df.dropna(subset=["symbol", "funding_time", "funding_rate"])
        # Normalize funding_time to nearest minute (Binance sometimes emits 08:00:00.001)
        f_df["norm_time"] = ((f_df["funding_time"].astype("int64") + 30_000) // ONE_MINUTE_MS) * ONE_MINUTE_MS
        f_df = f_df.sort_values(["symbol", "funding_time"]).drop_duplicates(subset=["symbol", "norm_time"], keep="last")
        for sym, grp in f_df.groupby("symbol"):
            actual_funding_map[str(sym)] = grp
            funding_map[str(sym)] = dict(
                zip(grp["norm_time"].astype("int64").tolist(), grp["funding_rate"].astype(float).tolist())
            )

    out_frames: list[pd.DataFrame] = []
    for sym, sym_df in df.groupby("symbol", sort=False):
        sym_df = sym_df.sort_values("open_time").reset_index(drop=True)
        min_t = int(sym_df["open_time"].min())
        max_t = int(sym_df["open_time"].max())
        full_grid = pd.Index(range(min_t, max_t + ONE_HOUR_MS, ONE_HOUR_MS), name="open_time", dtype="int64")
        grid_df = sym_df.set_index("open_time").reindex(full_grid)

        open_s = grid_df["open"]
        close_s = grid_df["close"]

        # Check that t+1h .. t+(holding_hours+1)h all exist for open-to-open return
        present = close_s.notna().astype(float)
        # Forward contiguous check for bars t+1 .. t+holding_hours+1
        future_bars_needed = holding_hours + 1  # e.g. t+1, t+2, t+3, t+4, t+5
        future_open_valid = pd.Series(True, index=full_grid)
        for step in range(1, future_bars_needed + 1):
            future_open_valid = future_open_valid & (present.shift(-step) == 1.0)

        # Forward contiguous check for bars t+1 .. t+holding_hours (for 4th candle close return)
        future_close_valid = pd.Series(True, index=full_grid)
        for step in range(1, holding_hours + 1):
            future_close_valid = future_close_valid & (present.shift(-step) == 1.0)

        entry_price = open_s.shift(-1).where(future_open_valid, np.nan)
        exit_price = open_s.shift(-(holding_hours + 1)).where(future_open_valid, np.nan)
        close_4h = close_s.shift(-holding_hours).where(future_close_valid, np.nan)

        gross_ret_long = (exit_price - entry_price) / entry_price
        gross_ret_short = (entry_price - exit_price) / entry_price
        ret_close_4h = (close_4h - close_s) / close_s

        sym_funding = funding_map.get(str(sym), {})
        sym_funding_times = np.array(sorted(sym_funding.keys()), dtype=np.int64) if sym_funding else np.array([], dtype=np.int64)
        actual_funding = actual_funding_map.get(str(sym))
        actual_times_f = actual_funding["funding_time"].to_numpy(dtype=np.int64) if actual_funding is not None else np.array([], dtype=np.int64)
        actual_rates_f = actual_funding["funding_rate"].to_numpy(dtype=float) if actual_funding is not None else np.array([], dtype=float)
        actual_marks_f = (
            pd.to_numeric(actual_funding["mark_price"], errors="coerce").to_numpy(dtype=float)
            if actual_funding is not None and "mark_price" in actual_funding.columns
            else np.full(len(actual_times_f), np.nan, dtype=np.float64)
        )

        # Restrict back to actual rows in sym_df
        actual_times = sym_df["open_time"].to_numpy(dtype=np.int64)
        n_rows = len(actual_times)
        funding_rate_sum = np.full(n_rows, np.nan, dtype=np.float64)
        funding_cost_return = np.full(n_rows, np.nan, dtype=np.float64)
        funding_missing = np.zeros(n_rows, dtype=bool)

        for idx, t_open in enumerate(actual_times):
            entry_t = int(t_open) + ONE_HOUR_MS
            exit_t = int(t_open) + (holding_hours + 1) * ONE_HOUR_MS

            if len(sym_funding_times) == 0:
                funding_missing[idx] = True
                continue

            # A fixed 8h check misses missing settlements on 1h/4h contracts.
            # Use nearby observations, rather than applying a later cadence to all history.
            nearby = sym_funding_times[
                (sym_funding_times >= entry_t - EIGHT_HOURS_MS)
                & (sym_funding_times <= exit_t + EIGHT_HOURS_MS)
            ]
            deltas = np.diff(nearby)
            observed = [int(d) for d in deltas if d in (ONE_HOUR_MS, 4 * ONE_HOUR_MS, EIGHT_HOURS_MS)]
            cadence = min(observed, default=EIGHT_HOURS_MS)
            first_boundary = ((entry_t // cadence) + 1) * cadence
            expected_boundaries = range(first_boundary, exit_t + 1, cadence)
            if any(b_ts not in sym_funding for b_ts in expected_boundaries):
                funding_missing[idx] = True
                continue

            # Without a settlement in the holding interval, require BOTH surrounding
            # boundaries to establish coverage before treating funding as zero.
            if not expected_boundaries:
                prev_boundary = (entry_t // cadence) * cadence
                next_boundary = prev_boundary + cadence
                if prev_boundary not in sym_funding or next_boundary not in sym_funding:
                    funding_missing[idx] = True
                    continue

            # Keep actual millisecond boundaries: e.g. entry+1ms is charged,
            # exit+1ms is excluded. Rounding would reverse both cases.
            left_i = np.searchsorted(actual_times_f, entry_t, side="right")
            right_i = np.searchsorted(actual_times_f, exit_t, side="right")
            f_sum = float(actual_rates_f[left_i:right_i].sum())
            interval_rates = actual_rates_f[left_i:right_i]
            interval_marks = actual_marks_f[left_i:right_i]
            entry_px = float(entry_price.reindex(actual_times).iloc[idx])
            if (not np.isfinite(f_sum) or not np.isfinite(entry_px) or entry_px <= 0
                    or not np.isfinite(interval_marks).all() or (interval_marks <= 0).any()):
                funding_missing[idx] = True
            else:
                funding_rate_sum[idx] = float(f_sum)
                funding_cost_return[idx] = float(np.sum(interval_rates * interval_marks / entry_px))

        sym_out = sym_df.copy()
        sym_out["decision_time"] = sym_out["open_time"] + ONE_HOUR_MS
        sym_out["entry_time"] = sym_out["open_time"] + ONE_HOUR_MS
        sym_out["exit_time"] = sym_out["open_time"] + (holding_hours + 1) * ONE_HOUR_MS
        sym_out["entry_price"] = entry_price.reindex(actual_times).to_numpy()
        sym_out["exit_price"] = exit_price.reindex(actual_times).to_numpy()
        sym_out["close_4h"] = close_4h.reindex(actual_times).to_numpy()
        sym_out["gross_return_long"] = gross_ret_long.reindex(actual_times).to_numpy()
        sym_out["gross_return_short"] = gross_ret_short.reindex(actual_times).to_numpy()
        sym_out["ret_close_4h"] = ret_close_4h.reindex(actual_times).to_numpy()
        sym_out["round_trip_cost"] = round_trip_cost
        sym_out["funding_rate_sum"] = funding_rate_sum
        sym_out["funding_cost_return"] = funding_cost_return
        sym_out["funding_missing"] = funding_missing

        # Net returns:
        # Convert each settlement to entry-notional return: rate * mark price / entry price.
        # If funding_missing is True, net returns are NaN (excluded from complete net performance).
        valid_net = (~sym_out["funding_missing"]) & sym_out["gross_return_long"].notna()
        sym_out["net_return_long"] = np.where(
            valid_net,
            sym_out["gross_return_long"] - round_trip_cost - sym_out["funding_cost_return"],
            np.nan,
        )
        sym_out["net_return_short"] = np.where(
            valid_net,
            sym_out["gross_return_short"] - round_trip_cost + sym_out["funding_cost_return"],
            np.nan,
        )

        out_frames.append(sym_out)

    result = pd.concat(out_frames, ignore_index=True)
    return result.sort_values(["open_time", "symbol"]).reset_index(drop=True)


def assign_time_splits(
    df: pd.DataFrame,
    boundaries: TimeSplitBoundaries,
) -> pd.DataFrame:
    """
    Assign each row to 'train', 'val', 'test', or 'out_of_range' based on `open_time`,
    and flag `crosses_split_boundary = True` whenever `exit_time` crosses the end of that split!
    Rows with `crosses_split_boundary == True` must be excluded from training, validation, and testing labels.
    """
    if df is None or df.empty:
        return pd.DataFrame()

    out = df.copy()
    t = out["open_time"].astype("int64")
    exit_t = out["exit_time"].astype("int64")

    split = np.full(len(out), "out_of_range", dtype=object)
    split_end = np.full(len(out), -1, dtype=np.int64)

    in_train = (t >= boundaries.start_ms) & (t < boundaries.train_end_ms)
    in_val = (t >= boundaries.train_end_ms) & (t < boundaries.val_end_ms)
    in_test = (t >= boundaries.val_end_ms) & (t < boundaries.test_end_ms)

    split[in_train] = "train"
    split_end[in_train] = boundaries.train_end_ms

    split[in_val] = "val"
    split_end[in_val] = boundaries.val_end_ms

    split[in_test] = "test"
    split_end[in_test] = boundaries.test_end_ms

    out["split"] = split
    # The open at split_end belongs to the NEXT split, even if exit_t equals it.
    out["crosses_split_boundary"] = (split_end > 0) & (exit_t >= split_end)
    return out


def assign_relevance_grades(
    df: pd.DataFrame,
    min_group_size: int = MIN_ELIGIBLE_SYMBOLS_PER_GROUP,
) -> pd.DataFrame:
    """
    For each decision timestamp (`open_time`), check how many symbols have:
    - valid features (`features_valid == True`)
    - non-missing net returns (`net_return_long.notna()` and `net_return_short.notna()`)
    - not crossing split boundaries (`crosses_split_boundary == False`)
    - in a valid split (`split in ('train', 'val', 'test')`)

    If a decision timestamp has `< min_group_size` (default 10) eligible symbols,
    `group_eligible = False` and that timestamp is skipped for ranking.
    Otherwise, assign 0..4 relevance grades (5 levels) within each `open_time` group
    for both Long (`label_long`) and Short (`label_short`).
    """
    if df is None or df.empty:
        return pd.DataFrame()

    out = df.copy().sort_values(["open_time", "symbol"]).reset_index(drop=True)
    row_eligible = (
        out["features_valid"].astype(bool)
        & out["net_return_long"].notna()
        & out["net_return_short"].notna()
        & (~out["crosses_split_boundary"].astype(bool))
        & out["split"].isin(["train", "val", "test"])
    )
    out["row_eligible"] = row_eligible

    group_counts = out.groupby("open_time")["row_eligible"].transform("sum").astype("int64")
    out["eligible_group_size"] = group_counts
    out["group_eligible"] = out["row_eligible"] & (group_counts >= int(min_group_size))

    out["label_long"] = np.nan
    out["label_short"] = np.nan

    eligible_idx = out.index[out["group_eligible"]]
    if len(eligible_idx) == 0:
        return out

    def _to_5_grades(series: pd.Series) -> pd.Series:
        # Percentile rank in (0, 1] -> map deterministically to 0, 1, 2, 3, 4
        # Using rank(method='first') on tie-broken sorted symbols ensures all 5 buckets are balanced
        n = len(series)
        ranks = series.rank(method="average", ascending=True) - 1.0  # 0 .. n-1
        grades = np.floor((ranks / max(n, 1)) * 5.0).clip(0, 4).astype("int64")
        return pd.Series(grades, index=series.index)

    eligible_sub = out.loc[eligible_idx]
    out.loc[eligible_idx, "label_long"] = (
        eligible_sub.groupby("open_time", group_keys=False)["net_return_long"].apply(_to_5_grades)
    )
    out.loc[eligible_idx, "label_short"] = (
        eligible_sub.groupby("open_time", group_keys=False)["net_return_short"].apply(_to_5_grades)
    )

    return out


def build_research_panel(
    df_1h: pd.DataFrame,
    df_funding: pd.DataFrame | None,
    boundaries: TimeSplitBoundaries,
    cutoff_ms: int | None = None,
    fee_bps: float = 5.0,
    slippage_bps: float = 5.0,
    min_group_size: int = MIN_ELIGIBLE_SYMBOLS_PER_GROUP,
) -> pd.DataFrame:
    """Full pipeline: features -> forward labels -> split assignment -> relevance grades."""
    effective_cutoff = cutoff_ms if cutoff_ms is not None else boundaries.test_end_ms
    feat_df = compute_features(df_1h, cutoff_ms=effective_cutoff, df_funding=df_funding)
    if feat_df.empty:
        return pd.DataFrame(columns=["symbol", "open_time", "split", "group_eligible", "features_valid",
                                     "crosses_split_boundary", "funding_missing"])
    labeled_df = compute_forward_labels(
        feat_df,
        df_funding=df_funding,
        fee_bps=fee_bps,
        slippage_bps=slippage_bps,
    )
    split_df = assign_time_splits(labeled_df, boundaries=boundaries)
    panel_df = assign_relevance_grades(split_df, min_group_size=min_group_size)
    return panel_df
