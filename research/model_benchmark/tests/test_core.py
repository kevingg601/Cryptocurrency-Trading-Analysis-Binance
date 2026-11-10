from __future__ import annotations

import json
import ctypes
import os
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

import numpy as np
import pandas as pd

from research.model_benchmark.common import emit_stage_event, exclusive_lock, hash_file, verify_artifacts
from research.model_benchmark import config as benchmark_config
from research.model_benchmark.config import MODEL_KEYS, benchmark_fingerprint, dataset_identity, portable_identity
from research.model_benchmark.dataset import build_common_cohort, freeze_common_cohort
from research.model_benchmark.metrics import _ndcg, evaluate_common, evaluate_forecaster, evaluate_ranker
from research.model_benchmark.runner import (_env_identity, _execute_model, _handle_posix_sigterm, _install_posix_sigterm_handler,
                                             _mark_attempt_running, _model_integrity, _make_run, _run_worker, _validate_prediction,
                                             attach_common_metrics, main, run_in_order)
from research.model_benchmark.process_tree import start_managed_process
from research.model_benchmark.reporting import write_reports
from research.model_benchmark.registry import ModelSpec, REGISTRY
from research.model_research.features_and_labels import ONE_DAY_MS, ONE_HOUR_MS


class DatasetTests(unittest.TestCase):
    @staticmethod
    def frames() -> tuple[pd.DataFrame, pd.DataFrame]:
        symbols = [f"S{i:02d}" for i in range(12)]
        decisions = [1700006400000, 1700092800000]
        panel_rows = []
        kline_rows = []
        for decision in decisions:
            open_time = decision - ONE_HOUR_MS
            for symbol in symbols:
                panel_rows.append({"symbol": symbol, "open_time": open_time, "decision_time": decision,
                                   "split": "test", "features_valid": True, "crosses_split_boundary": False,
                                   "row_eligible": True, "group_eligible": True, "ret_close_4h": 0.01,
                                   "label_long": 2, "label_short": 1, "net_return_long": 0.009,
                                   "net_return_short": -0.011, "ret_4h": 0.002, "close": 100.0, "close_4h": 101.0})
                times = list(range(open_time - 255 * ONE_HOUR_MS, open_time + 1, ONE_HOUR_MS))
                kline_rows.extend({"symbol": symbol, "open_time": t, "is_final": True} for t in times)
        hole = decisions[0] - ONE_HOUR_MS - 100 * ONE_HOUR_MS
        kline_rows = [row for row in kline_rows if not (row["symbol"] == "S11" and row["open_time"] == hole)]
        # One of the remaining first-group rows is ineligible; 10 should still remain.
        panel_rows[0]["row_eligible"] = False
        panel_rows.append({**panel_rows[0], "symbol": "OUT", "split": "val", "row_eligible": True})
        return pd.DataFrame(panel_rows), pd.DataFrame(kline_rows)

    def test_fixed_cohort_is_test_only_contiguous_and_group_complete(self) -> None:
        panel, klines = self.frames()
        cohort = build_common_cohort(panel, klines)
        self.assertEqual(cohort.decision_time.nunique(), 2)
        self.assertEqual(len(cohort), 21)  # 10 eligible in first group, 11 in second.
        self.assertNotIn("S11", set(cohort.loc[cohort.decision_time.eq(cohort.decision_time.min()), "symbol"]))
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temp:
            run_dir = Path(temp)
            frozen, meta = freeze_common_cohort(panel, klines, run_dir, {"dataset_version": "unit"}, smoke=True)
            self.assertEqual(len(frozen), 21)
            self.assertEqual(meta["groups"], 2)
            again, _ = freeze_common_cohort(panel, klines, run_dir, {"dataset_version": "unit"}, smoke=True)
            self.assertEqual(frozen[["symbol", "open_time"]].to_dict("records"), again[["symbol", "open_time"]].to_dict("records"))

    def test_manifest_hash_change_rejects_modified_source_file(self) -> None:
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temp:
            source = Path(temp)
            datasets = source / "datasets"
            datasets.mkdir()
            expected = {}
            for filename, content in (("klines_1h.parquet", b"klines-v3"),
                                      ("funding_rates.parquet", b"funding-v3"),
                                      ("research_panel.parquet", b"panel-v3")):
                path = datasets / filename
                path.write_bytes(content)
                expected[filename] = {"sha256": hash_file(path)}
            manifest = {
                "pipelineVersion": 3,
                "datasetVersion": "unit-v3",
                "files": {"klines1hParquet": expected["klines_1h.parquet"],
                          "fundingRatesParquet": expected["funding_rates.parquet"],
                          "researchPanelParquet": expected["research_panel.parquet"]},
                "universe": {"symbols": ["S00"]},
                "splitSummary": {"test": {"totalSymbolHourRows": 1}},
            }
            (datasets / "dataset_manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            identity = dataset_identity(source)
            self.assertEqual(identity["pipeline_version"], 3)
            self.assertEqual(identity["files"]["research_panel.parquet"], expected["research_panel.parquet"]["sha256"])
            (datasets / "research_panel.parquet").write_bytes(b"modified-panel")
            with self.assertRaisesRegex(ValueError, "SHA256"):
                dataset_identity(source)


class MetricTests(unittest.TestCase):
    def test_tie_aware_ndcg_and_constant_grade_behavior(self) -> None:
        score = _ndcg(np.array([4.0, 0.0]), np.array([0.0, 0.0]), k=2)
        d1, d2 = 1.0, 1.0 / np.log2(3.0)
        self.assertAlmostEqual(score, (d1 + d2) / (2 * d1))
        self.assertEqual(_ndcg(np.array([1.0, 1.0]), np.array([0.0, 0.0])), 1.0)

    def test_rank_metrics_exclude_non_test_and_funding_missing(self) -> None:
        n = 10
        panel = pd.DataFrame({"symbol": [f"S{i}" for i in range(n)], "open_time": [1] * n,
                              "split": ["test"] * n, "row_eligible": [True] * n, "group_eligible": [True] * n,
                              "label_long": np.arange(n) % 5, "label_short": np.arange(n)[::-1] % 5,
                              "net_return_long": np.linspace(-0.01, 0.01, n), "net_return_short": np.linspace(0.01, -0.01, n)})
        panel.loc[0, "net_return_long"] = np.nan
        pred = pd.DataFrame({"symbol": panel.symbol, "open_time": panel.open_time, "score_long": np.arange(n), "score_short": np.arange(n)[::-1]})
        metrics = evaluate_ranker(pred, panel)
        self.assertEqual(metrics["evaluated_groups"], 1)
        self.assertEqual(metrics["directions"]["long"]["groups"], 0)  # nine priced rows are not a 10-coin group
        self.assertEqual(metrics["directions"]["short"]["groups"], 1)
        self.assertGreater(metrics["directions"]["short"]["top5_mean_net_return"], 0.0)

    def test_forecast_variants_are_reported_separately(self) -> None:
        panel = pd.DataFrame({"symbol": ["A", "B"], "open_time": [1, 1], "split": ["test", "test"],
                              "row_eligible": [True, True], "label_long": [1, 0], "label_short": [0, 1],
                              "net_return_long": [0.009, -0.011], "net_return_short": [-0.011, 0.009],
                              "close": [100.0, 100.0], "close_4h": [101.0, 99.0], "ret_close_4h": [0.01, -0.01], "ret_4h": [0.005, -0.005]})
        pred = pd.DataFrame({"symbol": ["A", "B", "A", "B"], "open_time": [1, 1, 1, 1],
                             "variant": ["pretrained", "pretrained", "finetuned", "finetuned"],
                             "pred_close_4h": [100, 100, 102, 98], "pred_return_4h": [0, 0, 0.02, -0.02]})
        metrics = evaluate_forecaster(pred, panel)
        self.assertEqual(metrics["variants"]["pretrained"]["samples"], 2)
        self.assertEqual(metrics["variants"]["finetuned"]["return_mae"], 0.01)

    def test_common_metrics_use_prediction_intersection(self) -> None:
        panel = pd.DataFrame({"symbol": [f"S{i}" for i in range(10)], "open_time": [1] * 10, "split": ["test"] * 10,
                              "row_eligible": [True] * 10, "group_eligible": [True] * 10, "label_long": [1] * 10,
                              "label_short": [1] * 10, "net_return_long": [0.01] * 10, "net_return_short": [-0.01] * 10})
        cohort = panel[["symbol", "open_time"]].copy()
        full = panel[["symbol", "open_time"]].copy()
        full["variant"] = "trained"
        full["score_long"] = np.arange(10)
        full["score_short"] = -np.arange(10)
        subset = full.iloc[:9].copy()
        result = evaluate_common({"a": full, "b": subset}, cohort, panel)
        self.assertEqual(result["intersection_pairs"], 0)  # incomplete group is removed, never zero-filled

    def test_ic_is_spearman_with_average_ranks_and_ties(self) -> None:
        n = 10
        scores = np.arange(n, dtype=float)
        returns = np.power(2.0, scores)
        panel = pd.DataFrame({"symbol": [f"S{i}" for i in range(n)], "open_time": [1] * n, "split": ["test"] * n,
                              "row_eligible": [True] * n, "group_eligible": [True] * n, "label_long": np.arange(n) % 5,
                              "label_short": np.arange(n)[::-1] % 5, "net_return_long": returns, "net_return_short": -returns})
        pred = pd.DataFrame({"symbol": panel.symbol, "open_time": panel.open_time, "score_long": scores, "score_short": -scores})
        self.assertAlmostEqual(evaluate_ranker(pred, panel)["directions"]["long"]["ic"], 1.0)
        pred.loc[0:1, "score_long"] = -1.0
        expected = pred["score_long"].rank(method="average").corr(pd.Series(returns).rank(method="average"))
        self.assertAlmostEqual(evaluate_ranker(pred, panel)["directions"]["long"]["ic"], expected)

    def test_forecast_metrics_exclude_zero_actual_and_include_ranking(self) -> None:
        actual = np.array([0.0, -0.03, -0.02, -0.01, 0.01, 0.02, 0.03, -0.04, 0.04, 0.05])
        panel = pd.DataFrame({"symbol": [f"S{i}" for i in range(10)], "open_time": [1] * 10, "split": ["test"] * 10,
                              "close": [100.0] * 10, "close_4h": 100 * (1 + actual), "ret_close_4h": actual, "ret_4h": actual,
                              "label_long": np.arange(10) % 5, "label_short": np.arange(10)[::-1] % 5,
                              "net_return_long": actual - .001, "net_return_short": -actual - .001, "row_eligible": [True] * 10})
        pred = pd.DataFrame({"symbol": panel.symbol, "open_time": panel.open_time, "variant": ["finetuned"] * 10,
                             "pred_close_4h": 100 * (1 + actual), "pred_return_4h": actual})
        metrics = evaluate_forecaster(pred, panel)
        self.assertEqual(metrics["valid_direction_count"], 9)
        self.assertAlmostEqual(metrics["directional_accuracy"], 1.0)
        self.assertIsNone(metrics["no_change_directional_accuracy"])
        self.assertEqual(metrics["ranking"]["evaluated_groups"], 1)

    def test_common_intersection_uses_each_ts_variant_valid_key_set(self) -> None:
        symbols = [f"S{i}" for i in range(10)]
        panel_rows = []
        for open_time in (100, 200):
            for i, symbol in enumerate(symbols):
                ret = (i - 4) / 100
                panel_rows.append({"symbol": symbol, "open_time": open_time, "split": "test", "row_eligible": True,
                                   "group_eligible": True, "label_long": i % 5, "label_short": (9-i) % 5,
                                   "net_return_long": ret - .001, "net_return_short": -ret - .001, "close": 100.0,
                                   "close_4h": 100 * (1 + ret), "ret_close_4h": ret, "ret_4h": ret})
        panel = pd.DataFrame(panel_rows)
        cohort = panel[["symbol", "open_time"]].copy()
        rank = cohort.copy()
        rank["variant"] = "trained"
        rank["score_long"] = np.arange(len(rank), dtype=float)
        rank["score_short"] = -np.arange(len(rank), dtype=float)
        forecasts = []
        for variant in ("pretrained", "finetuned"):
            for row in panel.itertuples(index=False):
                if variant == "finetuned" and row.open_time == 100 and row.symbol == "S0":
                    continue
                forecasts.append({"symbol": row.symbol, "open_time": row.open_time, "variant": variant,
                                  "pred_close_4h": row.close_4h, "pred_return_4h": row.ret_close_4h})
        result = evaluate_common({"rank": rank, "ts": pd.DataFrame(forecasts)}, cohort, panel)
        self.assertEqual(result["coverage_by_model_variant"]["ts"]["finetuned"]["missing_pairs"], 1)
        self.assertEqual(result["intersection_pairs"], 10)
        self.assertEqual(result["intersection_groups"], 1)
        self.assertEqual(result["models"]["ts"]["variants"]["pretrained"]["ranking"]["evaluated_groups"], 1)

    def test_prediction_contract_rejects_missing_variants_and_nonfinite_values(self) -> None:
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temp:
            path = Path(temp) / "predictions.parquet"
            rows = [{"symbol": f"S{i}", "open_time": 1, "variant": v, "pred_close_4h": 100.0, "pred_return_4h": .01}
                    for v in ("pretrained", "finetuned") for i in range(10) if not (v == "finetuned" and i == 0)]
            expected = {(f"S{i}", 1) for i in range(10)}
            df = pd.DataFrame(rows)
            df.to_parquet(path, index=False)
            coverage = _validate_prediction(path, "chronos2", expected)
            self.assertEqual(coverage["finetuned"]["missing_pairs"], 1)
            df.loc[0, "pred_return_4h"] = np.inf
            df.to_parquet(path, index=False)
            with self.assertRaisesRegex(ValueError, "NaN/Inf"):
                _validate_prediction(path, "chronos2")
            df.loc[0, "pred_return_4h"] = .01
            df.loc[df.variant.eq("finetuned"), "pred_close_4h"] = 0
            df.to_parquet(path, index=False)
            with self.assertRaisesRegex(ValueError, "nonpositive"):
                _validate_prediction(path, "chronos2")
            df = pd.DataFrame(rows).loc[lambda d: d.variant.eq("pretrained")]
            df.to_parquet(path, index=False)
            with self.assertRaisesRegex(ValueError, "pretrained and finetuned"):
                _validate_prediction(path, "chronos2")
            rank = pd.DataFrame({"symbol": ["S0"], "open_time": [1], "variant": ["other"], "score_long": [1.0], "score_short": [0.0]})
            rank.to_parquet(path, index=False)
            with self.assertRaisesRegex(ValueError, "trained"):
                _validate_prediction(path, "catboost")
            rank["variant"] = "trained"
            rank["score_long"] = np.inf
            rank.to_parquet(path, index=False)
            with self.assertRaisesRegex(ValueError, "infinite scores"):
                _validate_prediction(path, "catboost")


class RunnerUtilityTests(unittest.TestCase):
    def test_fingerprint_survives_checkout_and_environment_root_relocation(self) -> None:
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temp:
            base = Path(temp)
            roots = [base / "checkout-one", base / "checkout-two"]
            env_roots = [roots[0] / ".benchmark-envs", base / "separate-envs"]
            for index, (root, env_root) in enumerate(zip(roots, env_roots, strict=True)):
                module_dir = root / "research" / "model_benchmark"
                env_dir = env_root / "rank"
                module_dir.mkdir(parents=True)
                env_dir.mkdir(parents=True)
                (module_dir / "core.py").write_text("PORTABLE = 1\n", encoding="utf-8")
                (module_dir / "model-assets.lock.json").write_text('{"models":{}}\n', encoding="utf-8")
                (module_dir / "requirements-rank.lock.txt").write_text("catboost==1.2.8\n", encoding="utf-8")
                (env_dir / "requirements.lock").write_text("catboost==1.2.8\n", encoding="utf-8")
                (env_dir / "model-revision.json").write_text(json.dumps({"local_dir": str(root / f"weights-{index}")}), encoding="utf-8")
            source_id = {"dataset_version": "v3", "files": {"panel": "f" * 64}}
            fingerprints = []
            for root, env_root in zip(roots, env_roots, strict=True):
                with mock.patch.object(benchmark_config, "REPO_ROOT", root), \
                     mock.patch.object(benchmark_config, "ENV_ROOT", env_root):
                    fingerprints.append(benchmark_fingerprint("catboost", source_id))
            self.assertEqual(fingerprints[0], fingerprints[1])

    def test_portable_identity_omits_machine_paths_and_keeps_runtime_and_assets(self) -> None:
        source = {"dataset_version": "v3", "files": {"panel.parquet": "a" * 64}}
        envs = {
            "chronos": {"manifest": {
                "status": "ready", "python_version": "Python 3.12.14", "lock_sha256": "b" * 64,
                "runtime": {"system": "Linux", "machine": "x86_64", "python_version": "3.12.14",
                            "implementation": "cpython", "cache_tag": "cpython-312", "torch_version": "2.6.0+cu126",
                            "torch_cuda": "12.6", "pip_version": "25.1.1"},
                "model": {"repo_id": "amazon/chronos-2", "revision": "c" * 40,
                          "files": {"weights.safetensors": {"sha256": "d" * 64}}},
            }},
        }
        result = portable_identity(source, {"chronos2": "e" * 64}, envs)
        encoded = json.dumps(result, sort_keys=True)
        self.assertIn("2.6.0+cu126", encoded)
        self.assertIn("weights.safetensors", encoded)
        self.assertNotIn("D:\\\\", encoded)
        self.assertNotIn("/content/", encoded)

    def test_stage_event_snapshots_exact_manifest_and_only_hashes_final_run_relative_files(self) -> None:
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temp:
            run_dir = Path(temp) / "run-x"
            (run_dir / "models" / "attempt-1").mkdir(parents=True)
            (run_dir / "common_cohort.json").write_text('{"rows": []}\n', encoding="utf-8")
            state_bytes = b'{"run_id":"run-x","status":"RUNNING","models":{"catboost":{"active_attempt":"models/attempt-1","status":"RUNNING"}}}\n'
            (run_dir / "run_manifest.json").write_bytes(state_bytes)
            (run_dir / "models" / "attempt-1" / "attempt_identity.json").write_text(
                '{"fingerprint":"fp","model_key":"catboost"}\n', encoding="utf-8"
            )
            artifact = run_dir / "models" / "attempt-1" / "checkpoint.bin"
            artifact.write_bytes(b"immutable-checkpoint")
            event = emit_stage_event(
                run_dir, event="candidate_completed", model_key="catboost", stage="long_trial_1",
                portable_identity={"source_identity": {"dataset": "v3"}}, artifact_paths=[artifact],
                attempt_dir=artifact.parent,
            )
            snapshot = run_dir / event["snapshot_context"]["manifest_path"]
            self.assertEqual(snapshot.read_bytes(), state_bytes)
            (run_dir / "run_manifest.json").write_text('{"run_id":"run-x","status":"PARTIAL"}\n', encoding="utf-8")
            self.assertEqual(snapshot.read_bytes(), state_bytes)
            records = {entry["path"]: entry["sha256"] for entry in event["artifact_manifest"]}
            self.assertEqual(records["models/attempt-1/checkpoint.bin"], hash_file(artifact))
            self.assertIn("common_cohort.json", records)
            self.assertIn(event["snapshot_context"]["manifest_path"], records)
            self.assertIn("models/attempt-1/attempt_identity.json", records)
            self.assertEqual(event["attempt_dir"], "models/attempt-1")
            self.assertTrue(all("\\" not in name for name in records))

    def test_running_attempt_pointer_is_saved_before_worker_start(self) -> None:
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temp:
            run_dir = Path(temp) / "run-y"
            attempt = run_dir / "models" / "catboost" / "attempt-01"
            attempt.mkdir(parents=True)
            (run_dir / "run_manifest.json").write_text('{"run_id":"run-y","models":{}}\n', encoding="utf-8")
            (attempt / "attempt_identity.json").write_text(
                '{"fingerprint":"expected","model_key":"catboost","device":"cpu"}\n', encoding="utf-8"
            )
            _mark_attempt_running(run_dir, "catboost", attempt, "cpu", "expected")
            state = json.loads((run_dir / "run_manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(state["models"]["catboost"]["active_attempt"], "models/catboost/attempt-01")
            self.assertEqual(state["models"]["catboost"]["active_attempt_identity_sha256"],
                             hash_file(attempt / "attempt_identity.json"))
            second_attempt = run_dir / "models" / "catboost" / "attempt-02"
            second_attempt.mkdir(parents=True)
            (second_attempt / "attempt_identity.json").write_text(
                '{"fingerprint":"expected","model_key":"catboost","device":"cpu"}\n', encoding="utf-8"
            )
            _mark_attempt_running(run_dir, "catboost", second_attempt, "cpu", "expected")
            state = json.loads((run_dir / "run_manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(state["models"]["catboost"]["attempt_dirs"], [
                "models/catboost/attempt-01", "models/catboost/attempt-02",
            ])

    def test_posix_sigterm_is_an_interrupt_so_worker_finally_can_cleanup(self) -> None:
        with self.assertRaises(KeyboardInterrupt):
            _handle_posix_sigterm(signal.SIGTERM, None)
        with mock.patch("research.model_benchmark.runner.sys.platform", "linux"):
            previous = _install_posix_sigterm_handler()
            try:
                self.assertIs(signal.getsignal(signal.SIGTERM), _handle_posix_sigterm)
            finally:
                signal.signal(signal.SIGTERM, previous)

    def test_worker_action_events_archive_final_stdout_stderr_logs_on_success_and_failure(self) -> None:
        for exit_code in (0, 17):
            with self.subTest(exit_code=exit_code), tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temp:
                run_dir = Path(temp) / "run-log"
                attempt = run_dir / "models" / "catboost" / "attempt-01"
                attempt.mkdir(parents=True)
                (attempt / "attempt_identity.json").write_text(
                    '{"fingerprint":"fp","model_key":"catboost","device":"cpu"}\n', encoding="utf-8"
                )
                state_path = run_dir / "run_manifest.json"
                state_path.write_text(json.dumps({"run_id": run_dir.name, "status": "RUNNING",
                                                  "models": {"catboost": {"active_attempt": "models/catboost/attempt-01"}}}),
                                      encoding="utf-8")
                script = "import json,sys; print('worker stdout marker',flush=True); " \
                         "print('worker stderr marker',file=sys.stderr,flush=True); " \
                         f"print(json.dumps({{'ok': True, 'result': {{'trained': True}}}}),flush=True); sys.exit({exit_code})"

                def launch(_command, *, cwd, env):
                    return start_managed_process([sys.executable, "-u", "-c", script], cwd=cwd, env=env)

                with mock.patch("research.model_benchmark.runner._env_python", return_value=Path(sys.executable)), \
                     mock.patch("research.model_benchmark.runner.start_managed_process", side_effect=launch):
                    result, actual_exit, stderr = _run_worker(
                        "catboost", "train", attempt, run_dir, "cpu", True, "fp", {},
                        run_dir / "logs" / "catboost.log", state_path, {"fingerprints": {"catboost": "fp"}},
                    )
                final_log = Path(result["worker_log_path"])
                self.assertEqual(actual_exit, exit_code)
                self.assertEqual(result["worker_exit_code"], exit_code)
                self.assertEqual(result["worker_log_sha256"], hash_file(final_log))
                log_text = final_log.read_text(encoding="utf-8")
                self.assertIn("worker stdout marker", log_text)
                self.assertIn("worker stderr marker", log_text)
                event = json.loads((run_dir / "stage_events.jsonl").read_text(encoding="utf-8").splitlines()[-1])
                self.assertEqual(event["event"], "worker_action_completed")
                event_paths = {entry["path"] for entry in event["artifact_manifest"]}
                self.assertIn("models/catboost/attempt-01/logs/train.log", event_paths)
                self.assertIn("models/catboost/attempt-01/train-context.json", event_paths)
                later_event = emit_stage_event(
                    run_dir, event="checkpoint_saved", model_key="catboost", stage="next-stage",
                    portable_identity={"fingerprints": {"catboost": "fp"}}, attempt_dir=attempt,
                )
                later_paths = {entry["path"] for entry in later_event["artifact_manifest"]}
                self.assertIn("models/catboost/attempt-01/logs/train.log", later_paths)

    def test_linux_environment_interpreter_path_is_portable(self) -> None:
        root = Path("/opt/benchmark-envs")
        with mock.patch("research.model_benchmark.runner.ENV_ROOT", root), \
             mock.patch("research.model_benchmark.runner.sys.platform", "linux"):
            from research.model_benchmark.runner import _env_python
            self.assertEqual(_env_python("rank"), root / "rank" / "bin" / "python")

    def test_prediction_and_asset_contracts_follow_registry_not_model_keys(self) -> None:
        rank_spec = ModelSpec("thirdrank", "rank", "rank", "unused.module", "UnusedAdapter")
        forecast_spec = ModelSpec("newforecast", "forecast", "newforecast", "unused.module", "UnusedAdapter", True)
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temp:
            root = Path(temp)
            path = root / "predictions.parquet"
            with mock.patch.dict(REGISTRY, {"thirdrank": rank_spec, "newforecast": forecast_spec}):
                rank = pd.DataFrame({"symbol": ["S0"], "open_time": [1], "variant": ["trained"],
                                     "score_long": [1.0], "score_short": [0.0]})
                rank.to_parquet(path, index=False)
                self.assertEqual(_validate_prediction(path, "thirdrank"), {})
                forecast = pd.DataFrame({"symbol": ["S0", "S0"], "open_time": [1, 1],
                                         "variant": ["pretrained", "finetuned"], "pred_close_4h": [10.0, 11.0],
                                         "pred_return_4h": [0.0, 0.1]})
                forecast.to_parquet(path, index=False)
                self.assertEqual(set(_validate_prediction(path, "newforecast")), {"pretrained", "finetuned"})

                env_root = root / "envs"
                rank_env = env_root / "rank"
                rank_env.mkdir(parents=True)
                runtime = {"system": "Windows", "machine": "amd64", "python_version": "3.12.14",
                           "implementation": "cpython", "cache_tag": "cpython-312", "torch_version": None,
                           "torch_cuda": None}
                (rank_env / "environment-manifest.json").write_text(json.dumps({"status": "ready", "runtime": runtime}), encoding="utf-8")
                env_dir = env_root / "newforecast"
                env_dir.mkdir(parents=True)
                weight = env_dir / "pinned-model.bin"
                weight.write_bytes(b"pinned revision")
                manifest = {"status": "ready", "python_version": "Python 3.12.14", "runtime": runtime,
                            "model": {"status": "ready", "repo_id": "example/model",
                            "revision": "revision-1", "files": {weight.name: {"status": "ready", "path": str(weight),
                            "sha256": hash_file(weight)}}}}
                (env_dir / "environment-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
                with mock.patch("research.model_benchmark.runner.ENV_ROOT", env_root):
                    self.assertEqual(_env_identity("rank", "thirdrank")["manifest"]["status"], "ready")
                    identity = _env_identity("newforecast", "newforecast")
                    self.assertEqual(identity["manifest"]["model"]["revision"], "revision-1")
                    weight.write_bytes(b"modified revision")
                    with self.assertRaisesRegex(ValueError, "hash mismatch"):
                        _env_identity("newforecast", "newforecast")

    def test_failure_does_not_stop_later_model(self) -> None:
        visited = []
        def callback(key: str) -> dict:
            visited.append(key)
            if key == "bad":
                raise RuntimeError("expected")
            return {"status": "SUCCESS"}
        result = run_in_order(("bad", "good"), callback)
        self.assertEqual(visited, ["bad", "good"])
        self.assertEqual(result["bad"]["status"], "FAILED")
        self.assertEqual(result["good"]["status"], "SUCCESS")

    def test_resume_artifacts_require_matching_hash(self) -> None:
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temp:
            root = Path(temp)
            path = root / "artifact.bin"
            path.write_bytes(b"trained")
            good = {"artifact.bin": hash_file(path)}
            self.assertTrue(verify_artifacts(root, good))
            self.assertFalse(verify_artifacts(root, {"artifact.bin": "0" * 64}))

    def test_os_lock_rejects_live_owner_and_releases_after_process_exit(self) -> None:
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temp:
            lock = Path(temp) / "owner.lock"
            code = "\n".join([
                "from pathlib import Path", "import time", "from research.model_benchmark.common import exclusive_lock",
                f"with exclusive_lock(Path({str(lock)!r})):", " print('locked', flush=True)", " time.sleep(30)", "",
            ])
            proc = subprocess.Popen([sys.executable, "-c", code], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, cwd=Path(__file__).resolve().parents[3])
            try:
                first_line = proc.stdout.readline().strip()
                self.assertEqual(first_line, "locked", proc.stderr.read() if first_line == "" and proc.poll() is not None else "")
                with self.assertRaises(RuntimeError):
                    with exclusive_lock(lock):
                        pass
            finally:
                proc.kill()
                proc.wait(timeout=10)
                proc.stdout.close()
                proc.stderr.close()
            time.sleep(0.2)
            with exclusive_lock(lock):
                pass

    def test_cli_rejects_conflicting_run_options(self) -> None:
        with self.assertRaises(SystemExit):
            main(["--new-run", "--run-dir", "relative"])

    def test_baseline_metrics_attach_without_four_model_key_error_and_report_status(self) -> None:
        baseline_metrics = {"directions": {"long": {"ndcg_at_5": .5, "ic": .2, "top5_mean_net_return": .01}}}
        for status in ("PASSED", "FAILED"):
            with self.subTest(status=status), tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temp:
                models = {"catboost": {"status": "SUCCESS"}}
                baseline = {"status": status}
                common = {"models": {"catboost": {"directions": {"long": {"groups": 1}}},
                                     "lightgbm_existing": baseline_metrics}}
                attach_common_metrics(models, common, baseline)
                self.assertIn("common_metrics", models["catboost"])
                self.assertEqual(baseline["common_metrics"], baseline_metrics)
                run_dir = Path(temp)
                write_reports(run_dir, {"status": "PARTIAL", "smoke": False},
                              {"models": models, "common_summary": common, "lightgbm_baseline": baseline})
                report = (run_dir / "comparison.md").read_text(encoding="utf-8")
                self.assertIn(f"**{status}**", report)
                self.assertNotIn("adapter 未提供微調前獨立預測指標", report)
                self.assertTrue((run_dir / "comparison.csv").is_file())

    def test_powershell_launcher_mutex_spans_bootstrap_and_runner(self) -> None:
        script = (Path(__file__).resolve().parents[3] / "scripts" / "run-model-benchmark.ps1").read_text(encoding="utf-8-sig")
        acquire = script.index("$mutex.WaitOne(0)")
        bootstrap = script.index("research.model_benchmark.bootstrap")
        runner = script.index("& $mainPython @runnerArgs")
        release = script.index("$mutex.ReleaseMutex()")
        self.assertLess(acquire, bootstrap)
        self.assertLess(bootstrap, runner)
        self.assertGreater(release, runner)

    def test_managed_worker_close_terminates_sleeping_descendant(self) -> None:
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temp:
            root = Path(temp)
            pid_path = root / "descendant.pid"
            child_code = "import time; time.sleep(60)"
            controller_code = "\n".join([
                "import subprocess,sys,time", "from pathlib import Path",
                f"child=subprocess.Popen([sys.executable,'-c',{child_code!r}])",
                f"Path({str(pid_path)!r}).write_text(str(child.pid))", "time.sleep(60)", "",
            ])
            proc = start_managed_process([sys.executable, "-c", controller_code], cwd=root, env=os.environ.copy())
            deadline = time.time() + 10
            while not pid_path.exists() and time.time() < deadline:
                time.sleep(.05)
            self.assertTrue(pid_path.exists(), "worker did not start its controlled sleep child")
            descendant_pid = int(pid_path.read_text(encoding="ascii"))
            proc.close(kill_tree=True)
            if os.name == "nt":
                kernel = ctypes.WinDLL("kernel32", use_last_error=True)
                kernel.OpenProcess.argtypes = [ctypes.c_uint, ctypes.c_int, ctypes.c_uint]
                kernel.OpenProcess.restype = ctypes.c_void_p
                kernel.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint]
                kernel.WaitForSingleObject.restype = ctypes.c_uint
                kernel.CloseHandle.argtypes = [ctypes.c_void_p]
                handle = kernel.OpenProcess(0x00100000 | 0x1000, False, descendant_pid)
                if handle:
                    try:
                        self.assertEqual(kernel.WaitForSingleObject(handle, 5000), 0)
                    finally:
                        kernel.CloseHandle(handle)
                else:
                    self.assertEqual(ctypes.get_last_error(), 87, "controlled descendant still exists or cannot be queried")
            else:
                with self.assertRaises(ProcessLookupError):
                    os.kill(descendant_pid, 0)

    def test_integrity_skip_requires_matching_config_artifact_and_fresh_prediction(self) -> None:
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temp:
            run_dir = Path(temp)
            attempt = run_dir / "attempt"
            attempt.mkdir()
            artifact = attempt / "trained.bin"
            artifact.write_bytes(b"weights")
            prediction = attempt / "predictions.parquet"
            prediction.write_bytes(b"prediction")
            item = {"fingerprint": "config-v1", "status": "SUCCESS", "attempt_dir": str(attempt),
                    "training": {"trained": True}, "predict": {"fresh_load": True, "predictions_sha256": hash_file(prediction)},
                    "artifact_hashes": {"trained.bin": hash_file(artifact)}}
            # Model-stage events are emitted before reporting, so model reuse
            # must not depend on comparison.md existing yet.
            self.assertFalse((run_dir / "comparison.md").exists())
            self.assertTrue(_model_integrity(item, run_dir, "config-v1"))
            self.assertFalse(_model_integrity(item, run_dir, "config-v2"))
            item["artifact_hashes"] = {"trained.bin": "0" * 64}
            self.assertFalse(_model_integrity(item, run_dir, "config-v1"))
            item["artifact_hashes"] = {"trained.bin": hash_file(artifact)}
            item["predict"]["fresh_load"] = False
            self.assertFalse(_model_integrity(item, run_dir, "config-v1"))

    def test_completed_run_is_reported_without_retraining(self) -> None:
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temp:
            runs = Path(temp) / "runs"
            completed = runs / "complete-001"
            completed.mkdir(parents=True)
            (completed / "run_manifest.json").write_text("{}", encoding="utf-8")
            with mock.patch("research.model_benchmark.runner.RUNS_ROOT", runs), \
                 mock.patch("research.model_benchmark.runner._completed_run_is_valid", return_value=True), \
                 mock.patch("research.model_benchmark.runner._make_run", side_effect=AssertionError("must not retrain")):
                self.assertEqual(main(["--run-dir", str(completed)]), 0)


class RunnerIntegrationTests(unittest.TestCase):
    def test_cuda_oom_retries_cpu_and_rejects_non_fresh_prediction(self) -> None:
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temp:
            root = Path(temp)
            calls: list[tuple[str, str]] = []

            def worker(key, action, attempt, run_dir, device, smoke, fingerprint, env_identity, log_path, state_path, portable_id=None):
                calls.append((action, device))
                if action == "train" and device == "cuda":
                    return {}, 1, "CUDA out of memory"
                if action == "train":
                    artifact = attempt / "nested" / "weights.bin"
                    artifact.parent.mkdir(parents=True, exist_ok=True)
                    artifact.write_bytes(b"trained")
                    return {"trained": True, "training_steps": 1, "training_device": "cpu",
                            "artifact_hashes": {str(artifact.relative_to(attempt)): hash_file(artifact)}}, 0, ""
                frame = pd.DataFrame({"symbol": ["S00", "S00"], "open_time": [1, 1], "variant": ["pretrained", "finetuned"],
                                     "pred_close_4h": [100.0, 101.0], "pred_return_4h": [0.0, 0.01]})
                frame.to_parquet(attempt / "predictions.parquet", index=False)
                return {"fresh_load": True, "predictions_sha256": hash_file(attempt / "predictions.parquet")}, 0, ""

            with mock.patch("research.model_benchmark.runner._run_worker", side_effect=worker):
                result = _execute_model("chronos2", root, False, "fp", {}, set(), lambda key: None)
            self.assertEqual(result["status"], "SUCCESS")
            self.assertEqual(result["device"], "cpu")
            self.assertEqual(calls, [("train", "cuda"), ("train", "cpu"), ("predict", "cpu")])
            self.assertIn("retrying CPU", result["failures"][0]["error"])
            self.assertIn("nested/weights.bin", result["artifact_hashes"])
            self.assertTrue(all("\\" not in key for key in result["artifact_hashes"]))

            calls.clear()
            def stale_predict_worker(key, action, attempt, run_dir, device, smoke, fingerprint, env_identity, log_path, state_path, portable_id=None):
                calls.append((action, device))
                if action == "train":
                    artifact = attempt / "weights.bin"
                    artifact.write_bytes(b"trained")
                    return {"trained": True, "training_steps": 1,
                            "artifact_hashes": {"weights.bin": hash_file(artifact)}}, 0, ""
                frame = pd.DataFrame({"symbol": ["S00", "S00"], "open_time": [1, 1], "variant": ["pretrained", "finetuned"],
                                     "pred_close_4h": [100.0, 101.0], "pred_return_4h": [0.0, 0.01]})
                frame.to_parquet(attempt / "predictions.parquet", index=False)
                return {"fresh_load": False, "predictions_sha256": hash_file(attempt / "predictions.parquet")}, 0, ""

            with mock.patch("research.model_benchmark.runner._run_worker", side_effect=stale_predict_worker):
                stale = _execute_model("chronos2", root / "stale", False, "fp", {}, set(), lambda key: None)
            self.assertEqual(stale["status"], "FAILED")
            self.assertIn("fresh-load", stale["failures"][-1]["error"])

    def test_only_four_successful_evaluated_models_yield_success(self) -> None:
        for failed_key, expected_status in ((None, "SUCCESS"), ("timesfm25", "PARTIAL")):
            with self.subTest(failed_key=failed_key), tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as temp:
                run_dir = Path(temp) / "run"
                run_dir.mkdir()
                panel = pd.DataFrame()
                cohort = pd.DataFrame({"symbol": ["S00"], "open_time": [1]})
                envs = {"rank": {}, "chronos": {}, "timesfm": {}}
                fingerprints = {key: f"fp-{key}" for key in MODEL_KEYS}

                def execute(key, directory, smoke, fingerprint, env_identity, expected_pairs, identity_check, portable_id=None):
                    if key == failed_key:
                        return {"status": "FAILED", "evaluation_status": "FAILED"}
                    attempt = run_dir / "models" / key
                    attempt.mkdir(parents=True, exist_ok=True)
                    prediction = attempt / "predictions.parquet"
                    pd.DataFrame({"symbol": ["S00"], "open_time": [1], "variant": ["trained"],
                                  "score_long": [1.0], "score_short": [1.0]}).to_parquet(prediction, index=False)
                    return {"status": "SUCCESS", "fingerprint": fingerprint, "attempt_dir": str(attempt),
                            "training": {"trained": True}, "predict": {"fresh_load": True},
                            "predictions_path": str(prediction), "evaluation_status": "PENDING"}

                def common_metrics(predictions, frozen, source):
                    return {"intersection_groups": 1, "models": {
                        key: ({"evaluated_groups": 1, "directions": {"long": {}, "short": {}}}
                              if key in ("catboost", "xgboost", "lightgbm_existing") else {"samples": 1})
                        for key in predictions
                    }}

                def fake_lgbm(panel, cohort, directory):
                    baseline = pd.DataFrame({"symbol": ["S00"], "open_time": [1], "variant": ["frozen_existing_lgbm"],
                                             "score_long": [1.0], "score_short": [1.0]})
                    return baseline, {"status": "PASSED"}

                with mock.patch("research.model_benchmark.runner.load_source", return_value=(panel, pd.DataFrame(), {"dataset_version": "unit"})), \
                     mock.patch("research.model_benchmark.runner.freeze_common_cohort", return_value=(cohort, {"rows": 1})), \
                     mock.patch("research.model_benchmark.runner._current_identity", return_value=(envs, fingerprints)), \
                     mock.patch("research.model_benchmark.runner.dataset_identity", return_value={"dataset_version": "unit"}), \
                     mock.patch("research.model_benchmark.runner._env_identity", return_value={}), \
                     mock.patch("research.model_benchmark.runner.benchmark_fingerprint", side_effect=lambda key, source, smoke: fingerprints[key]), \
                     mock.patch("research.model_benchmark.runner._execute_model", side_effect=execute), \
                     mock.patch("research.model_benchmark.runner.evaluate_ranker", return_value={"evaluated_groups": 1, "directions": {"long": {}, "short": {}}}), \
                     mock.patch("research.model_benchmark.runner.evaluate_forecaster", return_value={"samples": 1}), \
                     mock.patch("research.model_benchmark.runner.evaluate_common", side_effect=common_metrics), \
                     mock.patch("research.model_benchmark.runner._lightgbm_predictions", side_effect=fake_lgbm):
                    result = _make_run(run_dir, False, False)
                self.assertEqual(result["status"], expected_status)


if __name__ == "__main__":
    unittest.main()
