"""CPU CatBoost/XGBoost ranker adapters for the four-model benchmark runner."""

from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import time
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
from sklearn.metrics import ndcg_score

from research.model_research.features_and_labels import FEATURE_COLUMNS, MIN_ELIGIBLE_SYMBOLS_PER_GROUP


SEED = 42
LEARNING_RATE = 0.05
MAX_ROUNDS = 1000
CHECKPOINT_ROUNDS = 25
EARLY_STOP_EVALS = 4
THREADS = 4
CATBOOST_TRIALS: tuple[dict[str, int], ...] = tuple(
    {"depth": depth, "l2_leaf_reg": l2} for depth in (4, 6) for l2 in (3, 10)
)
XGBOOST_TRIALS: tuple[dict[str, int], ...] = tuple(
    {"max_depth": depth, "min_child_weight": child}
    for depth in (3, 5)
    for child in (1, 10)
)


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True), encoding="utf-8")
    os.replace(tmp, path)


def _json_safe(value: Any) -> Any:
    if isinstance(value, (np.integer,)):
        return int(value)
    if isinstance(value, (np.floating,)):
        return float(value)
    if isinstance(value, Path):
        return str(value)
    if isinstance(value, dict):
        return {str(k): _json_safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_json_safe(v) for v in value]
    return value


def _atomic_copy(source: Path, destination: Path) -> None:
    destination.parent.mkdir(parents=True, exist_ok=True)
    tmp = destination.with_suffix(destination.suffix + ".tmp")
    shutil.copy2(source, tmp)
    os.replace(tmp, destination)


def compute_group_ndcg_at_5(labels: np.ndarray, scores: np.ndarray) -> float:
    """NDCG@5 with linear relevance gain, shared by both model families."""
    if len(labels) < 2:
        return 0.0
    labels = np.asarray(labels, dtype=np.float64).reshape(1, -1)
    scores = np.asarray(scores, dtype=np.float64).reshape(1, -1)
    # Match the existing LightGBM evaluator's explicit constant-relevance policy.
    if np.all(labels == labels[0, 0]):
        return 1.0
    return float(ndcg_score(labels, scores, k=min(5, labels.shape[1]), ignore_ties=False))


def mean_group_ndcg_at_5(frame: pd.DataFrame, labels: np.ndarray, scores: np.ndarray) -> float:
    labels = np.asarray(labels)
    scores = np.asarray(scores)
    vals: list[float] = []
    offset = 0
    for _, group in frame.groupby("open_time", sort=True):
        end = offset + len(group)
        vals.append(compute_group_ndcg_at_5(labels[offset:end], scores[offset:end]))
        offset = end
    return float(np.mean(vals)) if vals else 0.0


def _prepare(frame: pd.DataFrame, label_col: str) -> tuple[pd.DataFrame, np.ndarray, list[int]]:
    ordered = frame.sort_values(["open_time", "symbol"], kind="stable").reset_index(drop=True)
    x = ordered[FEATURE_COLUMNS].to_numpy(dtype=np.float32, copy=True)
    if np.isinf(x).any():
        raise ValueError(f"Infinite ranking features in {label_col} input")
    labels = pd.to_numeric(ordered[label_col], errors="coerce").to_numpy(dtype=np.float32)
    if not np.isfinite(labels).all() or np.any(labels < 0):
        raise ValueError(f"Invalid relevance labels in {label_col} input")
    groups = ordered.groupby("open_time", sort=True).size().astype(int).tolist()
    if not groups or any(size < MIN_ELIGIBLE_SYMBOLS_PER_GROUP for size in groups):
        raise ValueError("Ranking input contains a group below the 10-symbol eligibility threshold")
    return ordered, labels, groups


def _load_panel(context: dict[str, Any]) -> tuple[pd.DataFrame, Path]:
    source_root = Path(context["source_root"])
    panel_path = source_root / "datasets" / "research_panel.parquet"
    if not panel_path.is_file():
        raise FileNotFoundError(f"Missing benchmark source panel: {panel_path}")
    frame = pd.read_parquet(panel_path)
    required = {"symbol", "open_time", "split", "group_eligible", "label_long", "label_short", *FEATURE_COLUMNS}
    missing = sorted(required - set(frame.columns))
    if missing:
        raise ValueError(f"research_panel.parquet is missing required columns: {missing}")
    return frame, panel_path


def _eligible_split(frame: pd.DataFrame, split: str) -> pd.DataFrame:
    eligible = frame[
        frame["group_eligible"].astype(bool)
        & (frame["split"] == split)
        & frame["label_long"].notna()
        & frame["label_short"].notna()
    ].copy()
    if eligible.empty:
        raise ValueError(f"No eligible {split} rows in the research panel")
    counts = eligible.groupby("open_time")["symbol"].transform("count")
    eligible = eligible[counts >= MIN_ELIGIBLE_SYMBOLS_PER_GROUP]
    return eligible.sort_values(["open_time", "symbol"], kind="stable").reset_index(drop=True)


def _smoke_limit(frame: pd.DataFrame, limit: int) -> pd.DataFrame:
    times = frame["open_time"].drop_duplicates().sort_values().head(limit)
    subset = frame[frame["open_time"].isin(times)].copy()
    counts = subset.groupby("open_time")["symbol"].transform("count")
    return subset[counts >= MIN_ELIGIBLE_SYMBOLS_PER_GROUP].reset_index(drop=True)


def _smoke_cohort_path(context: dict[str, Any]) -> Path | None:
    if not context.get("smoke"):
        return None
    config = context.get("config") or {}
    configured = config.get("smoke_test_keys_path") or config.get("smoke_cohort_path")
    candidates = [Path(configured)] if configured else []
    run_dir = context.get("run_dir")
    if run_dir:
        candidates.append(Path(run_dir) / "common_cohort.json")
    return next((path for path in candidates if path.is_file()), None)


def _smoke_test_selection(frame: pd.DataFrame, context: dict[str, Any]) -> pd.DataFrame:
    """Select the frozen shared TEST keys in smoke runs, with legacy fallback."""
    cohort_path = _smoke_cohort_path(context)
    if cohort_path is None:
        limit = int((context.get("config") or {}).get("smoke_test_groups", 2))
        return _smoke_limit(frame, limit)
    payload = json.loads(cohort_path.read_text(encoding="utf-8"))
    rows = payload.get("rows") if isinstance(payload, dict) else None
    if not isinstance(rows, list) or not rows:
        raise ValueError(f"Smoke common cohort has no row keys: {cohort_path}")
    keys = pd.DataFrame(rows)
    if not {"symbol", "open_time"}.issubset(keys.columns):
        raise ValueError(f"Smoke common cohort rows need symbol/open_time: {cohort_path}")
    keys = keys[["symbol", "open_time"]].copy()
    keys["symbol"] = keys["symbol"].astype(str)
    keys["open_time"] = pd.to_numeric(keys["open_time"], errors="raise").astype("int64")
    if keys.duplicated().any():
        raise ValueError(f"Smoke common cohort contains duplicate symbol/open_time keys: {cohort_path}")
    selected = frame.merge(keys, on=["symbol", "open_time"], how="inner", validate="one_to_one")
    if len(selected) != len(keys):
        raise ValueError(f"Smoke TEST panel is missing {len(keys) - len(selected)} frozen cohort rows")
    group_sizes = selected.groupby("open_time")["symbol"].nunique()
    if group_sizes.empty or (group_sizes < MIN_ELIGIBLE_SYMBOLS_PER_GROUP).any():
        raise ValueError("Smoke common cohort contains a TEST group below the 10-symbol threshold")
    return selected.sort_values(["open_time", "symbol"], kind="stable").reset_index(drop=True)


class RankAdapter:
    """Fit, persist, reload, and predict with one dual-direction ranker family."""

    def __init__(self, model_key: str):
        if model_key not in {"catboost", "xgboost"}:
            raise ValueError("model_key must be 'catboost' or 'xgboost'")
        self.model_key = model_key
        self.models: dict[str, Any] = {}
        self.metadata: dict[str, Any] = {}
        self._attempt_dir: Path | None = None

    def _trial_configs(self, context: dict[str, Any]) -> list[dict[str, int]]:
        config = context.get("config") or {}
        defaults = CATBOOST_TRIALS if self.model_key == "catboost" else XGBOOST_TRIALS
        # Explicitly useful for fast adapter tests; normal and smoke runs use all four candidates.
        supplied = config.get("trial_configs")
        return [dict(item) for item in supplied] if supplied is not None else [dict(item) for item in defaults]

    @staticmethod
    def _row_selection_hash(frame: pd.DataFrame) -> str:
        selected = frame[["symbol", "open_time"]].sort_values(["open_time", "symbol"], kind="stable")
        return hashlib.sha256(selected.to_csv(index=False, lineterminator="\n").encode("utf-8")).hexdigest()

    def _fingerprint(
        self, context: dict[str, Any], panel_path: Path, trial: dict[str, int], direction: str,
        train_df: pd.DataFrame, val_df: pd.DataFrame, test_df: pd.DataFrame,
    ) -> str:
        config = context.get("config") or {}
        payload = {
            "model_key": self.model_key,
            "trial": trial,
            "direction": direction,
            "seed": int(config.get("seed", SEED)),
            "learning_rate": LEARNING_RATE,
            "max_rounds": self._max_rounds(context),
            "checkpoint_rounds": CHECKPOINT_ROUNDS,
            "data_sha256": _sha256(panel_path),
            "features": FEATURE_COLUMNS,
            "contract": "linear-ndcg-at-5-v1",
            # The runner places this at the context top level, not inside config.
            "config_fingerprint": context.get("config_fingerprint"),
            "smoke": bool(context.get("smoke", False)),
            "selection_config": {
                "train_groups": int(config.get("smoke_train_groups", 8)) if context.get("smoke") else None,
                "val_groups": int(config.get("smoke_val_groups", 2)) if context.get("smoke") else None,
                "test_groups": int(config.get("smoke_test_groups", 2)) if context.get("smoke") else None,
            },
            "selected_rows_sha256": {
                "train": self._row_selection_hash(train_df),
                "val": self._row_selection_hash(val_df),
                "test": self._row_selection_hash(test_df),
            },
        }
        return hashlib.sha256(json.dumps(payload, sort_keys=True).encode("utf-8")).hexdigest()

    def _max_rounds(self, context: dict[str, Any]) -> int:
        config = context.get("config") or {}
        rounds = min(int(config.get("max_rounds", MAX_ROUNDS)), MAX_ROUNDS)
        if context.get("smoke"):
            # At least one complete checkpoint/evaluation is needed to exercise the real train path.
            rounds = max(25, min(rounds, MAX_ROUNDS))
        if rounds < 25:
            raise ValueError("max_rounds must be at least 25")
        return rounds

    def train(self, context: dict[str, Any]) -> dict[str, Any]:
        if str(context.get("device", "cpu")).lower() != "cpu":
            raise ValueError("CatBoost/XGBoost rank adapters are specified to train on CPU")
        attempt = Path(context["attempt_dir"])
        attempt.mkdir(parents=True, exist_ok=True)
        self._attempt_dir = attempt
        panel, panel_path = _load_panel(context)
        train_df = _eligible_split(panel, "train")
        val_df = _eligible_split(panel, "val")
        test_df = _eligible_split(panel, "test")
        if context.get("smoke"):
            train_df = _smoke_limit(train_df, int((context.get("config") or {}).get("smoke_train_groups", 8)))
            val_df = _smoke_limit(val_df, int((context.get("config") or {}).get("smoke_val_groups", 2)))
            test_df = _smoke_test_selection(test_df, context)
        if train_df.empty or val_df.empty or test_df.empty:
            raise ValueError("Insufficient complete >=10-symbol groups for train/validation/test")
        for split_name, split_df in (("train", train_df), ("val", val_df), ("test", test_df)):
            _prepare(split_df, "label_long")

        seed = int((context.get("config") or {}).get("seed", SEED))
        trial_records: dict[str, list[dict[str, Any]]] = {"long": [], "short": []}
        started = time.perf_counter()
        for direction, label_col in (("long", "label_long"), ("short", "label_short")):
            _, train_labels, train_groups = _prepare(train_df, label_col)
            val_ordered, val_labels, val_groups = _prepare(val_df, label_col)
            best_trial: dict[str, Any] | None = None
            for trial_index, params in enumerate(self._trial_configs(context), start=1):
                trial_dir = attempt / "trials" / direction / f"trial_{trial_index:02d}"
                trial_dir.mkdir(parents=True, exist_ok=True)
                fingerprint = self._fingerprint(context, panel_path, params, direction, train_df, val_df, test_df)
                record = self._train_trial(
                    trial_dir, fingerprint, train_df, train_labels, train_groups,
                    val_ordered, val_labels, val_groups, label_col, direction, params, seed, context,
                )
                trial_records[direction].append(record)
                if best_trial is None or record["val_ndcg_at_5"] > best_trial["val_ndcg_at_5"]:
                    best_trial = record
            if best_trial is None:
                raise RuntimeError(f"No {direction} candidate completed")
            best_trial["selected"] = True
            selected_path = Path(best_trial["best_model_path"])
            final_path = attempt / ("catboost_" + direction + ".cbm" if self.model_key == "catboost" else "xgboost_" + direction + ".json")
            _atomic_copy(selected_path, final_path)
            self.models[direction] = self._load_model(final_path)

        self.metadata = {
            "model_key": self.model_key,
            "trained": True,
            "training_steps": sum(int(r["best_iteration"]) for rows in trial_records.values() for r in rows),
            "training_device": "cpu",
            "thread_count": THREADS,
            "seed": seed,
            "feature_columns": FEATURE_COLUMNS,
            "source_panel": str(panel_path),
            "source_panel_sha256": _sha256(panel_path),
            "split_sample_counts": {"train": len(train_df), "val": len(val_df), "test": len(test_df)},
            "split_group_counts": {"train": int(train_df.open_time.nunique()), "val": int(val_df.open_time.nunique()), "test": int(test_df.open_time.nunique())},
            "best_params": {direction: next(r["params"] for r in rows if r.get("selected", False)) for direction, rows in trial_records.items()},
            "best_iterations": {direction: next(r["best_iteration"] for r in rows if r.get("selected", False)) for direction, rows in trial_records.items()},
            "validation_ndcg_at_5": {direction: next(r["val_ndcg_at_5"] for r in rows if r.get("selected", False)) for direction, rows in trial_records.items()},
            "trials": trial_records,
            "train_elapsed_seconds": time.perf_counter() - started,
            "evaluation_protocol": "VAL mean group NDCG@5, linear relevance gain; TEST not used for selection",
            "smoke": bool(context.get("smoke", False)),
        }
        self.save(context)
        self.predict({**context, "split": "test"})
        return self.metadata

    def _train_trial(
        self, trial_dir: Path, fingerprint: str,
        train_df: pd.DataFrame, train_labels: np.ndarray, train_groups: list[int],
        val_df: pd.DataFrame, val_labels: np.ndarray, val_groups: list[int],
        label_col: str, direction: str, trial: dict[str, int], seed: int, context: dict[str, Any],
    ) -> dict[str, Any]:
        state_path = trial_dir / "state.json"
        best_path = trial_dir / ("best.cbm" if self.model_key == "catboost" else "best.json")
        checkpoint_path = trial_dir / ("checkpoint.cbm" if self.model_key == "catboost" else "checkpoint.json")
        max_rounds = self._max_rounds(context)
        state: dict[str, Any] = {}
        if state_path.exists():
            state = json.loads(state_path.read_text(encoding="utf-8"))
            if state.get("fingerprint") != fingerprint:
                raise ValueError(f"Trial checkpoint identity mismatch; refusing unsafe resume: {trial_dir}")
            if state.get("complete"):
                if not best_path.exists() or _sha256(best_path) != state.get("best_model_sha256"):
                    raise ValueError(f"Completed trial artifact is missing or corrupt: {trial_dir}")
                return {**state["result"], "best_model_path": str(best_path), "resumed_complete": True}
            if int(state.get("completed_rounds", 0)) > 0 and not checkpoint_path.exists():
                raise ValueError(f"Trial checkpoint missing for saved training state: {trial_dir}")
            if not state.get("complete") and checkpoint_path.exists():
                if _sha256(checkpoint_path) != state.get("checkpoint_sha256"):
                    raise ValueError(f"Trial checkpoint/state mismatch; refusing unsafe resume: {trial_dir}")
        elif checkpoint_path.exists() or best_path.exists():
            raise ValueError(f"Untracked ranker checkpoint found; refusing to overwrite: {trial_dir}")

        elapsed_start = time.perf_counter()
        if self.model_key == "catboost":
            from catboost import CatBoostRanker, Pool

            x_train = train_df[FEATURE_COLUMNS]
            x_val = val_df[FEATURE_COLUMNS]
            train_pool = Pool(x_train, label=train_labels, group_id=train_df["open_time"].astype(str).to_numpy())
            val_pool = Pool(x_val, label=val_labels, group_id=val_df["open_time"].astype(str).to_numpy())
            model = CatBoostRanker()
            completed = int(state.get("completed_rounds", 0))
            best_score = float(state.get("best_score", -math.inf))
            best_iteration = int(state.get("best_iteration", 0))
            no_improve = int(state.get("no_improve_evals", 0))
            history = list(state.get("validation_history", []))
            if completed and checkpoint_path.exists():
                model.load_model(str(checkpoint_path), format="cbm")
            while completed < max_rounds and no_improve < EARLY_STOP_EVALS:
                chunk = min(CHECKPOINT_ROUNDS, max_rounds - completed)
                next_model = CatBoostRanker(
                    loss_function="YetiRank:mode=NDCG",
                    eval_metric="NDCG:top=5",
                    iterations=chunk,
                    learning_rate=LEARNING_RATE,
                    depth=int(trial["depth"]),
                    l2_leaf_reg=float(trial["l2_leaf_reg"]),
                    random_seed=seed,
                    thread_count=THREADS,
                    task_type="CPU",
                    verbose=False,
                    allow_writing_files=False,
                    use_best_model=False,
                )
                next_model.fit(train_pool, eval_set=val_pool, init_model=model if completed else None, verbose=False)
                model = next_model
                completed += chunk
                scores = model.predict(x_val)
                score = mean_group_ndcg_at_5(val_df, val_labels, scores)
                improved = score > best_score + 1e-12
                if improved:
                    best_score, best_iteration, no_improve = score, completed, 0
                    model.save_model(str(best_path), format="cbm")
                else:
                    no_improve += 1
                model.save_model(str(checkpoint_path), format="cbm")
                history.append({"round": completed, "val_ndcg_at_5": score})
                _atomic_json(state_path, {"fingerprint": fingerprint, "completed_rounds": completed, "best_score": best_score, "best_iteration": best_iteration, "no_improve_evals": no_improve, "validation_history": history, "checkpoint_sha256": _sha256(checkpoint_path), "best_model_sha256": _sha256(best_path) if best_path.exists() else None, "complete": False})
            final_model = model
        else:
            import xgboost as xgb

            x_train = train_df[FEATURE_COLUMNS].to_numpy(dtype=np.float32)
            x_val = val_df[FEATURE_COLUMNS].to_numpy(dtype=np.float32)
            dtrain = xgb.DMatrix(x_train, label=train_labels, feature_names=FEATURE_COLUMNS)
            dtrain.set_group(train_groups)
            dval = xgb.DMatrix(x_val, label=val_labels, feature_names=FEATURE_COLUMNS)
            dval.set_group(val_groups)
            params = {
                "objective": "rank:ndcg",
                "eval_metric": "ndcg@5",
                "ndcg_exp_gain": False,
                "learning_rate": LEARNING_RATE,
                "max_depth": int(trial["max_depth"]),
                "min_child_weight": int(trial["min_child_weight"]),
                "seed": seed,
                "nthread": THREADS,
                "tree_method": "hist",
            }
            completed = int(state.get("completed_rounds", 0))
            best_score = float(state.get("best_score", -math.inf))
            best_iteration = int(state.get("best_iteration", 0))
            no_improve = int(state.get("no_improve_evals", 0))
            history = list(state.get("validation_history", []))
            booster = xgb.Booster()
            if completed and checkpoint_path.exists():
                booster.load_model(str(checkpoint_path))
            while completed < max_rounds and no_improve < EARLY_STOP_EVALS:
                chunk = min(CHECKPOINT_ROUNDS, max_rounds - completed)
                booster = xgb.train(params, dtrain, num_boost_round=chunk, evals=[(dval, "val")], xgb_model=booster if completed else None, verbose_eval=False)
                completed += chunk
                scores = booster.predict(dval)
                score = mean_group_ndcg_at_5(val_df, val_labels, scores)
                if score > best_score + 1e-12:
                    best_score, best_iteration, no_improve = score, completed, 0
                    booster.save_model(str(best_path))
                else:
                    no_improve += 1
                booster.save_model(str(checkpoint_path))
                history.append({"round": completed, "val_ndcg_at_5": score})
                _atomic_json(state_path, {"fingerprint": fingerprint, "completed_rounds": completed, "best_score": best_score, "best_iteration": best_iteration, "no_improve_evals": no_improve, "validation_history": history, "checkpoint_sha256": _sha256(checkpoint_path), "best_model_sha256": _sha256(best_path) if best_path.exists() else None, "complete": False})
            final_model = booster

        if not best_path.exists() or best_iteration <= 0:
            raise RuntimeError(f"No valid best checkpoint produced for {self.model_key} {direction} {trial}")
        result = {
            "direction": direction,
            "params": dict(trial),
            "best_iteration": best_iteration,
            "completed_rounds": completed,
            "val_ndcg_at_5": best_score,
            "validation_history": history,
            "elapsed_seconds": time.perf_counter() - elapsed_start,
            "best_model_path": str(best_path),
        }
        state.update({"fingerprint": fingerprint, "complete": True, "result": result, "completed_rounds": completed, "best_model_sha256": _sha256(best_path)})
        _atomic_json(state_path, state)
        return {**result, "resumed_complete": False}

    def save(self, context: dict[str, Any]) -> dict[str, Any]:
        attempt = Path(context.get("attempt_dir") or self._attempt_dir or "")
        if not attempt.is_dir() or set(self.models) != {"long", "short"}:
            raise RuntimeError("Both trained direction models must be present before save")
        filenames = {
            "long": "catboost_long.cbm" if self.model_key == "catboost" else "xgboost_long.json",
            "short": "catboost_short.cbm" if self.model_key == "catboost" else "xgboost_short.json",
        }
        files = {}
        for direction, model in self.models.items():
            path = attempt / filenames[direction]
            if self.model_key == "catboost":
                model.save_model(str(path), format="cbm")
            else:
                model.save_model(str(path))
            files[path.name] = {"path": str(path), "sha256": _sha256(path), "bytes": path.stat().st_size}
        self.metadata["files"] = files
        self.metadata["artifact_files_sha256"] = {name: item["sha256"] for name, item in files.items()}
        # Runner verifies this portable relative-path map after the train subprocess exits.
        self.metadata["artifact_hashes"] = {name: item["sha256"] for name, item in files.items()}
        self.metadata["metadata_path"] = str(attempt / "metadata.json")
        _atomic_json(attempt / "metadata.json", _json_safe(self.metadata))
        return self.metadata

    def _load_model(self, path: Path) -> Any:
        if self.model_key == "catboost":
            from catboost import CatBoostRanker
            model = CatBoostRanker()
            model.load_model(str(path), format="cbm")
            return model
        import xgboost as xgb
        model = xgb.Booster()
        model.load_model(str(path))
        return model

    def load(self, context: dict[str, Any]) -> "RankAdapter":
        attempt = Path(context["attempt_dir"])
        metadata_path = attempt / "metadata.json"
        if not metadata_path.is_file():
            raise FileNotFoundError(f"Missing rank adapter metadata: {metadata_path}")
        metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
        if metadata.get("model_key") != self.model_key or metadata.get("trained") is not True:
            raise ValueError("Rank adapter metadata identity/trained flag mismatch")
        source_panel = Path(context["source_root"]) / "datasets" / "research_panel.parquet"
        if metadata.get("source_panel_sha256") != _sha256(source_panel):
            raise ValueError("Ranker artifacts were trained from a different source panel")
        self.models = {}
        for direction in ("long", "short"):
            filename = ("catboost_" if self.model_key == "catboost" else "xgboost_") + direction + (".cbm" if self.model_key == "catboost" else ".json")
            model_path = attempt / filename
            expected = metadata.get("files", {}).get(filename, {}).get("sha256")
            if not model_path.is_file() or not expected or _sha256(model_path) != expected:
                raise ValueError(f"Missing or hash-mismatched ranker artifact: {model_path}")
            self.models[direction] = self._load_model(model_path)
        self.metadata = metadata
        self._attempt_dir = attempt
        return self

    def predict(self, context: dict[str, Any]) -> dict[str, Any]:
        if set(self.models) != {"long", "short"}:
            self.load(context)
        panel, _ = _load_panel(context)
        split = str(context.get("split", "test"))
        frame = _eligible_split(panel, split)
        if context.get("smoke") and split == "test":
            frame = _smoke_test_selection(frame, context)
        ordered, _, _ = _prepare(frame, "label_long")
        x = ordered[FEATURE_COLUMNS].to_numpy(dtype=np.float32)
        if self.model_key == "catboost":
            long_scores = np.asarray(self.models["long"].predict(ordered[FEATURE_COLUMNS]), dtype=np.float64).reshape(-1)
            short_scores = np.asarray(self.models["short"].predict(ordered[FEATURE_COLUMNS]), dtype=np.float64).reshape(-1)
        else:
            import xgboost as xgb
            matrix = xgb.DMatrix(x, feature_names=FEATURE_COLUMNS)
            long_scores = np.asarray(self.models["long"].predict(matrix), dtype=np.float64).reshape(-1)
            short_scores = np.asarray(self.models["short"].predict(matrix), dtype=np.float64).reshape(-1)
        if len(long_scores) != len(ordered) or len(short_scores) != len(ordered) or not np.isfinite(long_scores).all() or not np.isfinite(short_scores).all():
            raise ValueError("Ranker produced missing, mismatched, or non-finite prediction scores")
        predictions = ordered[["symbol", "open_time"]].copy()
        predictions["variant"] = "trained"
        predictions["score_long"] = long_scores
        predictions["score_short"] = short_scores
        destination = Path(context["attempt_dir"]) / "predictions.parquet"
        destination.parent.mkdir(parents=True, exist_ok=True)
        tmp = destination.with_suffix(".parquet.tmp")
        predictions.to_parquet(tmp, index=False)
        os.replace(tmp, destination)
        return {"predictions_path": str(destination), "row_count": len(predictions), "group_count": int(predictions.open_time.nunique()), "split": split}


__all__ = [
    "CATBOOST_TRIALS", "XGBOOST_TRIALS", "RankAdapter", "compute_group_ndcg_at_5", "mean_group_ndcg_at_5",
]
