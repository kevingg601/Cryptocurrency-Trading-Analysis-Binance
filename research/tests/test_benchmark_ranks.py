from __future__ import annotations

import json
import shutil
from pathlib import Path
import numpy as np
import pandas as pd
import pytest

from research.model_benchmark.rank_adapters import (
    CATBOOST_TRIALS,
    XGBOOST_TRIALS,
    RankAdapter,
    _eligible_split,
    _smoke_test_selection,
    compute_group_ndcg_at_5,
)
from research.model_research.features_and_labels import FEATURE_COLUMNS, ONE_HOUR_MS


def test_candidate_grids_and_linear_gain_ndcg():
    assert len(CATBOOST_TRIALS) == len(XGBOOST_TRIALS) == 4
    # With linear gain the perfect ranking scores 1.0 and reversing it is worse.
    perfect = compute_group_ndcg_at_5(np.array([0, 1, 2, 3, 4]), np.array([0, 1, 2, 3, 4]))
    reversed_rank = compute_group_ndcg_at_5(np.array([0, 1, 2, 3, 4]), np.array([4, 3, 2, 1, 0]))
    assert perfect == pytest.approx(1.0)
    assert reversed_rank < perfect
    assert compute_group_ndcg_at_5(np.array([0, 0, 0, 0, 0]), np.ones(5)) == pytest.approx(1.0)


def _synthetic_panel(path):
    dataset_dir = path / "datasets"
    dataset_dir.mkdir(parents=True)
    rows = []
    rng = np.random.default_rng(2718)
    for split, groups in (("train", 8), ("val", 2), ("test", 2)):
        split_offset = {"train": 0, "val": 100, "test": 200}[split]
        for group in range(groups):
            open_time = (split_offset + group) * ONE_HOUR_MS
            for symbol_index in range(12):
                row = {
                    "symbol": f"COIN{symbol_index:02d}USDT",
                    "open_time": open_time,
                    "split": split,
                    "group_eligible": True,
                    "label_long": (symbol_index + group) % 5,
                    "label_short": (4 - symbol_index + group) % 5,
                }
                row.update({feature: float(rng.normal() + symbol_index * 0.02) for feature in FEATURE_COLUMNS})
                rows.append(row)
    pd.DataFrame(rows).to_parquet(dataset_dir / "research_panel.parquet", index=False)


@pytest.mark.parametrize("model_key", ["catboost", "xgboost"])
def test_rank_adapter_train_save_reload_and_predict(tmp_path, model_key):
    pytest.importorskip("catboost")
    pytest.importorskip("xgboost")
    source = tmp_path / "source"
    _synthetic_panel(source)
    attempt = tmp_path / model_key / "attempt_01"
    context = {
        "source_root": str(source),
        "attempt_dir": str(attempt),
        "run_dir": str(tmp_path / model_key),
        "device": "cpu",
        "smoke": True,
        "config": {"max_rounds": 25},
    }
    adapter = RankAdapter(model_key)
    metadata = adapter.train(context)
    assert metadata["trained"] is True
    assert metadata["split_group_counts"] == {"train": 8, "val": 2, "test": 2}
    assert set(metadata["best_iterations"]) == {"long", "short"}
    assert len(metadata["trials"]["long"]) == len(metadata["trials"]["short"]) == 4
    for digest in metadata["artifact_files_sha256"].values():
        assert len(digest) == 64

    fresh = RankAdapter(model_key).load(context)
    result = fresh.predict(context)
    predictions = pd.read_parquet(result["predictions_path"])
    assert result["row_count"] == 24
    assert set(predictions.columns) == {"symbol", "open_time", "variant", "score_long", "score_short"}
    assert predictions["variant"].eq("trained").all()
    assert np.isfinite(predictions[["score_long", "score_short"]].to_numpy()).all()


def test_resume_rejects_changed_smoke_selection_and_runner_fingerprint(tmp_path):
    pytest.importorskip("xgboost")
    source = tmp_path / "source"
    _synthetic_panel(source)
    attempt = tmp_path / "xgboost" / "attempt_01"
    base_context = {
        "source_root": str(source),
        "attempt_dir": str(attempt),
        "run_dir": str(tmp_path / "xgboost"),
        "device": "cpu",
        "smoke": True,
        "config_fingerprint": "runner-fingerprint-v1",
        "config": {"max_rounds": 25, "smoke_train_groups": 8, "trial_configs": [XGBOOST_TRIALS[0]]},
    }
    RankAdapter("xgboost").train(base_context)

    changed_selection = {**base_context, "config": {**base_context["config"], "smoke_train_groups": 80}}
    with pytest.raises(ValueError, match="identity mismatch"):
        RankAdapter("xgboost").train(changed_selection)

    changed_runner_fingerprint = {**base_context, "config_fingerprint": "runner-fingerprint-v2"}
    with pytest.raises(ValueError, match="identity mismatch"):
        RankAdapter("xgboost").train(changed_runner_fingerprint)


def test_latest_candidate_event_contains_all_candidates_and_restores_without_original_paths(tmp_path):
    pytest.importorskip("xgboost")
    source = tmp_path / "source"
    _synthetic_panel(source)
    original_run = tmp_path / "original_run"
    attempt = original_run / "models" / "xgboost" / "attempt-01"
    attempt.mkdir(parents=True)
    (attempt / "attempt_identity.json").write_text(
        json.dumps({"fingerprint": "portable-fingerprint", "model_key": "xgboost", "device": "cpu"}),
        encoding="utf-8",
    )
    (original_run / "run_manifest.json").write_text(
        json.dumps({"run_id": original_run.name, "status": "RUNNING", "models": {
            "xgboost": {"status": "RUNNING", "active_attempt": "models/xgboost/attempt-01"},
        }}),
        encoding="utf-8",
    )
    config = {"max_rounds": 25, "trial_configs": [dict(item) for item in XGBOOST_TRIALS[:2]]}
    context = {
        "source_root": str(source), "attempt_dir": str(attempt), "run_dir": str(original_run),
        "device": "cpu", "smoke": True, "config_fingerprint": "portable-fingerprint", "config": config,
    }
    RankAdapter("xgboost").train(context)
    latest_event = json.loads((original_run / "stage_events.jsonl").read_text(encoding="utf-8").splitlines()[-1])
    artifact_paths = {entry["path"] for entry in latest_event["artifact_manifest"]}
    candidate_models = {path for path in artifact_paths if "/trials/" in path and path.endswith("/best.json")}
    candidate_states = {path for path in artifact_paths if "/trials/" in path and path.endswith("/state.json")}
    assert len(candidate_models) == len(candidate_states) == 4
    assert "models/xgboost/attempt-01/attempt_identity.json" in artifact_paths

    restored_run = tmp_path / "restored_run"
    for relative in artifact_paths:
        source_path = original_run / Path(relative)
        target_path = restored_run / Path(relative)
        target_path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source_path, target_path)
    restored_attempt = restored_run / latest_event["attempt_dir"]
    (restored_run / "run_manifest.json").write_text(
        json.dumps({"run_id": restored_run.name, "status": "RUNNING", "models": {
            "xgboost": {"status": "RUNNING", "active_attempt": latest_event["attempt_dir"]},
        }}),
        encoding="utf-8",
    )
    # Prove state recovery does not reach back to a stale absolute path.
    shutil.rmtree(original_run)
    restored_context = {**context, "attempt_dir": str(restored_attempt), "run_dir": str(restored_run)}
    resumed = RankAdapter("xgboost").train(restored_context)
    assert all(row["resumed_complete"] for direction in ("long", "short") for row in resumed["trials"][direction])
    resumed_event = json.loads((restored_run / "stage_events.jsonl").read_text(encoding="utf-8").splitlines()[-1])
    resumed_paths = {entry["path"] for entry in resumed_event["artifact_manifest"]}
    assert len({path for path in resumed_paths if "/trials/" in path and path.endswith("/best.json")}) == 4


def test_smoke_test_selection_uses_frozen_common_cohort_keys(tmp_path):
    source = tmp_path / "source"
    _synthetic_panel(source)
    panel = pd.read_parquet(source / "datasets" / "research_panel.parquet")
    test = _eligible_split(panel, "test")
    legacy = _smoke_test_selection(test, {
        "smoke": True,
        "run_dir": str(tmp_path / "without-cohort"),
        "config": {"smoke_test_groups": 2},
    })
    assert legacy.open_time.nunique() == 2

    expected_time = int(test.open_time.drop_duplicates().sort_values().iloc[-1])
    expected_keys = test.loc[test.open_time.eq(expected_time), ["symbol", "open_time"]]
    run_dir = tmp_path / "with-cohort"
    run_dir.mkdir()
    cohort_path = run_dir / "common_cohort.json"
    cohort_path.write_text(
        json.dumps({"rows": pd.DataFrame({
            "symbol": expected_keys.symbol,
            "open_time": expected_keys.open_time,
            "decision_time": expected_keys.open_time,
        }).to_dict(orient="records")}),
        encoding="utf-8",
    )
    selected = _smoke_test_selection(test, {
        "smoke": True,
        "run_dir": str(run_dir),
        "config": {"smoke_test_groups": 2},
    })
    assert selected.open_time.unique().tolist() == [expected_time]
    assert set(selected[["symbol", "open_time"]].itertuples(index=False, name=None)) == set(
        expected_keys.itertuples(index=False, name=None)
    )
