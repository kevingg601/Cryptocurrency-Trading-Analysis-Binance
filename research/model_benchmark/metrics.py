"""Shared offline evaluation for rankers and forecasters."""
from __future__ import annotations

from typing import Any
import numpy as np
import pandas as pd


def _ndcg(grades: np.ndarray, scores: np.ndarray, k: int = 5) -> float:
    # Matches sklearn.metrics.ndcg_score(ignore_ties=False), used in ranker selection.
    n = len(grades)
    if not n:
        return 0.0
    k = min(k, n)
    discounts = 1.0 / np.log2(np.arange(2, k + 2, dtype=float))
    all_discounts = np.zeros(n, dtype=float)
    all_discounts[:k] = discounts
    idcg = float(np.dot(np.sort(grades)[::-1][:k], discounts))
    if idcg == 0:
        return 1.0
    order = np.argsort(-scores, kind="stable")
    tied_scores = scores[order]
    tied_grades = grades[order]
    dcg = 0.0
    start = 0
    while start < n and start < k:
        end = start + 1
        while end < n and tied_scores[end] == tied_scores[start]:
            end += 1
        dcg += float(np.sum(tied_grades[start:end])) * float(np.mean(all_discounts[start:end]))
        start = end
    return dcg / idcg


def _safe_corr(x: np.ndarray, y: np.ndarray) -> float | None:
    if len(x) < 2 or np.std(x) == 0 or np.std(y) == 0:
        return None
    return float(np.corrcoef(x, y)[0, 1])


def evaluate_ranker(pred: pd.DataFrame, panel: pd.DataFrame) -> dict[str, Any]:
    required = {"symbol", "open_time", "score_long", "score_short"}
    if required.difference(pred.columns):
        raise ValueError(f"rank predictions missing: {sorted(required.difference(pred.columns))}")
    if pred.duplicated(["symbol", "open_time"]).any():
        raise ValueError("duplicate prediction symbol/open_time")
    actual_cols = ["symbol", "open_time", "split", "row_eligible", "label_long", "label_short", "net_return_long", "net_return_short"]
    joined = pred.merge(panel[actual_cols], on=["symbol", "open_time"], how="left", validate="one_to_one", indicator=True)
    joined = joined.loc[joined["_merge"].eq("both") & joined["split"].eq("test") & joined["row_eligible"].astype(bool)].copy()
    groups = []
    for open_time, group in joined.groupby("open_time", sort=True):
        if len(group) < 10:
            continue
        for direction, score_col, grade_col, ret_col in (
            ("long", "score_long", "label_long", "net_return_long"),
            ("short", "score_short", "label_short", "net_return_short"),
        ):
            valid = group[[score_col, grade_col, ret_col]].replace([np.inf, -np.inf], np.nan).dropna()
            if len(valid) < 10:
                continue
            ranked = valid.sort_values(score_col, ascending=False, kind="stable")
            top = ranked.head(5)
            groups.append({"open_time": int(open_time), "direction": direction, "ndcg": _ndcg(valid[grade_col].to_numpy(float), valid[score_col].to_numpy(float)),
                           "ic": _safe_corr(valid[score_col].rank(method="average").to_numpy(float), valid[ret_col].rank(method="average").to_numpy(float)),
                           "top5_mean_net_return": float(top[ret_col].mean()), "top5_positive_ratio": float((top[ret_col] > 0).mean()),
                           "n": len(valid)})
    out: dict[str, Any] = {"evaluated_groups": len({r["open_time"] for r in groups}), "prediction_rows": len(pred), "eligible_prediction_rows": len(joined), "directions": {}}
    for direction in ("long", "short"):
        rows = [r for r in groups if r["direction"] == direction]
        out["directions"][direction] = {
            "ndcg_at_5": float(np.mean([r["ndcg"] for r in rows])) if rows else None,
            "ic": float(np.nanmean([r["ic"] for r in rows if r["ic"] is not None])) if any(r["ic"] is not None for r in rows) else None,
            "top5_mean_net_return": float(np.mean([r["top5_mean_net_return"] for r in rows])) if rows else None,
            "top5_positive_ratio": float(np.mean([r["top5_positive_ratio"] for r in rows])) if rows else None,
            "groups": len(rows),
        }
    return out


def evaluate_forecaster(pred: pd.DataFrame, panel: pd.DataFrame) -> dict[str, Any]:
    required = {"symbol", "open_time", "pred_close_4h", "pred_return_4h"}
    if required.difference(pred.columns):
        raise ValueError(f"forecast predictions missing: {sorted(required.difference(pred.columns))}")
    variant_col = "variant" if "variant" in pred.columns else None
    unique_key = ["symbol", "open_time", "variant"] if variant_col else ["symbol", "open_time"]
    if pred.duplicated(unique_key).any():
        raise ValueError(f"duplicate forecast prediction keys: {unique_key}")
    base = panel[["symbol", "open_time", "split", "close", "close_4h", "ret_close_4h", "ret_4h",
                  "label_long", "label_short", "net_return_long", "net_return_short", "row_eligible"]]
    joined = pred.merge(base, on=["symbol", "open_time"], how="left", validate="many_to_one")
    joined = joined.loc[joined["split"].eq("test") & joined["row_eligible"].astype(bool)].dropna(
        subset=["pred_return_4h", "pred_close_4h", "ret_close_4h", "close", "close_4h", "net_return_long", "net_return_short"])
    joined = joined.loc[np.isfinite(joined[["pred_return_4h", "pred_close_4h", "ret_close_4h", "close", "close_4h"]]).all(axis=1) & joined["pred_close_4h"].gt(0)]
    def summarize(frame: pd.DataFrame) -> dict[str, Any]:
        actual = frame["ret_close_4h"].to_numpy(dtype=float)
        predicted = frame["pred_return_4h"].to_numpy(dtype=float)
        momentum = frame["ret_4h"].to_numpy(dtype=float)
        directional = actual != 0
        pred_sign = np.sign(predicted[directional])
        actual_sign = np.sign(actual[directional])
        momentum_sign = np.sign(momentum[directional])
        ranking_input = frame[["symbol", "open_time", "variant"]].copy() if "variant" in frame else frame[["symbol", "open_time"]].copy()
        ranking_input["score_long"] = predicted
        ranking_input["score_short"] = -predicted
        ranking_metrics = evaluate_ranker(ranking_input, panel)
        return {
            "samples": int(len(frame)),
            "return_mae": float(np.mean(np.abs(predicted - actual))) if len(actual) else None,
            "directional_accuracy": float(np.mean(pred_sign == actual_sign)) if len(actual_sign) else None,
            "valid_direction_count": int(np.sum(directional)),
            "no_change_return_mae": float(np.mean(np.abs(actual))) if len(actual) else None,
            "no_change_directional_accuracy": None,
            "momentum_return_mae": float(np.mean(np.abs(momentum - actual))) if len(actual) else None,
            "momentum_directional_accuracy": float(np.mean(momentum_sign == actual_sign)) if len(actual_sign) else None,
            "ranking": ranking_metrics,
        }
    if variant_col:
        variants = {str(variant): summarize(frame) for variant, frame in joined.groupby(variant_col, sort=True)}
        primary = variants.get("finetuned", next(iter(variants.values()), summarize(joined.iloc[0:0])))
        return {**primary, "variants": variants}
    return summarize(joined)


def evaluate_common(predictions: dict[str, pd.DataFrame], cohort: pd.DataFrame, panel: pd.DataFrame) -> dict[str, Any]:
    expected = set((str(s), int(t)) for s, t in cohort[["symbol", "open_time"]].itertuples(index=False, name=None))
    available: dict[tuple[str, str], set[tuple[str, int]]] = {}
    coverage: dict[str, dict[str, Any]] = {}
    for model, df in predictions.items():
        variants = df["variant"].astype(str).unique().tolist() if "variant" in df else ["default"]
        coverage[model] = {}
        for variant in variants:
            subset = df.loc[df["variant"].astype(str).eq(variant)].copy() if "variant" in df else df.copy()
            if {"pred_return_4h", "pred_close_4h"}.issubset(subset.columns):
                numeric = subset[["pred_return_4h", "pred_close_4h"]].to_numpy(dtype=float)
                valid_mask = np.isfinite(numeric).all(axis=1) & subset["pred_close_4h"].gt(0).to_numpy()
            elif {"score_long", "score_short"}.issubset(subset.columns):
                valid_mask = np.isfinite(subset[["score_long", "score_short"]].to_numpy(dtype=float)).all(axis=1)
            else:
                valid_mask = np.zeros(len(subset), dtype=bool)
            valid_df = subset.loc[valid_mask]
            valid_pairs = set((str(s), int(t)) for s, t in valid_df[["symbol", "open_time"]].itertuples(index=False, name=None))
            available[(model, variant)] = valid_pairs
            coverage[model][variant] = {"expected_pairs": len(expected), "valid_pairs": len(expected.intersection(valid_pairs)),
                                        "missing_pairs": len(expected.difference(valid_pairs))}
    inter = expected.intersection(*available.values()) if available else set()
    pair_frame = pd.DataFrame(sorted(inter), columns=["symbol", "open_time"])
    if len(pair_frame):
        counts = pair_frame.groupby("open_time")["symbol"].transform("nunique")
        pair_frame = pair_frame.loc[counts >= 10].sort_values(["open_time", "symbol"])
    metric_map = {}
    by_key = {k: d.merge(pair_frame, on=["symbol", "open_time"], how="inner") for k, d in predictions.items()}
    for key, df in by_key.items():
        metric_map[key] = evaluate_forecaster(df, panel) if "pred_return_4h" in df else evaluate_ranker(df, panel)
    return {"cohort_pairs": len(cohort), "intersection_pairs": len(pair_frame), "excluded_pairs": len(cohort) - len(pair_frame),
            "intersection_groups": int(pair_frame.open_time.nunique()) if len(pair_frame) else 0,
            "coverage_by_model_variant": coverage, "models": metric_map}
