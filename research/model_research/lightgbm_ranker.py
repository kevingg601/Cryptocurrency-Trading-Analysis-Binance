"""
LightGBM Lambdarank dual rankers (Long & Short) training, validation selection,
evaluation metrics, and cutoff ranking inference.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import time
import uuid
from pathlib import Path
from typing import Any
import lightgbm as lgb
import numpy as np
import pandas as pd
from scipy.stats import spearmanr
from sklearn.metrics import ndcg_score

from .features_and_labels import FEATURE_COLUMNS, MIN_ELIGIBLE_SYMBOLS_PER_GROUP

SEED = 42
LEARNING_RATE = 0.03
N_ESTIMATORS = 500
MIN_BOOST_ROUNDS = 10
EARLY_STOPPING_ROUNDS = 50
PARAM_GRID: list[dict[str, int]] = [
    {"num_leaves": 15, "min_child_samples": 50},
    {"num_leaves": 15, "min_child_samples": 100},
    {"num_leaves": 31, "min_child_samples": 50},
    {"num_leaves": 31, "min_child_samples": 100},
]


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def _prepare_groups(df_split: pd.DataFrame, label_col: str) -> tuple[pd.DataFrame, np.ndarray, list[int], pd.DataFrame]:
    """
    Sort by `open_time`, `symbol` and extract feature matrix X, relevance labels y,
    and group sizes for LGBMRanker.
    """
    ordered = df_split.sort_values(["open_time", "symbol"]).reset_index(drop=True)
    X = ordered[FEATURE_COLUMNS].astype(np.float64)
    y = ordered[label_col].to_numpy(dtype=np.int64)
    group_sizes = ordered.groupby("open_time", sort=True).size().astype(int).tolist()
    return X, y, group_sizes, ordered


def compute_group_ndcg_at_k(y_true_grades: np.ndarray, y_scores: np.ndarray, k: int = 5) -> float:
    """Compute NDCG@k for a single decision timestamp group."""
    if len(y_true_grades) < 2:
        return 0.0
    if np.all(y_true_grades == y_true_grades[0]):
        return 1.0
    return float(
        ndcg_score(
            y_true=y_true_grades.reshape(1, -1),
            y_score=y_scores.reshape(1, -1),
            k=min(k, len(y_true_grades)),
        )
    )


def evaluate_ranking_split(
    df_split: pd.DataFrame,
    scores_long: np.ndarray,
    scores_short: np.ndarray,
    full_split_raw_df: pd.DataFrame | None = None,
    top_k: int = 5,
) -> dict[str, Any]:
    """
    Evaluate Long & Short rankers on a split (`val` or `test`):
    - NDCG@5 (mean across decision timestamps)
    - Spearman IC (mean cross-sectional rank correlation between ranking score and actual net return)
    - Top 5 mean net return & positive net return ratio for Long and Short
    - Funding missing ratio (reported separately; missing funding rows are excluded from net performance)
    """
    eval_df = df_split.sort_values(["open_time", "symbol"]).reset_index(drop=True).copy()
    eval_df["score_long"] = scores_long
    eval_df["score_short"] = scores_short

    ndcg_long_list: list[float] = []
    ndcg_short_list: list[float] = []
    ic_long_list: list[float] = []
    ic_short_list: list[float] = []
    top5_long_returns: list[float] = []
    top5_short_returns: list[float] = []
    top5_long_pos_rates: list[float] = []
    top5_short_pos_rates: list[float] = []

    for _, grp in eval_df.groupby("open_time", sort=True):
        if len(grp) < MIN_ELIGIBLE_SYMBOLS_PER_GROUP:
            continue

        grades_l = grp["label_long"].to_numpy(dtype=np.float64)
        grades_s = grp["label_short"].to_numpy(dtype=np.float64)
        sc_l = grp["score_long"].to_numpy(dtype=np.float64)
        sc_s = grp["score_short"].to_numpy(dtype=np.float64)
        ret_l = grp["net_return_long"].to_numpy(dtype=np.float64)
        ret_s = grp["net_return_short"].to_numpy(dtype=np.float64)

        ndcg_long_list.append(compute_group_ndcg_at_k(grades_l, sc_l, k=top_k))
        ndcg_short_list.append(compute_group_ndcg_at_k(grades_s, sc_s, k=top_k))

        if np.std(sc_l) > 0 and np.std(ret_l) > 0:
            ic_l, _ = spearmanr(sc_l, ret_l)
            if np.isfinite(ic_l):
                ic_long_list.append(float(ic_l))
        else:
            ic_long_list.append(0.0)

        if np.std(sc_s) > 0 and np.std(ret_s) > 0:
            ic_s, _ = spearmanr(sc_s, ret_s)
            if np.isfinite(ic_s):
                ic_short_list.append(float(ic_s))
        else:
            ic_short_list.append(0.0)

        # Deterministic tie-breaking by score descending, symbol ascending
        top_l = grp.sort_values(["score_long", "symbol"], ascending=[False, True]).head(top_k)
        top_s = grp.sort_values(["score_short", "symbol"], ascending=[False, True]).head(top_k)

        l_rets = top_l["net_return_long"].to_numpy(dtype=np.float64)
        s_rets = top_s["net_return_short"].to_numpy(dtype=np.float64)
        top5_long_returns.append(float(np.mean(l_rets)))
        top5_short_returns.append(float(np.mean(s_rets)))
        top5_long_pos_rates.append(float(np.mean(l_rets > 0.0)))
        top5_short_pos_rates.append(float(np.mean(s_rets > 0.0)))

    funding_missing_ratio = 0.0
    funding_missing_count = 0
    total_candidate_rows = len(eval_df)
    if full_split_raw_df is not None and not full_split_raw_df.empty:
        raw_candidates = full_split_raw_df[
            full_split_raw_df["features_valid"].astype(bool)
            & (~full_split_raw_df["crosses_split_boundary"].astype(bool))
            & full_split_raw_df["gross_return_long"].notna()
        ]
        total_candidate_rows = len(raw_candidates)
        if total_candidate_rows > 0:
            funding_missing_count = int(raw_candidates["funding_missing"].astype(bool).sum())
            funding_missing_ratio = float(funding_missing_count / total_candidate_rows)

    return {
        "group_count": len(ndcg_long_list),
        "row_count": len(eval_df),
        "funding_missing_count": funding_missing_count,
        "funding_missing_ratio": funding_missing_ratio,
        "long": {
            "ndcg_at_5": float(np.mean(ndcg_long_list)) if ndcg_long_list else 0.0,
            "spearman_ic": float(np.mean(ic_long_list)) if ic_long_list else 0.0,
            "top5_mean_net_return": float(np.mean(top5_long_returns)) if top5_long_returns else 0.0,
            "top5_positive_rate": float(np.mean(top5_long_pos_rates)) if top5_long_pos_rates else 0.0,
        },
        "short": {
            "ndcg_at_5": float(np.mean(ndcg_short_list)) if ndcg_short_list else 0.0,
            "spearman_ic": float(np.mean(ic_short_list)) if ic_short_list else 0.0,
            "top5_mean_net_return": float(np.mean(top5_short_returns)) if top5_short_returns else 0.0,
            "top5_positive_rate": float(np.mean(top5_short_pos_rates)) if top5_short_pos_rates else 0.0,
        },
    }


def _select_best_iteration_with_min_rounds(evals_result: dict[str, Any], min_rounds: int = MIN_BOOST_ROUNDS, stopping_rounds: int = EARLY_STOPPING_ROUNDS) -> int:
    """
    Select the best boosting iteration on the validation set (`ndcg@5`) starting from `min_rounds` (1-indexed),
    applying `stopping_rounds` patience after `min_rounds` so a single-tree tie cannot halt training at iteration 1.
    """
    valid_dict = evals_result.get("valid_0", {})
    scores = valid_dict.get("ndcg@5", [])
    if not scores:
        return min_rounds
    n_total = len(scores)
    start_idx = min(max(0, min_rounds - 1), n_total - 1)
    best_idx = start_idx
    best_score = float(scores[start_idx])
    rounds_without_improve = 0
    for idx in range(start_idx + 1, n_total):
        sc = float(scores[idx])
        if sc > best_score:
            best_score = sc
            best_idx = idx
            rounds_without_improve = 0
        else:
            rounds_without_improve += 1
            if rounds_without_improve >= stopping_rounds:
                break
    return best_idx + 1


def _train_single_direction(
    train_df: pd.DataFrame,
    val_df: pd.DataFrame,
    label_col: str,
    direction: str,
) -> tuple[lgb.LGBMRanker, dict[str, Any], list[dict[str, Any]]]:
    """
    Train and select best LGBMRanker across the 4 specified hyperparameter combinations
    using validation set NDCG@5. Test set is never used here.
    """
    X_train, y_train, grp_train, _ = _prepare_groups(train_df, label_col)
    X_val, y_val, grp_val, ordered_val = _prepare_groups(val_df, label_col)

    grid_records: list[dict[str, Any]] = []
    best_model: lgb.LGBMRanker | None = None
    best_record: dict[str, Any] | None = None
    best_ndcg = -1.0

    max_fit_rounds = min(N_ESTIMATORS, 150)

    for params in PARAM_GRID:
        evals_result: dict[str, Any] = {}
        ranker = lgb.LGBMRanker(
            objective="lambdarank",
            metric="ndcg",
            # Match sklearn's linear relevance gains used for grid selection/reporting.
            label_gain=[0, 1, 2, 3, 4],
            boosting_type="gbdt",
            learning_rate=LEARNING_RATE,
            n_estimators=max_fit_rounds,
            num_leaves=params["num_leaves"],
            min_child_samples=params["min_child_samples"],
            random_state=SEED,
            deterministic=True,
            force_col_wise=True,
            n_jobs=1,
            importance_type="gain",
            verbose=-1,
        )
        ranker.fit(
            X_train,
            y_train,
            group=grp_train,
            eval_set=[(X_val, y_val)],
            eval_group=[grp_val],
            eval_at=[5],
            callbacks=[lgb.record_evaluation(evals_result)],
        )

        best_iter = _select_best_iteration_with_min_rounds(evals_result, min_rounds=MIN_BOOST_ROUNDS, stopping_rounds=EARLY_STOPPING_ROUNDS)
        ranker._best_iteration = best_iter
        ranker.booster_.best_iteration = best_iter

        val_preds = ranker.predict(X_val, num_iteration=best_iter)
        # Compute mean group NDCG@5 on validation set
        tmp_val = ordered_val.copy()
        tmp_val["_pred"] = val_preds
        val_ndcgs = [
            compute_group_ndcg_at_k(
                g[label_col].to_numpy(dtype=np.float64),
                g["_pred"].to_numpy(dtype=np.float64),
                k=5,
            )
            for _, g in tmp_val.groupby("open_time", sort=True)
        ]
        mean_val_ndcg = float(np.mean(val_ndcgs)) if val_ndcgs else 0.0

        rec = {
            "direction": direction,
            "num_leaves": params["num_leaves"],
            "min_child_samples": params["min_child_samples"],
            "best_iteration": best_iter,
            "val_ndcg_at_5": mean_val_ndcg,
        }
        grid_records.append(rec)

        if mean_val_ndcg > best_ndcg:
            best_ndcg = mean_val_ndcg
            best_model = ranker
            best_record = rec

    assert best_model is not None and best_record is not None
    return best_model, best_record, grid_records


def _fit_and_save_boosters(
    train_df: pd.DataFrame,
    val_df: pd.DataFrame,
    raw_val_df: pd.DataFrame,
    output_dir: Path,
) -> tuple[lgb.LGBMRanker, lgb.LGBMRanker, dict[str, Any], dict[str, Any], list[dict[str, Any]], list[dict[str, Any]], dict[str, Any], int, int]:
    """Fit Long/Short LGBMRankers, save truncated text boosters, and compute validation metrics."""
    long_model, best_long_cfg, grid_long = _train_single_direction(train_df, val_df, "label_long", "LONG")
    short_model, best_short_cfg, grid_short = _train_single_direction(train_df, val_df, "label_short", "SHORT")

    long_best_iter = int(best_long_cfg["best_iteration"])
    short_best_iter = int(best_short_cfg["best_iteration"])
    long_model_path = output_dir / "lgbm_long_ranker.txt"
    short_model_path = output_dir / "lgbm_short_ranker.txt"
    long_model.booster_.save_model(str(long_model_path), num_iteration=long_best_iter)
    short_model.booster_.save_model(str(short_model_path), num_iteration=short_best_iter)

    X_val, _, _, ordered_val = _prepare_groups(val_df, "label_long")
    val_scores_long = long_model.predict(X_val, num_iteration=long_best_iter)
    val_scores_short = short_model.predict(X_val, num_iteration=short_best_iter)
    val_metrics = evaluate_ranking_split(
        ordered_val,
        val_scores_long,
        val_scores_short,
        full_split_raw_df=raw_val_df,
        top_k=5,
    )
    return (
        long_model,
        short_model,
        best_long_cfg,
        best_short_cfg,
        grid_long,
        grid_short,
        val_metrics,
        long_best_iter,
        short_best_iter,
    )


def _build_model_side_meta(
    model_path: Path,
    model: lgb.LGBMRanker,
    selected_cfg: dict[str, Any],
    grid: list[dict[str, Any]],
    best_iter: int,
) -> dict[str, Any]:
    return {
        "path": model_path.name,
        "sha256": sha256_file(model_path),
        "selected_params": selected_cfg,
        "grid_search": grid,
        "feature_importances": dict(
            zip(
                FEATURE_COLUMNS,
                [float(v) for v in model.booster_.feature_importance(importance_type="gain", iteration=best_iter)],
            )
        ),
    }


def train_and_evaluate_lightgbm(
    panel_df: pd.DataFrame,
    output_dir: Path,
    dataset_version: str,
) -> dict[str, Any]:
    """
    Train Long and Short LGBMRankers on `train`, select hyperparameters on `val` via NDCG@5,
    evaluate once on `test`, and persist models + metadata to `output_dir`.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    if any(output_dir.iterdir()):
        raise FileExistsError(f"拒絕覆寫既有模型或訓練產物；請指定新的空目錄：{output_dir}")
    lock_path = output_dir / ".training.lock"
    lock_acquired = False
    try:
        eligible = panel_df[panel_df["group_eligible"].astype(bool)].copy()
    
        train_df = eligible[eligible["split"] == "train"].copy()
        val_df = eligible[eligible["split"] == "val"].copy()
        test_df = eligible[eligible["split"] == "test"].copy()
    
        if train_df.empty or val_df.empty or test_df.empty:
            raise ValueError(
                f"Insufficient eligible data across splits: train={len(train_df)}, val={len(val_df)}, test={len(test_df)}"
            )
    
        # Serialize commits to a model directory. The marker is created exclusively so
        # concurrent training jobs cannot race into fixed-name artifact writes.
        try:
            lock_path.open("x", encoding="utf-8").close()
            lock_acquired = True
        except FileExistsError as exc:
            raise FileExistsError(f"模型目錄已有訓練工作鎖：{lock_path}") from exc
        if any(p != lock_path for p in output_dir.iterdir()):
            raise FileExistsError(f"等待訓練鎖期間模型目錄出現既有產物；拒絕覆寫：{output_dir}")
    
        (
            long_model,
            short_model,
            best_long_cfg,
            best_short_cfg,
            grid_long,
            grid_short,
            val_metrics,
            long_best_iter,
            short_best_iter,
        ) = _fit_and_save_boosters(train_df, val_df, panel_df[panel_df["split"] == "val"], output_dir)

        long_model_path = output_dir / "lgbm_long_ranker.txt"
        short_model_path = output_dir / "lgbm_short_ranker.txt"
    
        X_test, _, _, ordered_test = _prepare_groups(test_df, "label_long")
        test_scores_long = long_model.predict(X_test, num_iteration=long_best_iter)
        test_scores_short = short_model.predict(X_test, num_iteration=short_best_iter)
        test_metrics = evaluate_ranking_split(
            ordered_test,
            test_scores_long,
            test_scores_short,
            full_split_raw_df=panel_df[panel_df["split"] == "test"],
            top_k=5,
        )
    
        # Save test predictions for cross-model comparison
        test_pred_df = ordered_test[
            [
                "symbol",
                "open_time",
                "decision_time",
                "entry_time",
                "exit_time",
                "close",
                "close_4h",
                "ret_4h",
                "ret_close_4h",
                "gross_return_long",
                "gross_return_short",
                "net_return_long",
                "net_return_short",
                "funding_rate_sum",
                "funding_missing",
                "label_long",
                "label_short",
            ]
        ].copy()
        test_pred_df["lgbm_score_long"] = test_scores_long
        test_pred_df["lgbm_score_short"] = test_scores_short
        test_pred_path = output_dir / "lgbm_test_predictions.parquet"
        test_pred_df.to_parquet(test_pred_path, index=False)
    
        metadata = {
            "pipeline_version": 3,
            "ndcg_label_gain": [0, 1, 2, 3, 4],
            "model_family": "LightGBM-LGBMRanker",
            "device": "cpu",
            "seed": SEED,
            "learning_rate": LEARNING_RATE,
            "max_estimators": N_ESTIMATORS,
            "min_boost_rounds": MIN_BOOST_ROUNDS,
            "early_stopping_rounds": EARLY_STOPPING_ROUNDS,
            "feature_columns": FEATURE_COLUMNS,
            "dataset_version": dataset_version,
            "long_model": _build_model_side_meta(long_model_path, long_model, best_long_cfg, grid_long, long_best_iter),
            "short_model": _build_model_side_meta(short_model_path, short_model, best_short_cfg, grid_short, short_best_iter),
            "validation_metrics": val_metrics,
            "test_metrics": test_metrics,
            "score_disclaimer": "分數為相對排名分數（Ranking Score），不代表勝率或預期報酬。",
        }
    
        meta_path = output_dir / "lgbm_metadata.json"
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(metadata, f, ensure_ascii=False, indent=2)
    
        return metadata
    finally:
        if lock_acquired:
            lock_path.unlink(missing_ok=True)


def load_lightgbm_models(model_dir: Path) -> tuple[lgb.Booster, lgb.Booster, dict[str, Any]]:
    meta_path = model_dir / "lgbm_metadata.json"
    if not meta_path.exists():
        raise FileNotFoundError(f"LightGBM metadata not found at {meta_path}")
    with open(meta_path, "r", encoding="utf-8") as f:
        meta = json.load(f)

    long_path = model_dir / meta["long_model"]["path"]
    short_path = model_dir / meta["short_model"]["path"]
    if not long_path.exists() or not short_path.exists():
        raise FileNotFoundError("LightGBM model files missing in model directory")
    for model_path, direction in [(long_path, "long_model"), (short_path, "short_model")]:
        if sha256_file(model_path) != meta[direction]["sha256"]:
            raise ValueError(f"LightGBM 模型 hash 與 metadata 不符：{model_path.name}")

    long_booster = lgb.Booster(model_file=str(long_path))
    short_booster = lgb.Booster(model_file=str(short_path))
    return long_booster, short_booster, meta


def train_rolling_lightgbm(
    panel_df: pd.DataFrame,
    output_dir: Path,
    dataset_version: str,
    cutoff_time: int,
    version_id: str | None = None,
) -> dict[str, Any]:
    """
    Train rolling Long and Short LGBMRankers on 180d sliding `train` / `val` splits only
    (forward live paper trading is the out-of-sample test).
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    if any(output_dir.iterdir()):
        raise FileExistsError(f"拒絕覆寫既有模型產物目錄：{output_dir}")

    started = time.perf_counter()
    eligible = panel_df[panel_df["group_eligible"].astype(bool)].copy()
    train_df = eligible[eligible["split"] == "train"].copy()
    val_df = eligible[eligible["split"] == "val"].copy()
    if train_df.empty or val_df.empty:
        raise ValueError(f"滾動訓練樣本不足：train={len(train_df)}, val={len(val_df)}")

    (
        long_model,
        short_model,
        best_long_cfg,
        best_short_cfg,
        grid_long,
        grid_short,
        val_metrics,
        long_best_iter,
        short_best_iter,
    ) = _fit_and_save_boosters(train_df, val_df, panel_df[panel_df["split"] == "val"], output_dir)

    long_model_path = output_dir / "lgbm_long_ranker.txt"
    short_model_path = output_dir / "lgbm_short_ranker.txt"
    trained_at = int(time.time() * 1000)
    elapsed_ms = round((time.perf_counter() - started) * 1000.0, 2)
    long_meta = _build_model_side_meta(long_model_path, long_model, best_long_cfg, grid_long, long_best_iter)
    short_meta = _build_model_side_meta(short_model_path, short_model, best_short_cfg, grid_short, short_best_iter)
    resolved_ver = version_id or f"lgbm-{int(cutoff_time)}-{long_meta['sha256'][:8]}"

    metadata = {
        "pipeline_version": 3,
        "mode": "rolling",
        "versionId": resolved_ver,
        "cutoffTime": int(cutoff_time),
        "trainedAt": trained_at,
        "elapsedMs": elapsed_ms,
        "trainRows": int(len(train_df)),
        "valRows": int(len(val_df)),
        "ndcg_label_gain": [0, 1, 2, 3, 4],
        "model_family": "LightGBM-LGBMRanker",
        "device": "cpu",
        "seed": SEED,
        "learning_rate": LEARNING_RATE,
        "max_estimators": N_ESTIMATORS,
        "min_boost_rounds": MIN_BOOST_ROUNDS,
        "early_stopping_rounds": EARLY_STOPPING_ROUNDS,
        "feature_columns": FEATURE_COLUMNS,
        "dataset_version": dataset_version,
        "long_model": long_meta,
        "short_model": short_meta,
        "validation_metrics": val_metrics,
        "score_disclaimer": "分數為相對排名分數（Ranking Score），不代表勝率或預期報酬。",
    }
    meta_path = output_dir / "lgbm_metadata.json"
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)
    return metadata


def publish_rolling_lgbm_version(
    panel_df: pd.DataFrame,
    lgbm_root: Path,
    dataset_version: str,
    cutoff_time: int,
    *,
    keep_versions: int = 48,
) -> dict[str, Any]:
    """Train LightGBM in a staging directory and atomically promote `current.json`."""
    from .rolling_store import atomic_write_json

    lgbm_root = Path(lgbm_root).resolve()
    versions_dir = lgbm_root / "versions"
    versions_dir.mkdir(parents=True, exist_ok=True)
    version_id = f"lgbm-{int(cutoff_time)}-{uuid.uuid4().hex[:8]}"
    staging_dir = lgbm_root / f".staging-{version_id}-{uuid.uuid4().hex[:8]}"
    final_dir = versions_dir / version_id
    staging_dir.mkdir(parents=True, exist_ok=False)
    try:
        meta = train_rolling_lightgbm(
            panel_df=panel_df,
            output_dir=staging_dir,
            dataset_version=dataset_version,
            cutoff_time=cutoff_time,
            version_id=version_id,
        )
        os.rename(staging_dir, final_dir)
    except BaseException:
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)
        raise

    current_doc = {
        "versionId": version_id,
        "versionDir": str(final_dir),
        "cutoffTime": int(cutoff_time),
        "trainedAt": int(meta["trainedAt"]),
        "elapsedMs": float(meta["elapsedMs"]),
        "datasetVersion": dataset_version,
        "longSha256": meta["long_model"]["sha256"],
        "shortSha256": meta["short_model"]["sha256"],
        "valNdcg5Long": float(meta["validation_metrics"]["long"]["ndcg_at_5"]),
        "valNdcg5Short": float(meta["validation_metrics"]["short"]["ndcg_at_5"]),
        "selectedParamsLong": meta["long_model"]["selected_params"],
        "selectedParamsShort": meta["short_model"]["selected_params"],
        "trainRows": int(meta["trainRows"]),
        "valRows": int(meta["valRows"]),
    }
    atomic_write_json(lgbm_root / "current.json", current_doc)

    if keep_versions > 0:
        existing_dirs = sorted(
            [d for d in versions_dir.iterdir() if d.is_dir() and d.name != version_id],
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for stale_dir in existing_dirs[max(0, keep_versions - 1) :]:
            shutil.rmtree(stale_dir, ignore_errors=True)

    return current_doc


def load_active_rolling_lightgbm(lgbm_root: Path) -> tuple[lgb.Booster, lgb.Booster, dict[str, Any], dict[str, Any]]:
    """Load the active rolling LightGBM model pointed to by `<lgbm_root>/current.json`."""
    root = Path(lgbm_root).resolve()
    current_path = root / "current.json"
    if not current_path.is_file():
        raise FileNotFoundError(f"找不到滾動 LightGBM current.json：{current_path}")
    current_doc = json.loads(current_path.read_text(encoding="utf-8"))
    version_id = str(current_doc.get("versionId") or "")
    if not version_id or "/" in version_id or "\\" in version_id or ".." in version_id:
        raise ValueError(f"滾動 LightGBM versionId 不合法：{version_id}")
    version_dir = (root / "versions" / version_id).resolve()
    version_dir.relative_to(root)
    if not version_dir.is_dir():
        raise FileNotFoundError(f"找不到滾動 LightGBM 版本目錄：{version_dir}")
    long_b, short_b, meta = load_lightgbm_models(version_dir)
    if (
        meta["long_model"]["sha256"] != current_doc.get("longSha256")
        or meta["short_model"]["sha256"] != current_doc.get("shortSha256")
    ):
        raise ValueError("滾動 LightGBM current.json 雜湊與版本 metadata 不一致")
    return long_b, short_b, meta, current_doc


def rank_at_cutoff(
    df_1h: pd.DataFrame,
    long_booster: lgb.Booster,
    short_booster: lgb.Booster,
    feature_columns: list[str] | None = None,
    cutoff_ms: int | None = None,
    df_funding: pd.DataFrame | None = None,
    top_k: int = 5,
    min_eligible: int = MIN_ELIGIBLE_SYMBOLS_PER_GROUP,
) -> dict[str, Any]:
    """
    Compute causal features up to `cutoff_ms`, select the latest closed decision hour `t`
    (`open_time = t`, `close_time = t + 1h - 1 <= cutoff_ms`), and rank all eligible symbols
    using the trained Long and Short LightGBM boosters.
    """
    feat_cols = feature_columns or FEATURE_COLUMNS
    feat_df = compute_features_for_cutoff(df_1h, cutoff_ms=cutoff_ms, df_funding=df_funding)
    if feat_df.empty:
        return {
            "status": "INSUFFICIENT_DATA",
            "reason": "無可用之已收盤 1 小時 K 線特徵資料",
            "cutoff_time": cutoff_ms,
            "eligible_count": 0,
            "long_top5": [],
            "short_top5": [],
            "all_rankings": [],
            "conflict_symbols": [],
        }

    latest_open_time = int(feat_df["open_time"].max())
    decision_cutoff_time = latest_open_time + 3_600_000  # Exact UTC hour close timestamp
    snap = feat_df[feat_df["open_time"] == latest_open_time].copy()
    valid_snap = snap[snap["features_valid"].astype(bool)].sort_values("symbol").reset_index(drop=True)
    invalid_snap = snap[~snap["features_valid"].astype(bool)]

    insufficient_reasons = [
        {"symbol": str(r["symbol"]), "reason": "歷史連續 K 線不足 97 根、存在缺口或價格特徵無效"}
        for _, r in invalid_snap.iterrows()
    ]

    if len(valid_snap) < min_eligible:
        return {
            "status": "INSUFFICIENT_DATA",
            "reason": f"合格標的數量不足（目前 {len(valid_snap)} 個，至少需 {min_eligible} 個）",
            "decision_open_time": latest_open_time,
            "cutoff_time": decision_cutoff_time,
            "eligible_count": len(valid_snap),
            "insufficient_symbols": insufficient_reasons,
            "long_top5": [],
            "short_top5": [],
            "all_rankings": [],
            "conflict_symbols": [],
        }

    X = valid_snap[feat_cols].to_numpy(dtype=np.float64)
    valid_snap["long_score"] = long_booster.predict(X)
    valid_snap["short_score"] = short_booster.predict(X)

    long_sorted = valid_snap.sort_values(["long_score", "symbol"], ascending=[False, True]).reset_index(drop=True)
    short_sorted = valid_snap.sort_values(["short_score", "symbol"], ascending=[False, True]).reset_index(drop=True)

    long_rank_map = {str(row["symbol"]): idx + 1 for idx, row in long_sorted.iterrows()}
    short_rank_map = {str(row["symbol"]): idx + 1 for idx, row in short_sorted.iterrows()}

    long_top_symbols = set(long_sorted.head(top_k)["symbol"].astype(str).tolist())
    short_top_symbols = set(short_sorted.head(top_k)["symbol"].astype(str).tolist())
    conflict_symbols = sorted(long_top_symbols.intersection(short_top_symbols))

    def _format_entry(row: pd.Series, rank: int, side: str) -> dict[str, Any]:
        sym = str(row["symbol"])
        score = float(row["long_score"] if side == "LONG" else row["short_score"])
        entry = {
            "rank": rank,
            "symbol": sym,
            "side": side,
            "rankingScore": round(score, 6),
            "longScore": round(float(row["long_score"]), 6),
            "shortScore": round(float(row["short_score"]), 6),
            "longRank": long_rank_map[sym],
            "shortRank": short_rank_map[sym],
            "conflict": sym in conflict_symbols,
            "closePrice": float(row["close"]),
            "ret1h": round(float(row["ret_1h"]), 6),
            "ret4h": round(float(row["ret_4h"]), 6),
            "ret24h": round(float(row["ret_24h"]), 6),
            "rsi14": round(float(row["rsi_14"]), 2),
            "trend4hSma6Dist": round(float(row.get("trend_4h_sma6_dist", 0.0)), 6),
            "trend24hSma4Dist": round(float(row.get("trend_24h_sma4_dist", 0.0)), 6),
        }
        # Optional JSON fields are omitted when funding is missing. JSON NaN is
        # rejected by the collector's JSON.parse and zero would fabricate data.
        for source, target, digits in [
            ("funding_rate_latest", "fundingRateLatest", 6),
            ("funding_rate_zscore_7d", "fundingRateZScore7d", 4),
        ]:
            value = float(row.get(source, np.nan))
            if np.isfinite(value):
                entry[target] = round(value, digits)
        return entry

    long_top5 = [_format_entry(row, idx + 1, "LONG") for idx, row in long_sorted.head(top_k).iterrows()]
    short_top5 = [_format_entry(row, idx + 1, "SHORT") for idx, row in short_sorted.head(top_k).iterrows()]
    all_rankings = [_format_entry(row, idx + 1, "LONG") for idx, row in long_sorted.iterrows()]

    # Kronos target symbols: Long Top 3 + Short Top 3 deduplicated (max 6)
    kronos_candidates: list[str] = []
    for item in long_top5[:3] + short_top5[:3]:
        if item["symbol"] not in kronos_candidates:
            kronos_candidates.append(item["symbol"])

    return {
        "status": "OK",
        "decision_open_time": latest_open_time,
        "cutoff_time": decision_cutoff_time,
        "eligible_count": len(valid_snap),
        "insufficient_symbols": insufficient_reasons,
        "long_top5": long_top5,
        "short_top5": short_top5,
        "all_rankings": all_rankings,
        "conflict_symbols": conflict_symbols,
        "kronos_target_symbols": kronos_candidates,
    }


def compute_features_for_cutoff(
    df_1h: pd.DataFrame,
    cutoff_ms: int | None = None,
    df_funding: pd.DataFrame | None = None,
) -> pd.DataFrame:
    """Compute causal features up to cutoff_ms on the trailing slice of df_1h for fast inference."""
    from .features_and_labels import compute_features

    if df_1h is None or df_1h.empty:
        return pd.DataFrame()
    df = df_1h
    if cutoff_ms is not None:
        df = df[df["open_time"] + 3_600_000 <= int(cutoff_ms)]
    if df.empty:
        return pd.DataFrame()
    max_open = int(df["open_time"].max())
    # Need trailing 120 hours per symbol for 96h macro trend features
    min_needed = max_open - 120 * 3_600_000
    sliced = df[df["open_time"] >= min_needed].copy()
    return compute_features(sliced, cutoff_ms=cutoff_ms, df_funding=df_funding)
