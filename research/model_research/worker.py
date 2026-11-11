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


class DataNotReadyError(RuntimeError):
    """Raised when live market bars at targetCutoffTime are incomplete or stale."""


def _inspect_rolling_pipeline_status(data_dir: Path) -> dict[str, Any]:
    from .chronos_runner import rolling_installed_status
    from .rolling_store import DEFAULT_WINDOW_DAYS, resolve_live_paths

    paths = resolve_live_paths(data_dir)
    dataset_state: dict[str, Any] = {}
    if paths.state_path.is_file():
        try:
            dataset_state = json.loads(paths.state_path.read_text(encoding="utf-8"))
        except Exception:
            dataset_state = {}

    lgbm_current: dict[str, Any] = {}
    if paths.lgbm_current_path.is_file():
        try:
            lgbm_current = json.loads(paths.lgbm_current_path.read_text(encoding="utf-8"))
        except Exception:
            lgbm_current = {}

    chronos_status = rolling_installed_status(data_dir)
    chronos_current: dict[str, Any] = {}
    if paths.chronos_current_path.is_file():
        try:
            chronos_current = json.loads(paths.chronos_current_path.read_text(encoding="utf-8"))
        except Exception:
            chronos_current = {}

    chronos_train_state: dict[str, Any] = {}
    if paths.chronos_status_path.is_file():
        try:
            chronos_train_state = json.loads(paths.chronos_status_path.read_text(encoding="utf-8"))
        except Exception:
            chronos_train_state = {}

    lgbm_ready = bool(
        lgbm_current.get("versionId")
        and (paths.lgbm_versions_dir / str(lgbm_current["versionId"]) / "lgbm_long_ranker.txt").is_file()
        and (paths.lgbm_versions_dir / str(lgbm_current["versionId"]) / "lgbm_short_ranker.txt").is_file()
    )

    retrain_hours = int(chronos_current.get("retrainIntervalHours") or chronos_train_state.get("retrainIntervalHours") or 6)
    trained_at = chronos_status.get("trainedAt") or chronos_current.get("trainedAt")
    next_retrain_at = (
        chronos_status.get("nextRetrainAt")
        or chronos_current.get("nextRetrainAt")
        or (int(trained_at) + retrain_hours * 3_600_000 if trained_at else None)
    )

    return {
        "mode": "local-rolling",
        "windowDays": int(dataset_state.get("windowDays") or DEFAULT_WINDOW_DAYS),
        "datasetReady": bool(paths.klines_path.is_file() and dataset_state.get("lastCutoffTime")),
        "datasetVersion": dataset_state.get("datasetVersion"),
        "lastCutoffTime": dataset_state.get("lastCutoffTime"),
        "universeSymbols": dataset_state.get("universeSymbols") or [],
        "lgbm": {
            "ready": lgbm_ready,
            "versionId": lgbm_current.get("versionId"),
            "trainedAt": lgbm_current.get("trainedAt"),
            "cutoffTime": lgbm_current.get("cutoffTime"),
            "longSha256": lgbm_current.get("longSha256"),
            "shortSha256": lgbm_current.get("shortSha256"),
            "valNdcg5Long": lgbm_current.get("valNdcg5Long"),
            "valNdcg5Short": lgbm_current.get("valNdcg5Short"),
            "elapsedMs": lgbm_current.get("elapsedMs"),
            "trainRows": lgbm_current.get("trainRows"),
            "valRows": lgbm_current.get("valRows"),
        },
        "chronos2": {
            "ready": bool(chronos_status.get("installed")),
            "installed": bool(chronos_status.get("installed")),
            "reason": chronos_status.get("reason"),
            "versionId": chronos_status.get("versionId") or chronos_current.get("versionId"),
            "trainedAt": trained_at,
            "cutoffTime": chronos_status.get("cutoffTime") or chronos_current.get("cutoffTime"),
            "valReturnMae": chronos_status.get("valReturnMae") if chronos_status.get("valReturnMae") is not None else chronos_current.get("valReturnMae"),
            "valDirectionHitRate": chronos_current.get("valDirectionHitRate"),
            "peakVramAllocatedMb": chronos_current.get("peakVramAllocatedMb"),
            "elapsedSeconds": chronos_current.get("elapsedSeconds"),
            "dtype": chronos_current.get("dtype"),
            "baseRepoId": chronos_status.get("repoId") or "amazon/chronos-2",
            "baseRevision": chronos_status.get("revision") or chronos_current.get("baseRevision"),
            "adapterSha256": chronos_status.get("adapterSha256") or chronos_current.get("adapterSha256Json", {}).get("adapter_model.safetensors"),
            "retrainIntervalHours": retrain_hours,
            "nextRetrainAt": next_retrain_at,
            "isTraining": bool(chronos_train_state.get("isTraining")),
            "lastError": chronos_train_state.get("lastError"),
        },
    }


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
    from .chronos_runner import installed_status

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
    rolling_status = _inspect_rolling_pipeline_status(data_dir)
    live_dir_exists = (data_dir / "model-live").exists()
    chronos_report = (
        rolling_status["chronos2"]
        if (rolling_status["chronos2"]["ready"] or live_dir_exists)
        else installed_status(data_dir)
    )

    return {
        "pythonExecutable": sys.executable,
        "pythonVersion": sys.version.split()[0],
        "gpuEnvironment": gpu_env,
        "datasetReady": dataset_ready or rolling_status["datasetReady"],
        "datasetVersion": rolling_status.get("datasetVersion") or (dataset_manifest.get("datasetVersion") if dataset_manifest else None),
        "datasetCutoffTime": rolling_status.get("lastCutoffTime") or (dataset_manifest.get("boundaries", {}).get("testEndMs") if dataset_manifest else None),
        "universeSymbols": rolling_status.get("universeSymbols") or (dataset_manifest.get("universe", {}).get("symbols", []) if dataset_manifest else []),
        "insufficientSymbols": dataset_manifest.get("insufficientSymbols", []) if dataset_manifest else [],
        "lightgbmReady": lgbm_ready or rolling_status["lgbm"]["ready"],
        "artifactWarnings": [
            "資料或 LightGBM 模型早於 v3 資金費結算名目價值修正；既有離線數值未反映新版成本。"
        ] if not rolling_status["lgbm"]["ready"] and dataset_manifest and lgbm_meta and (
            dataset_manifest.get("pipelineVersion", 1) < 3 or lgbm_meta.get("pipeline_version", 1) < 3
        ) else [],
        "lightgbmMetadata": {
            "versionId": rolling_status["lgbm"]["versionId"],
            "trainedAt": rolling_status["lgbm"]["trainedAt"],
            "valNdcg5Long": rolling_status["lgbm"]["valNdcg5Long"],
            "valNdcg5Short": rolling_status["lgbm"]["valNdcg5Short"],
            "longSha256": rolling_status["lgbm"]["longSha256"] or (lgbm_meta.get("long_model", {}).get("sha256") if lgbm_meta else None),
            "shortSha256": rolling_status["lgbm"]["shortSha256"] or (lgbm_meta.get("short_model", {}).get("sha256") if lgbm_meta else None),
            "selectedParamsLong": lgbm_meta.get("long_model", {}).get("selected_params") if lgbm_meta else None,
            "selectedParamsShort": lgbm_meta.get("short_model", {}).get("selected_params") if lgbm_meta else None,
            "validationMetrics": lgbm_meta.get("validation_metrics") if lgbm_meta else None,
            "testMetrics": lgbm_meta.get("test_metrics") if lgbm_meta else None,
        }
        if (lgbm_meta or rolling_status["lgbm"]["ready"])
        else None,
        "kronosModels": {
            "small": small_status,
            "base": base_status,
        },
        "chronos2": chronos_report,
        "rollingPipeline": rolling_status,
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
    kronos_model_key = "chronos2" if req.get("kronosModel") == "chronos2" else normalize_model_key(req.get("kronosModel") or "small")
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

    from .chronos_runner import installed_status, rolling_installed_status, infer_candidates, CONFIG as CHRONOS_CONFIG
    from .rolling_store import resolve_live_paths

    live_request = req.get("cutoffTime") is None
    live_paths = resolve_live_paths(data_dir)
    use_rolling = bool(
        req.get("useRolling")
        or (live_request and live_paths.state_path.is_file())
    )
    if not use_rolling and (not klines_path.exists() or not dataset_manifest_path.exists()):
        raise FileNotFoundError("研究資料集 Parquet 尚未準備（請先執行資料準備命令，POST 推論不會自動下載）")

    if kronos_model_key == "chronos2":
        kronos_check = rolling_installed_status(data_dir) if use_rolling else installed_status(data_dir)
    else:
        kronos_check = check_kronos_installed(weights_dir, kronos_model_key)

    if not kronos_check["installed"]:
        raise KronosModelMissingError(
            (f"Chronos-2 微調模型尚未就緒：{kronos_check.get('reason', 'unknown')}" if kronos_model_key == "chronos2" else
             f"Kronos-{kronos_model_key} 權重或 Tokenizer 尚未安裝（POST 推論不會自動下載）")
        )

    artifact_warnings: list[str] = []
    lgbm_version_meta: dict[str, Any] = {}

    if use_rolling:
        from .rolling_store import build_rolling_panel_and_splits, sync_rolling_dataset
        from .lightgbm_ranker import load_active_rolling_lightgbm, publish_rolling_lgbm_version

        target_cutoff = (now_ms // ONE_HOUR_MS) * ONE_HOUR_MS
        sync_res = sync_rolling_dataset(
            data_dir=data_dir,
            target_cutoff_ms=target_cutoff,
            window_days=int(req.get("windowDays") or 180),
            allow_network=bool(req.get("allowNetwork", True)),
            require_latest_hour=True,
        )
        df_1h = sync_res["df_1h"]
        df_funding = sync_res["df_funding"]
        cutoff_ms = target_cutoff
        klines_path = live_paths.klines_path
        dataset_manifest = {
            "datasetVersion": sync_res["state"]["datasetVersion"],
            "pipelineVersion": 3,
            "universe": {"symbols": sync_res["symbols"]},
            "insufficientSymbols": [],
        }
        retrain_lgbm = req.get("retrainLgbm", True)
        skip_same = bool(req.get("skipTrainingIfSameCutoff", False))
        need_train = bool(retrain_lgbm)
        if need_train and skip_same and live_paths.lgbm_current_path.is_file():
            try:
                cur_doc = json.loads(live_paths.lgbm_current_path.read_text(encoding="utf-8"))
                if int(cur_doc.get("cutoffTime") or -1) == target_cutoff:
                    need_train = False
            except Exception:
                need_train = True

        if need_train or not live_paths.lgbm_current_path.is_file():
            panel_df, _ = build_rolling_panel_and_splits(
                df_1h=df_1h,
                df_funding=df_funding,
                target_cutoff_ms=target_cutoff,
                window_days=int(req.get("windowDays") or 180),
                val_days=int(req.get("valDays") or 30),
            )
            publish_rolling_lgbm_version(
                panel_df=panel_df,
                lgbm_root=live_paths.lgbm_root,
                dataset_version=sync_res["state"]["datasetVersion"],
                cutoff_time=target_cutoff,
            )
        long_booster, short_booster, lgbm_meta, lgbm_current = load_active_rolling_lightgbm(live_paths.lgbm_root)
        lgbm_version_meta = lgbm_current
    else:
        with open(dataset_manifest_path, "r", encoding="utf-8") as f:
            dataset_manifest = json.load(f)
        long_booster, short_booster, lgbm_meta = load_lightgbm_models(models_dir)
        if dataset_manifest.get("pipelineVersion", 1) < 3 or lgbm_meta.get("pipeline_version", 1) < 3:
            artifact_warnings.append(
                "資料或 LightGBM 模型早於 v3 結算名目價值資金費標籤；本次排名未更新的成本模型。"
            )
        if live_request:
            from .live_inputs import refresh_inputs
            df_1h, df_funding, klines_path, dataset_manifest, cutoff_ms = refresh_inputs(
                data_dir, run_id, dataset_manifest, now_ms)
        else:
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
    if live_request and ranking_res.get("cutoff_time") != cutoff_ms:
        raise ValueError("即時排名未使用最新收盤小時；拒絕回傳舊結果")


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

    forecast_runner = infer_candidates if kronos_model_key == "chronos2" else infer_kronos_for_candidates
    kronos_res = forecast_runner(
        df_1h=df_1h,
        candidate_symbols=ranking_res["kronos_target_symbols"],
        decision_open_time=decision_open_time,
        weights_root=weights_dir,
        model_key=kronos_model_key,
        require_cuda=require_cuda,
        **({"data_dir": data_dir, "strict_rolling": use_rolling} if kronos_model_key == "chronos2" else {}),
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
        ("即時推論沿用訓練研究標的清單，非全市場掃描；模型績效尚待前向驗證。" if live_request else "本資料集為目前可交易幣種的歷史試驗，存在存活與選擇偏差，不得稱為歷史全市場驗證。"),
        "LightGBM 分數為相對排名分數（Ranking Score），不得轉稱勝率或預期報酬。",
        ("Chronos-2 僅預測收盤價中位數，沒有 OHLC 或校準信賴區間；預訓練資料重疊未知。" if kronos_model_key == "chronos2" else "Kronos 抽樣範圍僅代表 5 次抽樣之離散程度，不得稱為校準信賴區間；且預訓練資料重疊未知。"),
    ]
    if ranking_res["conflict_symbols"]:
        warnings_list.append(
            f"多空排名衝突標的：{', '.join(ranking_res['conflict_symbols'])} 同時出現在多頭與空頭 Top 5。"
        )
    for sk in kronos_res.get("skippedSymbols", []):
        warnings_list.append(f"{sk['symbol']} 略過時序模型推論：{sk['reason']}")

    # All candidates missing a 256-bar window is not a successful forecast run.
    run_status = "SUCCESS" if kronos_res["forecasts"] else "INSUFFICIENT_DATA"

    generated_at = int(time.time() * 1000)
    klines_sha256 = sha256_file(klines_path)

    result_doc: dict[str, Any] = {
        "runId": run_id,
        "status": run_status,
        "reason": None if run_status == "SUCCESS" else "所有候選標的皆缺少連續 256 根已收盤 K 線，未產生時序模型預測",
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
                "versionId": lgbm_version_meta.get("versionId") or lgbm_meta.get("versionId"),
                "trainedAt": lgbm_version_meta.get("trainedAt") or lgbm_meta.get("trainedAt"),
                "valNdcg5Long": lgbm_version_meta.get("valNdcg5Long"),
                "valNdcg5Short": lgbm_version_meta.get("valNdcg5Short"),
                "longSha256": lgbm_meta["long_model"]["sha256"],
                "shortSha256": lgbm_meta["short_model"]["sha256"],
                "selectedParamsLong": lgbm_meta["long_model"]["selected_params"],
                "selectedParamsShort": lgbm_meta["short_model"]["selected_params"],
                "elapsedMs": lgbm_elapsed_ms,
            },
            "kronos": {
                "modelKey": kronos_model_key,
                "versionId": kronos_check.get("versionId"),
                "trainedAt": kronos_check.get("trainedAt"),
                "valReturnMae": kronos_check.get("valReturnMae"),
                "repoId": kronos_res["modelInfo"]["repoId"],
                "revision": kronos_res["modelInfo"]["revision"],
                "modelSha256": kronos_res["modelInfo"]["modelSha256"],
                "tokenizerRepoId": kronos_res["modelInfo"]["tokenizerRepoId"],
                "tokenizerRevision": kronos_res["modelInfo"]["tokenizerRevision"],
                "tokenizerSha256": kronos_res["modelInfo"]["tokenizerSha256"],
                "inferenceConfig": CHRONOS_CONFIG if kronos_model_key == "chronos2" else KRONOS_INFERENCE_CONFIG,
                "targetSymbols": kronos_res["targetSymbols"],
                "totalElapsedMs": kronos_res["totalElapsedMs"],
                "peakVramAllocatedMb": kronos_res["peakVramAllocatedMb"],
                "peakVramReservedMb": kronos_res["peakVramReservedMb"],
                "gpuEnvironment": kronos_res["gpuEnv"],
            },
        },
        "dataset": {
            "datasetVersion": dataset_manifest.get("datasetVersion"),
            "inputMode": "live" if live_request else "historical",
            "inputManifestPath": str(klines_path.parent / "input_manifest.json") if live_request else None,
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

    _atomic_commit_research_run(
        data_dir=data_dir,
        mr_dir=mr_dir,
        eval_dir=eval_dir,
        run_id=run_id,
        kronos_model_key=kronos_model_key,
        kronos_inference_config=CHRONOS_CONFIG if kronos_model_key == "chronos2" else KRONOS_INFERENCE_CONFIG,
        lgbm_meta=lgbm_meta,
        kronos_res=kronos_res,
        dataset_version=dataset_manifest.get("datasetVersion"),
        klines_sha256=klines_sha256,
        result_doc=result_doc,
    )
    return result_doc


def _atomic_commit_research_run(
    *,
    data_dir: Path,
    mr_dir: Path,
    eval_dir: Path,
    run_id: str,
    kronos_model_key: str,
    kronos_inference_config: dict[str, Any],
    lgbm_meta: dict[str, Any],
    kronos_res: dict[str, Any],
    dataset_version: str | None,
    klines_sha256: str,
    result_doc: dict[str, Any],
) -> None:
    """Atomically write run artifacts to `<mr_dir>/<run_id>` and promote `latest-run.json` on SUCCESS."""
    runs_root = mr_dir
    runs_root.mkdir(parents=True, exist_ok=True)
    staging_dir = runs_root / f".staging-{run_id}-{uuid.uuid4().hex[:8]}"
    final_run_dir = runs_root / run_id
    run_status = str(result_doc.get("status") or "")
    generated_at = int(result_doc["generatedAt"])
    decision_cutoff_time = int(result_doc["cutoffTime"])
    expires_at = int(result_doc["expiresAt"])

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
            "kronosInferenceConfig": kronos_inference_config,
            "lightgbmFeatureColumns": lgbm_meta.get("feature_columns"),
            "lightgbmLongParams": lgbm_meta["long_model"]["selected_params"],
            "lightgbmShortParams": lgbm_meta["short_model"]["selected_params"],
        }
        with open(config_file, "w", encoding="utf-8") as f:
            json.dump(config_doc, f, ensure_ascii=False, indent=2)

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
            "datasetVersion": dataset_version,
            "dataSha256": {
                "klines_1h.parquet": klines_sha256,
            },
            "modelSha256": {
                "lgbm_long_ranker.txt": lgbm_meta["long_model"]["sha256"],
                "lgbm_short_ranker.txt": lgbm_meta["short_model"]["sha256"],
                **(
                    {"chronos2/adapter_model.safetensors": kronos_res["modelInfo"]["modelSha256"]}
                    if kronos_model_key == "chronos2"
                    else {
                        f"Kronos-{kronos_model_key}/model.safetensors": kronos_res["modelInfo"]["modelSha256"],
                        "Kronos-Tokenizer-base/model.safetensors": kronos_res["modelInfo"]["tokenizerSha256"],
                    }
                ),
            },
            "resultSha256": sha256_file(result_file),
            "configSha256": sha256_file(config_file),
        }
        with open(manifest_file, "w", encoding="utf-8") as f:
            json.dump(run_manifest, f, ensure_ascii=False, indent=2)

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


def _read_and_validate_csv(csv_path: Path, expected_columns: list[str], label: str):
    import pandas as pd

    df = pd.read_csv(csv_path)
    if list(df.columns) != expected_columns:
        raise ValueError(
            f"{label} 欄位與規格不一致：預期 {expected_columns}，實際 {list(df.columns)}"
        )
    return df


def handle_forward_rank(req: dict[str, Any]) -> dict[str, Any]:
    import pandas as pd

    from .features_and_labels import ONE_HOUR_MS, validate_and_deduplicate_1h
    from .lightgbm_ranker import load_lightgbm_models, rank_at_cutoff

    data_dir = resolve_data_dir(req)
    input_mode = str(req.get("inputMode") or "").strip()
    if input_mode not in ("live", "replay"):
        raise ValueError("inputMode 必須為 'live' 或 'replay'")

    if req.get("targetCutoffTime") is None:
        raise ValueError("缺少 targetCutoffTime")
    target_cutoff = int(req["targetCutoffTime"])
    if target_cutoff < 0 or target_cutoff % ONE_HOUR_MS != 0:
        raise ValueError("targetCutoffTime 必須為非負 UTC 整點毫秒時間戳")

    now_ms = int(time.time() * 1000)
    if input_mode == "live":
        if target_cutoff > now_ms or target_cutoff <= now_ms - 2 * ONE_HOUR_MS:
            raise ValueError("live 模式之 targetCutoffTime 必須滿足 ≤ now 且 > now - 2h")

    raw_universe = req.get("universeSymbols")
    if not isinstance(raw_universe, list) or not raw_universe:
        raise ValueError("universeSymbols 必須為非空陣列")
    universe_symbols = list(dict.fromkeys(str(s).strip().upper() for s in raw_universe if str(s).strip()))
    if not universe_symbols:
        raise ValueError("universeSymbols 不可為空")
    universe_set = set(universe_symbols)

    raw_output_path = req.get("outputPath")
    if not raw_output_path:
        raise ValueError("缺少 outputPath")
    output_path = Path(str(raw_output_path)).resolve()

    mr_dir = data_dir / "model-research"
    datasets_dir = mr_dir / "datasets"
    models_dir = mr_dir / "models"

    klines_path = datasets_dir / "klines_1h.parquet"
    if not klines_path.exists():
        raise FileNotFoundError(f"找不到基礎 1h K 線資料：{klines_path}")
    funding_path = datasets_dir / "funding_rates.parquet"

    long_booster, short_booster, lgbm_meta = load_lightgbm_models(models_dir)

    df_1h = pd.read_parquet(klines_path)
    if list(df_1h.columns) != EXPECTED_KLINES_COLUMNS:
        raise ValueError(f"klines_1h.parquet 欄位與常數不一致：{list(df_1h.columns)}")
    base_klines_sha = sha256_file(klines_path)

    supp_klines_sha: str | None = None
    supp_klines_arg = req.get("supplementalKlinesCsv")
    if supp_klines_arg:
        supp_klines_path = Path(str(supp_klines_arg)).resolve()
        if supp_klines_path.is_file():
            supp_klines_sha = sha256_file(supp_klines_path)
            extra_df = _read_and_validate_csv(supp_klines_path, EXPECTED_KLINES_COLUMNS, "supplementalKlinesCsv")
            if not extra_df.empty:
                if extra_df["is_final"].dtype == object:
                    extra_df["is_final"] = (
                        extra_df["is_final"].astype(str).str.strip().str.lower().isin(("true", "1"))
                    )
                else:
                    extra_df["is_final"] = extra_df["is_final"].astype(bool)
                df_1h = pd.concat([df_1h, extra_df], ignore_index=True)

    df_1h = df_1h[df_1h["symbol"].astype(str).isin(universe_set)].copy()

    df_funding: pd.DataFrame | None = None
    base_funding_sha: str | None = None
    if funding_path.is_file():
        df_funding = pd.read_parquet(funding_path)
        if list(df_funding.columns) != EXPECTED_FUNDING_COLUMNS:
            raise ValueError(f"funding_rates.parquet 欄位與常數不一致：{list(df_funding.columns)}")
        base_funding_sha = sha256_file(funding_path)

    supp_funding_sha: str | None = None
    supp_funding_arg = req.get("supplementalFundingCsv")
    if supp_funding_arg:
        supp_funding_path = Path(str(supp_funding_arg)).resolve()
        if supp_funding_path.is_file():
            supp_funding_sha = sha256_file(supp_funding_path)
            extra_funding = _read_and_validate_csv(
                supp_funding_path, EXPECTED_FUNDING_COLUMNS, "supplementalFundingCsv"
            )
            if not extra_funding.empty:
                df_funding = (
                    pd.concat([df_funding, extra_funding], ignore_index=True)
                    if df_funding is not None
                    else extra_funding
                )

    if df_funding is not None and not df_funding.empty:
        df_funding = df_funding[df_funding["symbol"].astype(str).isin(universe_set)].copy()
        df_funding["funding_time"] = pd.to_numeric(df_funding["funding_time"], errors="coerce")
        df_funding = df_funding[df_funding["funding_time"].notna() & (df_funding["funding_time"] <= target_cutoff)].copy()

    df_1h, _ = validate_and_deduplicate_1h(df_1h, cutoff_ms=target_cutoff)
    if df_1h.empty:
        raise DataNotReadyError("合併後無可用之已收盤 1h K 線資料")

    # Compute deterministic merged hash of cleaned kline bars up to targetCutoffTime
    hasher = hashlib.sha256()
    sorted_bars = df_1h[["symbol", "open_time", "close", "is_final", "source"]].sort_values(["symbol", "open_time"])
    for row in sorted_bars.itertuples(index=False, name=None):
        hasher.update(f"{row[0]}|{int(row[1])}|{float(row[2]):.12g}|{bool(row[3])}|{row[4]}\n".encode("utf-8"))
    merged_sha = hasher.hexdigest()

    t0 = time.perf_counter()
    ranking_res = rank_at_cutoff(
        df_1h=df_1h,
        long_booster=long_booster,
        short_booster=short_booster,
        feature_columns=lgbm_meta.get("feature_columns"),
        cutoff_ms=target_cutoff,
        df_funding=df_funding,
        top_k=5,
    )
    lgbm_elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 2)

    expected_decision_open = target_cutoff - ONE_HOUR_MS
    if ranking_res.get("status") != "OK" or int(ranking_res.get("decision_open_time") or -1) != expected_decision_open:
        raise DataNotReadyError(
            ranking_res.get("reason")
            or f"最新已收盤決策小時不符：預期 {expected_decision_open}，實際 {ranking_res.get('decision_open_time')}"
        )

    conflict_set = set(str(s) for s in ranking_res.get("conflict_symbols", []))
    chronos_targets = [
        str(s) for s in ranking_res.get("kronos_target_symbols", []) if str(s) not in conflict_set
    ]

    out_doc: dict[str, Any] = {
        "inputMode": input_mode,
        "replay": input_mode == "replay",
        "decisionOpenTime": int(ranking_res["decision_open_time"]),
        "cutoffTime": int(ranking_res["cutoff_time"]),
        "universeSymbols": universe_symbols,
        "eligibleCount": int(ranking_res["eligible_count"]),
        "insufficientSymbols": ranking_res["insufficient_symbols"],
        "longTop5": ranking_res["long_top5"],
        "shortTop5": ranking_res["short_top5"],
        "conflictSymbols": ranking_res["conflict_symbols"],
        "kronosTargetSymbols": ranking_res["kronos_target_symbols"],
        "chronosTargetSymbols": chronos_targets,
        "inputSha256": merged_sha,
        "inputHashes": {
            "before": {
                "baseKlinesSha256": base_klines_sha,
                "supplementalKlinesSha256": supp_klines_sha,
                "baseFundingSha256": base_funding_sha,
                "supplementalFundingSha256": supp_funding_sha,
            },
            "after": merged_sha,
        },
        "lightgbm": {
            "longSha256": lgbm_meta["long_model"]["sha256"],
            "shortSha256": lgbm_meta["short_model"]["sha256"],
            "elapsedMs": lgbm_elapsed_ms,
        },
        "generatedAt": int(time.time() * 1000),
    }

    atomic_write_json(output_path, out_doc)
    return out_doc


def handle_rolling_prepare_and_train_rank(req: dict[str, Any]) -> dict[str, Any]:
    """
    Unified hourly live step:
    1. Incrementally update 180-day sliding window parquet store (`model-live/datasets/`).
    2. Retrain LightGBM Long & Short rankers on CPU (rolling Train/Val ending <= cutoff) and promote atomically.
    3. Produce current hour ranking output + report Chronos-2 retrain due state.
    """
    from .features_and_labels import ONE_HOUR_MS
    from .lightgbm_ranker import load_active_rolling_lightgbm, publish_rolling_lgbm_version, rank_at_cutoff
    from .rolling_store import (
        DEFAULT_VAL_DAYS,
        DEFAULT_WINDOW_DAYS,
        build_rolling_panel_and_splits,
        resolve_live_paths,
        sync_rolling_dataset,
    )

    data_dir = resolve_data_dir(req)
    now_ms = int(time.time() * 1000)
    target_cutoff = int(req.get("targetCutoffTime") or ((now_ms // ONE_HOUR_MS) * ONE_HOUR_MS))
    if target_cutoff <= 0 or target_cutoff % ONE_HOUR_MS != 0:
        raise ValueError("targetCutoffTime 必須為正數 UTC 整點毫秒時間戳")

    window_days = int(req.get("windowDays") or DEFAULT_WINDOW_DAYS)
    val_days = int(req.get("valDays") or DEFAULT_VAL_DAYS)
    retrain_lgbm = bool(req.get("retrainLgbm", True))
    skip_same_cutoff = bool(req.get("skipTrainingIfSameCutoff", False))
    allow_network = bool(req.get("allowNetwork", True))
    require_latest_hour = bool(req.get("requireLatestHour", True))
    retrain_interval_hours = int(req.get("chronosRetrainIntervalHours") or 6)

    supp_k = Path(str(req["supplementalKlinesCsv"])).resolve() if req.get("supplementalKlinesCsv") else None
    supp_f = Path(str(req["supplementalFundingCsv"])).resolve() if req.get("supplementalFundingCsv") else None
    universe_override = req.get("universeSymbols") if isinstance(req.get("universeSymbols"), list) else None

    sync_res = sync_rolling_dataset(
        data_dir=data_dir,
        target_cutoff_ms=target_cutoff,
        universe_symbols=universe_override,
        window_days=window_days,
        supplemental_klines_csv=supp_k,
        supplemental_funding_csv=supp_f,
        require_latest_hour=require_latest_hour,
        allow_network=allow_network,
    )
    paths: Any = sync_res["paths"]
    df_1h = sync_res["df_1h"]
    df_funding = sync_res["df_funding"]
    dataset_state = sync_res["state"]

    need_retrain = retrain_lgbm or not paths.lgbm_current_path.is_file()
    if need_retrain and skip_same_cutoff and paths.lgbm_current_path.is_file():
        try:
            existing_cur = json.loads(paths.lgbm_current_path.read_text(encoding="utf-8"))
            if int(existing_cur.get("cutoffTime") or -1) == target_cutoff:
                need_retrain = False
        except Exception:
            need_retrain = True

    if need_retrain:
        panel_df, _ = build_rolling_panel_and_splits(
            df_1h=df_1h,
            df_funding=df_funding,
            target_cutoff_ms=target_cutoff,
            window_days=window_days,
            val_days=val_days,
        )
        publish_rolling_lgbm_version(
            panel_df=panel_df,
            lgbm_root=paths.lgbm_root,
            dataset_version=dataset_state["datasetVersion"],
            cutoff_time=target_cutoff,
        )

    long_booster, short_booster, lgbm_meta, lgbm_current = load_active_rolling_lightgbm(paths.lgbm_root)

    t0 = time.perf_counter()
    ranking_res = rank_at_cutoff(
        df_1h=df_1h,
        long_booster=long_booster,
        short_booster=short_booster,
        feature_columns=lgbm_meta.get("feature_columns"),
        cutoff_ms=target_cutoff,
        df_funding=df_funding,
        top_k=5,
    )
    lgbm_elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 2)

    expected_decision_open = target_cutoff - ONE_HOUR_MS
    if ranking_res.get("status") != "OK" or int(ranking_res.get("decision_open_time") or -1) != expected_decision_open:
        raise DataNotReadyError(
            ranking_res.get("reason")
            or f"最新已收盤決策小時不符：預期 {expected_decision_open}，實際 {ranking_res.get('decision_open_time')}"
        )

    conflict_set = set(str(s) for s in ranking_res.get("conflict_symbols", []))
    chronos_targets = [str(s) for s in ranking_res.get("kronos_target_symbols", []) if str(s) not in conflict_set]
    rolling_status = _inspect_rolling_pipeline_status(data_dir)
    chronos_info = rolling_status["chronos2"]
    last_chronos_trained = chronos_info.get("trainedAt")
    chronos_train_due = (
        (not chronos_info.get("ready"))
        or (last_chronos_trained is None)
        or ((int(time.time() * 1000) - int(last_chronos_trained)) >= retrain_interval_hours * ONE_HOUR_MS)
    )

    out_doc: dict[str, Any] = {
        "inputMode": "live",
        "replay": False,
        "decisionOpenTime": int(ranking_res["decision_open_time"]),
        "cutoffTime": int(ranking_res["cutoff_time"]),
        "universeSymbols": sync_res["symbols"],
        "eligibleCount": int(ranking_res["eligible_count"]),
        "insufficientSymbols": ranking_res["insufficient_symbols"],
        "longTop5": ranking_res["long_top5"],
        "shortTop5": ranking_res["short_top5"],
        "allRankings": ranking_res["all_rankings"],
        "conflictSymbols": ranking_res["conflict_symbols"],
        "kronosTargetSymbols": ranking_res["kronos_target_symbols"],
        "chronosTargetSymbols": chronos_targets,
        "datasetVersion": dataset_state["datasetVersion"],
        "klinesPath": str(paths.klines_path),
        "klinesSha256": dataset_state["klinesSha256"],
        "fundingSha256": dataset_state["fundingSha256"],
        "inputSha256": dataset_state["klinesSha256"],
        "inputHashes": {
            "datasetVersion": dataset_state["datasetVersion"],
            "klinesSha256": dataset_state["klinesSha256"],
            "fundingSha256": dataset_state["fundingSha256"],
        },
        "lightgbm": {
            "versionId": lgbm_current["versionId"],
            "trainedAt": lgbm_current["trainedAt"],
            "cutoffTime": lgbm_current["cutoffTime"],
            "valNdcg5Long": lgbm_current["valNdcg5Long"],
            "valNdcg5Short": lgbm_current["valNdcg5Short"],
            "longSha256": lgbm_meta["long_model"]["sha256"],
            "shortSha256": lgbm_meta["short_model"]["sha256"],
            "selectedParamsLong": lgbm_meta["long_model"]["selected_params"],
            "selectedParamsShort": lgbm_meta["short_model"]["selected_params"],
            "elapsedMs": lgbm_elapsed_ms,
        },
        "chronosTrainDue": chronos_train_due,
        "rollingPipeline": rolling_status,
        "generatedAt": int(time.time() * 1000),
    }

    if req.get("outputPath"):
        atomic_write_json(Path(str(req["outputPath"])).resolve(), out_doc)
    return out_doc


def handle_commit_rolling_research(req: dict[str, Any]) -> dict[str, Any]:
    """
    Publish a shared hourly `ModelResearchRunResult` into `data/model-research/<runId>` & `latest-run.json`
    using already-computed `rankResult` and `chronosResult` outputs (avoids running GPU inference twice).
    """
    import pandas as pd
    from .chronos_runner import CONFIG as CHRONOS_CONFIG
    from .features_and_labels import ONE_HOUR_MS, validate_and_deduplicate_1h
    from .rolling_store import resolve_live_paths

    data_dir = resolve_data_dir(req)
    run_id = str(req.get("runId") or f"run-{int(time.time() * 1000)}-{uuid.uuid4().hex[:8]}")
    if not re.fullmatch(r"run-[A-Za-z0-9_-]{1,120}", run_id):
        raise ValueError("runId 必須為 run- 開頭的英數字、底線或連字號")

    rank_doc = req.get("rankResult")
    if not isinstance(rank_doc, dict) and req.get("rankPath"):
        rank_doc = json.loads(Path(str(req["rankPath"])).read_text(encoding="utf-8"))
    chronos_doc = req.get("chronosResult")
    if not isinstance(chronos_doc, dict) and req.get("chronosPath"):
        chronos_doc = json.loads(Path(str(req["chronosPath"])).read_text(encoding="utf-8"))
    if not isinstance(rank_doc, dict) or not isinstance(chronos_doc, dict):
        raise ValueError("缺少 rankResult 或 chronosResult")

    decision_open_time = int(rank_doc["decisionOpenTime"])
    decision_cutoff_time = int(rank_doc["cutoffTime"])
    expires_at = decision_cutoff_time + ONE_HOUR_MS

    paths = resolve_live_paths(data_dir)
    df_1h = pd.read_parquet(paths.klines_path)
    df_1h, _ = validate_and_deduplicate_1h(df_1h, cutoff_ms=decision_cutoff_time)

    model_info = chronos_doc.get("modelInfo") or {}
    adapter_sha = (model_info.get("adapterHashes") or {}).get("adapter/adapter_model.safetensors")
    raw_forecasts = chronos_doc.get("forecasts") or {}
    forecasts: dict[str, Any] = {}
    for sym, fc in raw_forecasts.items():
        path_vals = [float(x) for x in (fc.get("predictedPath") or [])]
        if len(path_vals) != 4:
            continue
        sym_hist_df = (
            df_1h[(df_1h["symbol"] == sym) & (df_1h["open_time"] <= decision_open_time)]
            .sort_values("open_time")
            .tail(64)
        )
        history = [
            {
                "openTime": int(r.open_time),
                "closeTime": int(r.open_time) + ONE_HOUR_MS - 1,
                "time": int(r.open_time) // 1000,
                "open": float(r.open),
                "high": float(r.high),
                "low": float(r.low),
                "close": float(r.close),
                "volume": float(r.volume),
            }
            for _, r in sym_hist_df.iterrows()
        ]
        closes = [
            {
                "step": i + 1,
                "openTime": decision_open_time + (i + 1) * ONE_HOUR_MS,
                "closeTime": decision_open_time + (i + 2) * ONE_HOUR_MS - 1,
                "close": float(v),
            }
            for i, v in enumerate(path_vals)
        ]
        last_close = float(fc.get("lastClose") or (history[-1]["close"] if history else 0.0))
        forecasts[sym] = {
            "symbol": sym,
            "modelKey": "chronos2",
            "repoId": str(model_info.get("baseRepoId") or "amazon/chronos-2"),
            "revision": str(model_info.get("baseRevision") or ""),
            "cutoffTime": decision_cutoff_time,
            "lastOpenTime": decision_open_time,
            "lastClosePrice": last_close,
            "predictedClose4h": float(fc.get("predictedClose4h") or path_vals[-1]),
            "predictedReturn4h": (float(fc.get("predictedClose4h") or path_vals[-1]) / last_close - 1.0) if last_close > 0 else 0.0,
            "trainingRunId": model_info.get("versionId"),
            "adapterSha256": adapter_sha,
            "forecastType": "close",
            "predictedCloses": closes,
            "predictedCandles": [],
            "historicalCandles": history,
            "elapsedMs": float(chronos_doc.get("elapsedMs") or 0.0) / max(1, len(raw_forecasts)),
            "peakVramAllocatedMb": float(model_info.get("peakVramAllocatedMb") or 0.0),
            "peakVramReservedMb": float(model_info.get("peakVramReservedMb") or 0.0),
            "inferenceConfig": CHRONOS_CONFIG,
            "dispersionDisclaimer": "Chronos-2 微調模型之收盤價中位數預測，未提供校準信賴區間。",
        }

    warnings_list = [
        "每小時自動更新 180 天滑動視窗並重訓 LightGBM；Chronos-2 LoRA 每 6 小時於本機 GPU 週期微調。",
        "LightGBM 分數為相對排名分數（Ranking Score），不得轉稱勝率或預期報酬。",
        "Chronos-2 僅預測收盤價中位數，沒有 OHLC 或校準信賴區間；預訓練資料重疊未知。",
    ]
    if rank_doc.get("conflictSymbols"):
        warnings_list.append(
            f"多空排名衝突標的：{', '.join(rank_doc['conflictSymbols'])} 同時出現在多頭與空頭 Top 5。"
        )
    for sk in chronos_doc.get("skipped") or []:
        warnings_list.append(f"{sk['symbol']} 略過時序模型推論：{sk['reason']}")

    run_status = "SUCCESS" if forecasts else "INSUFFICIENT_DATA"
    generated_at = int(time.time() * 1000)
    lgbm_info = rank_doc["lightgbm"]
    rolling_status = _inspect_rolling_pipeline_status(data_dir)
    chronos_ver = rolling_status["chronos2"]

    result_doc: dict[str, Any] = {
        "runId": run_id,
        "status": run_status,
        "reason": None if run_status == "SUCCESS" else "所有候選標的皆缺少連續 256 根已收盤 K 線，未產生時序模型預測",
        "market": "futures",
        "kronosModel": "chronos2",
        "decisionOpenTime": decision_open_time,
        "cutoffTime": decision_cutoff_time,
        "expiresAt": expires_at,
        "generatedAt": generated_at,
        "generatedAtIso": datetime.fromtimestamp(generated_at / 1000.0, tz=timezone.utc).isoformat(),
        "models": {
            "lightgbm": {
                "family": "LightGBM-LGBMRanker",
                "device": "cpu",
                "versionId": lgbm_info.get("versionId"),
                "trainedAt": lgbm_info.get("trainedAt"),
                "valNdcg5Long": lgbm_info.get("valNdcg5Long"),
                "valNdcg5Short": lgbm_info.get("valNdcg5Short"),
                "longSha256": lgbm_info["longSha256"],
                "shortSha256": lgbm_info["shortSha256"],
                "selectedParamsLong": lgbm_info.get("selectedParamsLong") or {},
                "selectedParamsShort": lgbm_info.get("selectedParamsShort") or {},
                "elapsedMs": float(lgbm_info.get("elapsedMs") or 0.0),
            },
            "kronos": {
                "modelKey": "chronos2",
                "versionId": model_info.get("versionId") or chronos_ver.get("versionId"),
                "trainedAt": model_info.get("trainedAt") or chronos_ver.get("trainedAt"),
                "valReturnMae": model_info.get("valReturnMae") if model_info.get("valReturnMae") is not None else chronos_ver.get("valReturnMae"),
                "repoId": str(model_info.get("baseRepoId") or "amazon/chronos-2"),
                "revision": str(model_info.get("baseRevision") or ""),
                "modelSha256": adapter_sha,
                "tokenizerRepoId": "",
                "tokenizerRevision": "",
                "tokenizerSha256": None,
                "inferenceConfig": CHRONOS_CONFIG,
                "targetSymbols": list(forecasts.keys()),
                "totalElapsedMs": float(chronos_doc.get("elapsedMs") or 0.0),
                "peakVramAllocatedMb": float(chronos_ver.get("peakVramAllocatedMb") or 0.0),
                "peakVramReservedMb": 0.0,
                "gpuEnvironment": {
                    "torchVersion": model_info.get("torchVersion"),
                    "cudaAvailable": model_info.get("cudaAvailable"),
                    "cudaVersion": model_info.get("cudaVersion"),
                    "gpuName": model_info.get("gpuName"),
                },
            },
        },
        "dataset": {
            "datasetVersion": rank_doc.get("datasetVersion"),
            "inputMode": "live",
            "inputManifestPath": str(paths.state_path),
            "klinesSha256": rank_doc.get("klinesSha256"),
            "universeSymbols": rank_doc.get("universeSymbols") or [],
            "eligibleCount": int(rank_doc.get("eligibleCount") or 0),
            "insufficientSymbols": rank_doc.get("insufficientSymbols") or [],
        },
        "rankings": {
            "longTop5": rank_doc.get("longTop5") or [],
            "shortTop5": rank_doc.get("shortTop5") or [],
            "allRankings": rank_doc.get("allRankings") or [],
            "conflictSymbols": rank_doc.get("conflictSymbols") or [],
        },
        "forecasts": forecasts,
        "offlineComparison": None,
        "warnings": warnings_list,
    }

    mr_dir = data_dir / "model-research"
    eval_dir = mr_dir / "evaluation"
    lgbm_meta_stub = {
        "feature_columns": None,
        "long_model": {"sha256": lgbm_info["longSha256"], "selected_params": lgbm_info.get("selectedParamsLong") or {}},
        "short_model": {"sha256": lgbm_info["shortSha256"], "selected_params": lgbm_info.get("selectedParamsShort") or {}},
    }
    kronos_stub = {
        "modelInfo": {
            "modelSha256": adapter_sha,
            "tokenizerSha256": None,
        }
    }
    _atomic_commit_research_run(
        data_dir=data_dir,
        mr_dir=mr_dir,
        eval_dir=eval_dir,
        run_id=run_id,
        kronos_model_key="chronos2",
        kronos_inference_config=CHRONOS_CONFIG,
        lgbm_meta=lgbm_meta_stub,
        kronos_res=kronos_stub,
        dataset_version=rank_doc.get("datasetVersion"),
        klines_sha256=str(rank_doc.get("klinesSha256") or ""),
        result_doc=result_doc,
    )
    return result_doc


def main() -> int:
    global _PROTOCOL_STDOUT
    _PROTOCOL_STDOUT = sys.stdout
    sys.stdout = sys.stderr
    from .kronos_runner import KronosModelMissingError, KronosOutOfMemoryError
    from .rolling_store import RollingDataNotReadyError

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
            elif action == "forward_rank":
                res = handle_forward_rank(req)
                emit_protocol({"event": "result", "data": res})
                return 0
            elif action == "rolling_prepare_and_train_rank":
                res = handle_rolling_prepare_and_train_rank(req)
                emit_protocol({"event": "result", "data": res})
                return 0
            elif action == "commit_rolling_research":
                res = handle_commit_rolling_research(req)
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
    except (DataNotReadyError, RollingDataNotReadyError) as exc:
        sys.stderr.write(traceback.format_exc() + "\n")
        emit_protocol(
            {
                "event": "error",
                "errorCode": "DATA_NOT_READY",
                "message": str(exc),
            }
        )
        return 4
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
