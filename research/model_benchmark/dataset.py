"""Read-only v3 source validation and frozen shared prediction cohort."""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from research.model_research.features_and_labels import (
    FEATURE_COLUMNS, MIN_ELIGIBLE_SYMBOLS_PER_GROUP, ONE_DAY_MS, ONE_HOUR_MS,
)
from .common import atomic_json, hash_file
from .config import SOURCE_ROOT, dataset_identity


def load_source(source_root: Path = SOURCE_ROOT) -> tuple[pd.DataFrame, pd.DataFrame, dict[str, Any]]:
    identity = dataset_identity(source_root)
    ds = source_root / "datasets"
    panel = pd.read_parquet(ds / "research_panel.parquet")
    klines = pd.read_parquet(ds / "klines_1h.parquet")
    required = {"symbol", "open_time", "decision_time", "split", "features_valid", "crosses_split_boundary",
                "row_eligible", "group_eligible", "label_long", "label_short", "ret_close_4h", "net_return_long",
                "net_return_short", "close", *FEATURE_COLUMNS}
    missing = required.difference(panel.columns)
    if missing:
        raise ValueError(f"research panel missing required fields: {sorted(missing)}")
    if panel.duplicated(["symbol", "open_time"]).any():
        raise ValueError("duplicate symbol/open_time rows in immutable research panel")
    if not set(panel["split"].dropna().astype(str)).issubset({"train", "val", "test", "out_of_range"}):
        raise ValueError("unexpected split labels")
    if identity.get("panel_rows") != len(panel) or identity.get("test_rows") != int(panel["split"].eq("test").sum()):
        raise ValueError("panel row/split counts do not match v3 manifest")
    return panel, klines, identity


def build_common_cohort(panel: pd.DataFrame, klines: pd.DataFrame, *, min_symbols: int = MIN_ELIGIBLE_SYMBOLS_PER_GROUP) -> pd.DataFrame:
    """Fix daily UTC 00:00 test cohort with 256 contiguous closed bars and full groups."""
    candidates = panel.loc[
        panel["split"].eq("test") & panel["features_valid"].astype(bool)
        & ~panel["crosses_split_boundary"].astype(bool)
        & panel["row_eligible"].astype(bool) & panel["group_eligible"].astype(bool)
        & panel["ret_close_4h"].notna()
        & panel["decision_time"].mod(ONE_DAY_MS).eq(0)
    ].copy()
    candle = klines.loc[klines.get("is_final", True).astype(bool) if isinstance(klines.get("is_final", True), pd.Series) else np.ones(len(klines), dtype=bool), ["symbol", "open_time"]]
    candle = candle.drop_duplicates().sort_values(["symbol", "open_time"])
    by_symbol: dict[str, np.ndarray] = {str(s): g["open_time"].to_numpy(dtype=np.int64) for s, g in candle.groupby("symbol", sort=False)}
    valid: list[bool] = []
    for row in candidates[["symbol", "open_time"]].itertuples(index=False):
        times = by_symbol.get(str(row.symbol), np.empty(0, dtype=np.int64))
        end = int(row.open_time)
        start = end - 255 * ONE_HOUR_MS
        left = int(np.searchsorted(times, start, side="left"))
        right = int(np.searchsorted(times, end, side="right"))
        window = times[left:right]
        valid.append(len(window) == 256 and int(window[0]) == start and int(window[-1]) == end and bool(np.all(np.diff(window) == ONE_HOUR_MS)))
    candidates = candidates.loc[valid].copy()
    candidates["decision_time"] = candidates["decision_time"].astype("int64")
    group_size = candidates.groupby("decision_time")["symbol"].transform("nunique")
    cohort = candidates.loc[group_size >= min_symbols].sort_values(["decision_time", "symbol"]).reset_index(drop=True)
    if cohort.empty:
        raise ValueError("no shared daily UTC 00:00 groups with 256 contiguous bars and >=10 symbols")
    # Stable decision key is derived from the test source, independent of model predictions.
    return cohort


def freeze_common_cohort(panel: pd.DataFrame, klines: pd.DataFrame, run_dir: Path, source_identity: dict[str, Any], *, smoke: bool = False) -> tuple[pd.DataFrame, dict[str, Any]]:
    manifest_path = run_dir / "common_cohort.json"
    cohort = build_common_cohort(panel, klines)
    if smoke:
        first_groups = sorted(cohort["decision_time"].unique())[:2]
        cohort = cohort.loc[cohort["decision_time"].isin(first_groups)].copy().reset_index(drop=True)
    records = cohort[["symbol", "open_time", "decision_time"]].to_dict(orient="records")
    payload = {"schema": 1, "smoke": smoke, "source_identity": source_identity, "rows": records}
    if manifest_path.exists():
        old = json.loads(manifest_path.read_text(encoding="utf-8"))
        if old != payload:
            raise ValueError("frozen common cohort differs from this run's immutable source")
    else:
        atomic_json(manifest_path, payload)
    return cohort, {"path": str(manifest_path), "sha256": hash_file(manifest_path), "rows": len(cohort), "groups": int(cohort.decision_time.nunique()), "symbols": int(cohort.symbol.nunique())}
