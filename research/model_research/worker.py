"""
JSONL Worker for Collector <-> Python Model Research execution.
Protocol rule:
- `stdout` is strictly reserved for JSONL protocol messages (`{"event": ...}`).
- All library logs, warnings, and diagnostics go to `stderr`.
- Never downloads weights, installs packages, or trains models during a worker `run` or `status` request.
- Commits run artifacts atomically to `data/model-research/<run-id>/` while preserving previous runs.
"""

from __future__ import annotations

import contextlib
import hashlib
import json
import os
import re
import shutil
import sys
import time
import traceback
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

# Keep reference to original stdout for JSONL protocol; only redirect sys.stdout to stderr inside main()
_PROTOCOL_STDOUT = sys.stdout


def emit_protocol(payload: dict[str, Any]) -> None:
    line = json.dumps(payload, ensure_ascii=False)
    _PROTOCOL_STDOUT.write(line + "\n")
    _PROTOCOL_STDOUT.flush()


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def atomic_write_json(target_path: Path, data: dict[str, Any]) -> None:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = target_path.parent / f".{target_path.name}.{uuid.uuid4().hex}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, target_path)


def resolve_data_dir(req: dict[str, Any]) -> Path:
    data_dir = Path(req.get("dataDir") or os.environ.get("FADACHI_DATA") or "data").resolve()
    if not (data_dir / "model-research" / "datasets" / "klines_1h.parquet").exists():
        root_data = (Path.cwd() / "data").resolve()
        if (
            (root_data / "model-research" / "datasets" / "klines_1h.parquet").exists()
            and data_dir.parts[-3:] == ("apps", "collector", "data")
        ):
            return root_data
    return data_dir


def handle_status(req: dict[str, Any]) -> dict[str, Any]:
    from .kronos_runner import KRONOS_INFERENCE_CONFIG, check_kronos_installed, get_gpu_environment_info

    data_dir = resolve_data_dir(req)
    mr_dir = data_dir / "model-research"
    datasets_dir = mr_dir / "datasets"
    models_dir = mr_dir / "models"
    weights_dir = mr_dir / "weights"
    eval_dir = mr_dir / "evaluation"

    dataset_manifest_path = datasets_dir / "dataset_manifest.json"
    klines_path = datasets_dir / "klines_1h.parquet"
    dataset_ready = dataset_manifest_path.exists() and klines_path.exists()
    dataset_manifest: dict[str, Any] | None = None
    if dataset_manifest_path.exists():
        try:
            with open(dataset_manifest_path, "r", encoding="utf-8") as f:
                dataset_manifest = json.load(f)
        except Exception:
            dataset_manifest = None

    lgbm_meta_path = models_dir / "lgbm_metadata.json"
    lgbm_long_path = models_dir / "lgbm_long_ranker.txt"
    lgbm_short_path = models_dir / "lgbm_short_ranker.txt"
    lgbm_ready = lgbm_meta_path.exists() and lgbm_long_path.exists() and lgbm_short_path.exists()
    lgbm_meta: dict[str, Any] | None = None
    if lgbm_meta_path.exists():
        try:
            with open(lgbm_meta_path, "r", encoding="utf-8") as f:
                lgbm_meta = json.load(f)
        except Exception:
            lgbm_meta = None

    small_status = check_kronos_installed(weights_dir, "small")
    base_status = check_kronos_installed(weights_dir, "base")

    offline_comp_path = eval_dir / "offline_comparison.json"
    offline_comp: dict[str, Any] | None = None
    if offline_comp_path.exists():
        try:
            with open(offline_comp_path, "r", encoding="utf-8") as f:
                offline_comp = json.load(f)
        except Exception:
            offline_comp = None

    gpu_env = get_gpu_environment_info()

    return {
        "pythonExecutable": sys.executable,
        "pythonVersion": sys.version.split()[0],
        "gpuEnvironment": gpu_env,
        "datasetReady": dataset_ready,
        "datasetVersion": dataset_manifest.get("datasetVersion") if dataset_manifest else None,
        "datasetCutoffTime": dataset_manifest.get("boundaries", {}).get("testEndMs") if dataset_manifest else None,
        "universeSymbols": dataset_manifest.get("universe", {}).get("symbols", []) if dataset_manifest else [],
        "insufficientSymbols": dataset_manifest.get("insufficientSymbols", []) if dataset_manifest else [],
        "lightgbmReady": lgbm_ready,
        "artifactWarnings": [
            "資料或 LightGBM 模型早於 v3 資金費結算名目價值修正；既有離線數值未反映新版成本。"
        ] if dataset_manifest and lgbm_meta and (
            dataset_manifest.get("pipelineVersion", 1) < 3 or lgbm_meta.get("pipeline_version", 1) < 3
        ) else [],
        "lightgbmMetadata": {
            "longSha256": lgbm_meta.get("long_model", {}).get("sha256") if lgbm_meta else None,
            "shortSha256": lgbm_meta.get("short_model", {}).get("sha256") if lgbm_meta else None,
            "selectedParamsLong": lgbm_meta.get("long_model", {}).get("selected_params") if lgbm_meta else None,
            "selectedParamsShort": lgbm_meta.get("short_model", {}).get("selected_params") if lgbm_meta else None,
            "validationMetrics": lgbm_meta.get("validation_metrics") if lgbm_meta else None,
            "testMetrics": lgbm_meta.get("test_metrics") if lgbm_meta else None,
        }
        if lgbm_meta
        else None,
        "kronosModels": {
            "small": small_status,
            "base": base_status,
        },
        "inferenceConfig": KRONOS_INFERENCE_CONFIG,
        "offlineComparisonReady": offline_comp is not None,
        "offlineComparison": offline_comp,
    }


def handle_run(req: dict[str, Any]) -> dict[str, Any]:
    import pandas as pd

    from .features_and_labels import ONE_HOUR_MS, validate_and_deduplicate_1h
    from .kronos_runner import (
        KRONOS_INFERENCE_CONFIG,
        KronosModelMissingError,
        KronosOutOfMemoryError,
        check_kronos_installed,
        infer_kronos_for_candidates,
        normalize_model_key,
    )
    from .lightgbm_ranker import load_lightgbm_models, rank_at_cutoff

    data_dir = resolve_data_dir(req)
    run_id = str(req.get("runId") or f"run-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}")
    # A run ID is a single immutable directory name, never a path or reserved folder.
    if not re.fullmatch(r"run-[A-Za-z0-9_-]{1,120}", run_id):
        raise ValueError("runId 必須為 run- 開頭的英數字、底線或連字號")
    final_run_dir = data_dir / "model-research" / run_id
    if final_run_dir.exists():
        raise FileExistsError(f"研究 runId 已存在，拒絕覆寫：{run_id}")
    kronos_model_key = normalize_model_key(req.get("kronosModel") or "small")
    now_ms = int(time.time() * 1000)
    cutoff_ms = int(req["cutoffTime"]) if req.get("cutoffTime") is not None else now_ms
    if cutoff_ms < 0 or cutoff_ms > now_ms:
        raise ValueError("cutoffTime 必須為非負且不晚於目前時間的毫秒時間戳")
    require_cuda = bool(req.get("requireCuda", True))

    # Optional test fault injection flags for unit/integration testing of worker failure modes
    simulate_mode = req.get("_simulateFailure")
    if simulate_mode == "OOM":
        raise KronosOutOfMemoryError("Simulated CUDA out of memory during Kronos inference")
    if simulate_mode == "MODEL_MISSING":
        raise KronosModelMissingError("Simulated missing model weights")

    mr_dir = data_dir / "model-research"
    datasets_dir = mr_dir / "datasets"
    models_dir = mr_dir / "models"
    weights_dir = mr_dir / "weights"
    eval_dir = mr_dir / "evaluation"

    klines_path = datasets_dir / "klines_1h.parquet"
    dataset_manifest_path = datasets_dir / "dataset_manifest.json"
    if not klines_path.exists() or not dataset_manifest_path.exists():
        raise FileNotFoundError("研究資料集 Parquet 尚未準備（請先執行資料準備命令，POST 推論不會自動下載）")

    kronos_check = check_kronos_installed(weights_dir, kronos_model_key)
    if not kronos_check["installed"]:
        raise KronosModelMissingError(
            f"Kronos-{kronos_model_key} 權重或 Tokenizer 尚未安裝（POST 推論不會自動下載）"
        )

    long_booster, short_booster, lgbm_meta = load_lightgbm_models(models_dir)

    with open(dataset_manifest_path, "r", encoding="utf-8") as f:
        dataset_manifest = json.load(f)

    artifact_warnings = []
    if dataset_manifest.get("pipelineVersion", 1) < 3 or lgbm_meta.get("pipeline_version", 1) < 3:
        artifact_warnings.append(
            "資料或 LightGBM 模型早於 v3 結算名目價值資金費標籤；本次排名未更新的成本模型。"
        )

    df_1h = pd.read_parquet(klines_path)
    funding_path = datasets_dir / "funding_rates.parquet"
    df_funding = pd.read_parquet(funding_path) if funding_path.exists() else None

    # Merge optional supplemental closed 1h klines Parquet exported by collector (never opening live DuckDB)
    extra_parquet = req.get("supplementalKlinesParquet")
    if extra_parquet and Path(extra_parquet).exists():
        extra_df = pd.read_parquet(extra_parquet)
        df_1h = pd.concat([df_1h, extra_df], ignore_index=True)

    df_1h, _ = validate_and_deduplicate_1h(df_1h, cutoff_ms=cutoff_ms)

    t0 = time.perf_counter()
    ranking_res = rank_at_cutoff(
        df_1h=df_1h,
        long_booster=long_booster,
        short_booster=short_booster,
        feature_columns=lgbm_meta.get("feature_columns"),
        cutoff_ms=cutoff_ms,
        df_funding=df_funding,
        top_k=5,
    )
    lgbm_elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 2)

    if ranking_res["status"] != "OK":
        generated_at = int(time.time() * 1000)
        c_time = int(ranking_res.get("cutoff_time") or cutoff_ms or generated_at)
        insufficient_list = ranking_res.get("insufficient_symbols", [])
        insufficient_payload = {
            "runId": run_id,
            "status": "INSUFFICIENT_DATA",
            "market": "futures",
            "kronosModel": kronos_model_key,
            "cutoffTime": c_time,
            "expiresAt": c_time + ONE_HOUR_MS,
            "generatedAt": generated_at,
            "generatedAtIso": datetime.fromtimestamp(generated_at / 1000.0, tz=timezone.utc).isoformat(),
            "reason": ranking_res.get("reason", "合格標的不足 10 檔"),
            "eligibleCount": ranking_res.get("eligible_count", 0),
            "insufficientSymbols": insufficient_list,
            "dataset": {
                "datasetVersion": dataset_manifest.get("datasetVersion"),
                "klinesSha256": sha256_file(klines_path),
                "universeSelectedAt": dataset_manifest.get("universe", {}).get("selectedAt"),
                "universeSymbols": dataset_manifest.get("universe", {}).get("symbols", []),
                "eligibleCount": ranking_res.get("eligible_count", 0),
                "insufficientSymbols": insufficient_list,
            },
            "rankings": {
                "longTop5": [],
                "shortTop5": [],
                "allRankings": [],
                "conflictSymbols": [],
            },
            "forecasts": {},
            "warnings": [ranking_res.get("reason", "合格標的不足 10 檔")],
        }
        atomic_write_json(mr_dir / run_id / "result.json", insufficient_payload)
        return insufficient_payload

    decision_open_time = int(ranking_res["decision_open_time"])
    decision_cutoff_time = int(ranking_res["cutoff_time"])
    expires_at = decision_cutoff_time + ONE_HOUR_MS

    kronos_res = infer_kronos_for_candidates(
        df_1h=df_1h,
        candidate_symbols=ranking_res["kronos_target_symbols"],
        decision_open_time=decision_open_time,
        weights_root=weights_dir,
        model_key=kronos_model_key,
        require_cuda=require_cuda,
    )

    offline_comp: dict[str, Any] | None = None
    offline_comp_path = eval_dir / "offline_comparison.json"
    if offline_comp_path.exists():
        try:
            with open(offline_comp_path, "r", encoding="utf-8") as f:
                offline_comp = json.load(f)
        except Exception:
            offline_comp = None

    warnings_list: list[str] = artifact_warnings + [
        "本資料集為目前可交易幣種的歷史試驗，存在存活與選擇偏差，不得稱為歷史全市場驗證。",
        "LightGBM 分數為相對排名分數（Ranking Score），不得轉稱勝率或預期報酬。",
        "Kronos 抽樣範圍僅代表 5 次抽樣之離散程度，不得稱為校準信賴區間；且預訓練資料重疊未知。",
    ]
    if ranking_res["conflict_symbols"]:
        warnings_list.append(
            f"多空排名衝突標的：{', '.join(ranking_res['conflict_symbols'])} 同時出現在多頭與空頭 Top 5。"
        )
    for sk in kronos_res.get("skippedSymbols", []):
        warnings_list.append(f"{sk['symbol']} 略過 Kronos 推論：{sk['reason']}")

    # All candidates missing a 256-bar window is not a successful forecast run.
    run_status = "SUCCESS" if kronos_res["forecasts"] else "INSUFFICIENT_DATA"

    generated_at = int(time.time() * 1000)
    klines_sha256 = sha256_file(klines_path)

    result_doc: dict[str, Any] = {
        "runId": run_id,
        "status": run_status,
        "reason": None if run_status == "SUCCESS" else "所有候選標的皆缺少連續 256 根已收盤 K 線，未產生 Kronos 預測",
        "market": "futures",
        "kronosModel": kronos_model_key,
        "decisionOpenTime": decision_open_time,
        "cutoffTime": decision_cutoff_time,
        "expiresAt": expires_at,
        "generatedAt": generated_at,
        "generatedAtIso": datetime.fromtimestamp(generated_at / 1000.0, tz=timezone.utc).isoformat(),
        "models": {
            "lightgbm": {
                "family": "LightGBM-LGBMRanker",
                "device": "cpu",
                "longSha256": lgbm_meta["long_model"]["sha256"],
                "shortSha256": lgbm_meta["short_model"]["sha256"],
                "selectedParamsLong": lgbm_meta["long_model"]["selected_params"],
                "selectedParamsShort": lgbm_meta["short_model"]["selected_params"],
                "elapsedMs": lgbm_elapsed_ms,
            },
            "kronos": {
                "modelKey": kronos_model_key,
                "repoId": kronos_res["modelInfo"]["repoId"],
                "revision": kronos_res["modelInfo"]["revision"],
                "modelSha256": kronos_res["modelInfo"]["modelSha256"],
                "tokenizerRepoId": kronos_res["modelInfo"]["tokenizerRepoId"],
                "tokenizerRevision": kronos_res["modelInfo"]["tokenizerRevision"],
                "tokenizerSha256": kronos_res["modelInfo"]["tokenizerSha256"],
                "inferenceConfig": KRONOS_INFERENCE_CONFIG,
                "targetSymbols": kronos_res["targetSymbols"],
                "totalElapsedMs": kronos_res["totalElapsedMs"],
                "peakVramAllocatedMb": kronos_res["peakVramAllocatedMb"],
                "peakVramReservedMb": kronos_res["peakVramReservedMb"],
                "gpuEnvironment": kronos_res["gpuEnv"],
            },
        },
        "dataset": {
            "datasetVersion": dataset_manifest.get("datasetVersion"),
            "klinesSha256": klines_sha256,
            "universeSelectedAt": dataset_manifest.get("universe", {}).get("selectedAt"),
            "universeSymbols": dataset_manifest.get("universe", {}).get("symbols", []),
            "eligibleCount": ranking_res["eligible_count"],
            "insufficientSymbols": ranking_res["insufficient_symbols"] or dataset_manifest.get("insufficientSymbols", []),
        },
        "rankings": {
            "longTop5": ranking_res["long_top5"],
            "shortTop5": ranking_res["short_top5"],
            "allRankings": ranking_res["all_rankings"],
            "conflictSymbols": ranking_res["conflict_symbols"],
        },
        "forecasts": kronos_res["forecasts"],
        "offlineComparison": offline_comp,
        "warnings": warnings_list,
    }

    # Atomic commit to `data/model-research/<run-id>/`
    runs_root = mr_dir
    runs_root.mkdir(parents=True, exist_ok=True)
    staging_dir = runs_root / f".staging-{run_id}-{uuid.uuid4().hex[:8]}"
    final_run_dir = runs_root / run_id

    try:
        staging_dir.mkdir(parents=True, exist_ok=True)
        result_file = staging_dir / "result.json"
        config_file = staging_dir / "config.json"
        manifest_file = staging_dir / "manifest.json"

        with open(result_file, "w", encoding="utf-8") as f:
            json.dump(result_doc, f, ensure_ascii=False, indent=2)

        config_doc = {
            "runId": run_id,
            "kronosModel": kronos_model_key,
            "kronosInferenceConfig": KRONOS_INFERENCE_CONFIG,
            "lightgbmFeatureColumns": lgbm_meta.get("feature_columns"),
            "lightgbmLongParams": lgbm_meta["long_model"]["selected_params"],
            "lightgbmShortParams": lgbm_meta["short_model"]["selected_params"],
        }
        with open(config_file, "w", encoding="utf-8") as f:
            json.dump(config_doc, f, ensure_ascii=False, indent=2)

        # Copy offline comparison artifacts into the run directory if available
        for fname in ["offline_comparison.json", "offline_comparison.csv", "offline_comparison_report.md"]:
            src_f = eval_dir / fname
            if src_f.exists():
                shutil.copy2(src_f, staging_dir / fname)

        run_manifest = {
            "runId": run_id,
            "createdAt": generated_at,
            "cutoffTime": decision_cutoff_time,
            "expiresAt": expires_at,
            "kronosModel": kronos_model_key,
            "datasetVersion": dataset_manifest.get("datasetVersion"),
            "dataSha256": {
                "klines_1h.parquet": klines_sha256,
            },
            "modelSha256": {
                "lgbm_long_ranker.txt": lgbm_meta["long_model"]["sha256"],
                "lgbm_short_ranker.txt": lgbm_meta["short_model"]["sha256"],
                f"Kronos-{kronos_model_key}/model.safetensors": kronos_res["modelInfo"]["modelSha256"],
                "Kronos-Tokenizer-base/model.safetensors": kronos_res["modelInfo"]["tokenizerSha256"],
            },
            "resultSha256": sha256_file(result_file),
            "configSha256": sha256_file(config_file),
        }
        with open(manifest_file, "w", encoding="utf-8") as f:
            json.dump(run_manifest, f, ensure_ascii=False, indent=2)

        # rename refuses an existing non-empty run directory; never delete prior runs.
        if final_run_dir.exists():
            raise FileExistsError(f"研究 runId 已存在，拒絕覆寫：{run_id}")
        os.rename(staging_dir, final_run_dir)

        if run_status == "SUCCESS":
            atomic_write_json(
                runs_root / "latest-run.json",
                {
                    "runId": run_id,
                    "kronosModel": kronos_model_key,
                    "cutoffTime": decision_cutoff_time,
                    "expiresAt": expires_at,
                    "generatedAt": generated_at,
                    "resultPath": str((final_run_dir / "result.json").relative_to(data_dir)),
                },
            )
    finally:
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)

    return result_doc


def main() -> int:
    global _PROTOCOL_STDOUT
    _PROTOCOL_STDOUT = sys.stdout
    sys.stdout = sys.stderr
    from .kronos_runner import KronosModelMissingError, KronosOutOfMemoryError

    raw_line = sys.stdin.readline()
    if not raw_line:
        emit_protocol(
            {
                "event": "error",
                "errorCode": "EMPTY_REQUEST",
                "message": "Worker received empty stdin request",
            }
        )
        return 1

    try:
        req = json.loads(raw_line.strip())
    except Exception as exc:
        emit_protocol(
            {
                "event": "error",
                "errorCode": "INVALID_JSON_REQUEST",
                "message": f"Invalid JSON request: {exc}",
            }
        )
        return 1

    try:
        if not isinstance(req, dict):
            raise ValueError("Worker request 必須為 JSON object")
        action = req.get("action")
        with contextlib.redirect_stdout(sys.stderr):
            if action == "status":
                res = handle_status(req)
                emit_protocol({"event": "result", "data": res})
                return 0
            elif action == "run":
                res = handle_run(req)
                emit_protocol({"event": "result", "data": res})
                return 0
            else:
                emit_protocol(
                    {
                        "event": "error",
                        "errorCode": "UNKNOWN_ACTION",
                        "message": f"Unsupported worker action: {action}",
                    }
                )
                return 1
    except KronosOutOfMemoryError as exc:
        sys.stderr.write(traceback.format_exc() + "\n")
        emit_protocol(
            {
                "event": "error",
                "errorCode": "CUDA_OOM",
                "message": str(exc),
            }
        )
        return 2
    except (KronosModelMissingError, FileNotFoundError) as exc:
        sys.stderr.write(traceback.format_exc() + "\n")
        emit_protocol(
            {
                "event": "error",
                "errorCode": "MODEL_OR_DATA_MISSING",
                "message": str(exc),
            }
        )
        return 3
    except Exception as exc:
        sys.stderr.write(traceback.format_exc() + "\n")
        emit_protocol(
            {
                "event": "error",
                "errorCode": "WORKER_EXECUTION_ERROR",
                "message": str(exc),
            }
        )
        return 1


if __name__ == "__main__":
    sys.exit(main())
