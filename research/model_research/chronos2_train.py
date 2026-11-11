"""
Local GPU Chronos-2 LoRA rolling trainer executed inside the `.benchmark-envs/chronos` venv.

Trains a LoRA adapter on the trailing 180-day sliding window from
`<data_dir>/model-live/datasets/klines_1h.parquet`, validates 4h return MAE strictly causally
without any future leakage, and atomically updates `<data_dir>/model-live/models/chronos2/current.json`.
"""
from __future__ import annotations

import argparse
import contextlib
import gc
import hashlib
import json
import math
import os
import random
import shutil
import sys
import time
import traceback
import uuid
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd

from .features_and_labels import (
    MIN_ELIGIBLE_SYMBOLS_PER_GROUP,
    ONE_DAY_MS,
    ONE_HOUR_MS,
    validate_and_deduplicate_1h,
)

_PROTOCOL_STDOUT = sys.stdout

ROOT = Path(__file__).resolve().parents[2]
DEFAULT_BASE_CACHE = ROOT / ".benchmark-cache" / "models" / "chronos2"
ASSET_LOCK_PATH = ROOT / "research" / "model_benchmark" / "model-assets.lock.json"

DEFAULT_TRAIN_CONFIG: dict[str, Any] = {
    "windowDays": 180,
    "valDays": 30,
    "lookback": 256,
    "horizon": 4,
    "windowStride": 6,
    "loraRank": 8,
    "loraAlpha": 16,
    "loraDropout": 0.05,
    "learningRate": 1e-5,
    "batchSize": 1,
    "gradientAccumulation": 8,
    "maxUpdates": 240,
    "evalInterval": 60,
    "earlyStoppingPatience": 3,
    "seed": 42,
    "retrainIntervalHours": 6,
    "keepVersions": 24,
}


class CudaUnavailableError(RuntimeError):
    """Raised when CUDA GPU is unavailable and CPU training fallback is forbidden."""


class AssetVerificationError(ValueError):
    """Raised when pinned local Chronos-2 base assets are missing or fail SHA256."""


def _emit(payload: dict[str, Any]) -> None:
    _PROTOCOL_STDOUT.write(json.dumps(payload, ensure_ascii=False) + "\n")
    _PROTOCOL_STDOUT.flush()


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _atomic_write_json(target_path: Path, payload: dict[str, Any]) -> None:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = target_path.parent / f".{target_path.name}.{uuid.uuid4().hex}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, target_path)


def verify_local_chronos_base_assets(base_cache_dir: Path | None = None) -> tuple[Path, dict[str, Any]]:
    """Verify the pinned local `amazon/chronos-2` base checkpoint offline via SHA256."""
    if not ASSET_LOCK_PATH.is_file():
        raise AssetVerificationError(f"找不到基礎模型鎖定檔：{ASSET_LOCK_PATH}")
    lock_doc = json.loads(ASSET_LOCK_PATH.read_text(encoding="utf-8"))
    info = lock_doc.get("models", {}).get("chronos2")
    if not isinstance(info, dict) or not info.get("files"):
        raise AssetVerificationError("model-assets.lock.json 缺少 models.chronos2 設定")

    cache_dir = Path(base_cache_dir or DEFAULT_BASE_CACHE).resolve()
    for filename, expected in info["files"].items():
        target = cache_dir / filename
        if not target.is_file():
            raise AssetVerificationError(
                f"本機缺少 Chronos-2 基礎權重檔：{target}；請確認已準備本機快取"
            )
        actual = _sha256_file(target)
        if actual.lower() != str(expected).lower():
            raise AssetVerificationError(f"Chronos-2 基礎權重雜湊不符：{target}")
    return cache_dir, info


def build_rolling_ts_windows(
    klines_df: pd.DataFrame,
    *,
    cutoff_ms: int,
    window_days: int = 180,
    val_days: int = 30,
    lookback: int = 256,
    horizon: int = 4,
    window_stride: int = 6,
    min_val_group_symbols: int = MIN_ELIGIBLE_SYMBOLS_PER_GROUP,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """
    Assemble strictly causal `(lookback -> horizon)` close windows inside `[cutoff - window_days, cutoff)`.
    - `train` windows satisfy `future_end <= val_start`.
    - `val` windows satisfy `origin >= val_start` and `future_end <= cutoff_ms` (zero leak past cutoff).
    """
    eff_window_days = max(2, int(window_days))
    eff_val_days = min(max(1, int(val_days)), eff_window_days - 1)
    window_start = int(cutoff_ms) - eff_window_days * ONE_DAY_MS
    val_start = int(cutoff_ms) - eff_val_days * ONE_DAY_MS
    stride_ms = max(1, int(window_stride)) * ONE_HOUR_MS

    clean = klines_df[klines_df["open_time"] < int(cutoff_ms)].copy()
    clean["open_time"] = clean["open_time"].astype("int64")
    clean["close"] = pd.to_numeric(clean["close"], errors="coerce").astype("float64")
    clean = clean.sort_values(["symbol", "open_time"], kind="stable").reset_index(drop=True)

    train_rows: list[dict[str, Any]] = []
    val_rows: list[dict[str, Any]] = []
    min_needed = int(lookback) + int(horizon)

    for symbol, grp in clean.groupby("symbol", sort=False):
        times = grp["open_time"].to_numpy(dtype=np.int64)
        closes = grp["close"].to_numpy(dtype=np.float64)
        if len(times) < min_needed:
            continue

        start_idx = max(int(lookback), int(np.searchsorted(times, window_start, side="left")))
        stop_idx = len(times) - int(horizon) + 1
        for origin_i in range(start_idx, stop_idx):
            origin = int(times[origin_i])
            if origin < window_start:
                continue
            future_end = int(times[origin_i + int(horizon) - 1]) + ONE_HOUR_MS
            if future_end > int(cutoff_ms):
                continue

            in_train = origin < val_start and future_end <= val_start
            in_val = origin >= val_start and future_end <= int(cutoff_ms)
            if not in_train and not in_val:
                continue
            if in_train and (origin - window_start) % stride_ms != 0:
                continue
            if in_val and origin % ONE_DAY_MS != 0:
                continue

            context_times = times[origin_i - int(lookback) : origin_i]
            future_times = times[origin_i : origin_i + int(horizon)]
            full_times = np.concatenate((context_times, future_times))
            if len(full_times) != min_needed or np.any(np.diff(full_times) != ONE_HOUR_MS):
                continue

            ctx = closes[origin_i - int(lookback) : origin_i]
            tgt = closes[origin_i : origin_i + int(horizon)]
            if not np.all(np.isfinite(ctx)) or not np.all(np.isfinite(tgt)) or ctx[-1] <= 0 or np.any(ctx <= 0) or np.any(tgt <= 0):
                continue

            item = {
                "symbol": str(symbol),
                "open_time": origin,
                "context": ctx.astype(np.float32, copy=True),
                "target": tgt.astype(np.float32, copy=True),
            }
            if in_train:
                train_rows.append(item)
            else:
                val_rows.append(item)

    # Fallback if UTC midnight sampling yielded too few val groups in a short test fixture
    if not val_rows:
        for symbol, grp in clean.groupby("symbol", sort=False):
            times = grp["open_time"].to_numpy(dtype=np.int64)
            closes = grp["close"].to_numpy(dtype=np.float64)
            if len(times) < min_needed:
                continue
            start_idx = max(int(lookback), int(np.searchsorted(times, val_start, side="left")))
            for origin_i in range(start_idx, len(times) - int(horizon) + 1):
                origin = int(times[origin_i])
                if (origin - val_start) % (12 * ONE_HOUR_MS) != 0:
                    continue
                full_times = times[origin_i - int(lookback) : origin_i + int(horizon)]
                if len(full_times) != min_needed or np.any(np.diff(full_times) != ONE_HOUR_MS):
                    continue
                ctx = closes[origin_i - int(lookback) : origin_i]
                tgt = closes[origin_i : origin_i + int(horizon)]
                if np.all(np.isfinite(ctx)) and np.all(np.isfinite(tgt)) and np.all(ctx > 0) and np.all(tgt > 0):
                    val_rows.append(
                        {
                            "symbol": str(symbol),
                            "open_time": origin,
                            "context": ctx.astype(np.float32, copy=True),
                            "target": tgt.astype(np.float32, copy=True),
                        }
                    )

    train_rows.sort(key=lambda r: (r["open_time"], r["symbol"]))
    val_rows.sort(key=lambda r: (r["open_time"], r["symbol"]))

    # Keep complete timestamp cohorts for validation consistency
    counts: dict[int, int] = {}
    for row in val_rows:
        counts[row["open_time"]] = counts.get(row["open_time"], 0) + 1
    filtered_val = [r for r in val_rows if counts[r["open_time"]] >= int(min_val_group_symbols)]
    if filtered_val:
        val_rows = filtered_val

    return train_rows, val_rows


def _score_chronos_windows(model: Any, rows: list[dict[str, Any]], horizon: int = 4) -> dict[str, Any]:
    import torch
    from chronos import Chronos2Pipeline

    if not rows:
        raise ValueError("缺少有效的 Chronos-2 驗證視窗")

    model.eval()
    outputs: list[np.ndarray] = []
    with torch.inference_mode():
        pipeline = Chronos2Pipeline(model=model)
        quantiles = list(pipeline.quantiles)
        qindex = min(range(len(quantiles)), key=lambda i: abs(float(quantiles[i]) - 0.5))
        inputs = [torch.as_tensor(r["context"], dtype=torch.float32) for r in rows]
        preds = pipeline.predict(inputs, prediction_length=horizon, batch_size=min(16, max(1, len(inputs))), cross_learning=False)
        for tensor in preds:
            outputs.append(tensor[0, qindex, :horizon].detach().cpu().numpy().astype(np.float64))

    preds_arr = np.stack(outputs)
    if preds_arr.shape[1] < horizon or not np.all(np.isfinite(preds_arr)):
        raise RuntimeError("Chronos-2 驗證產生無效或含 NaN 的預測值")

    last_closes = np.asarray([float(r["context"][-1]) for r in rows], dtype=np.float64)
    actual_closes = np.asarray([float(r["target"][-1]) for r in rows], dtype=np.float64)
    actual_ret = actual_closes / last_closes - 1.0
    pred_ret = preds_arr[:, horizon - 1] / last_closes - 1.0

    nz = actual_ret != 0
    hit_rate = float(np.mean(np.sign(pred_ret[nz]) == np.sign(actual_ret[nz]))) if np.any(nz) else None
    return {
        "returnMae": float(np.mean(np.abs(pred_ret - actual_ret))),
        "directionHitRate": hit_rate,
        "samples": int(len(rows)),
    }


def _run_chronos_lora_fit(
    base_dir: Path,
    train_rows: list[dict[str, Any]],
    val_rows: list[dict[str, Any]],
    tmp_work_dir: Path,
    adapter_out_dir: Path,
    cfg: dict[str, Any],
) -> dict[str, Any]:
    """Execute actual GPU PEFT LoRA fine-tuning of `amazon/chronos-2` and save best adapter."""
    import torch
    from chronos import Chronos2Pipeline
    from peft import LoraConfig
    from transformers import TrainerCallback

    device = "cuda" if torch.cuda.is_available() else "cpu"
    if device != "cuda":
        raise CudaUnavailableError("CUDA GPU 不可用；Chronos-2 LoRA 訓練必須使用本機 GPU")

    seed = int(cfg["seed"])
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    torch.cuda.reset_peak_memory_stats()

    use_bf16 = bool(cfg.get("useBf16", torch.cuda.is_bf16_supported()))
    has_sm80 = torch.cuda.get_device_capability()[0] >= 8

    # Keep master weights fp32 on load; Trainer handles bf16 AMP safely on Ada (RTX 4050 sm_89)
    base_pipeline = Chronos2Pipeline.from_pretrained(
        str(base_dir),
        device_map=device,
        torch_dtype=torch.float32,
    )
    baseline_val = _score_chronos_windows(base_pipeline.model, val_rows, horizon=int(cfg["horizon"]))

    class _BestValCallback(TrainerCallback):
        def __init__(self) -> None:
            self.best_mae = math.inf
            self.best_hit_rate: float | None = None
            self.best_step = 0
            self.stale_evals = 0
            self.gradient_updates = 0
            self.best_state: dict[str, torch.Tensor] | None = None
            self.patience = int(cfg["earlyStoppingPatience"])

        def on_evaluate(self, args, state, control, **kwargs):
            model = kwargs.get("model")
            if model is None:
                raise RuntimeError("Trainer evaluate callback 未提供 model")
            metrics = _score_chronos_windows(model, val_rows, horizon=int(cfg["horizon"]))
            mae = float(metrics["returnMae"])
            if math.isfinite(mae) and mae < self.best_mae:
                self.best_mae = mae
                self.best_hit_rate = metrics["directionHitRate"]
                self.best_step = int(state.global_step)
                self.stale_evals = 0
                self.best_state = {
                    k: v.detach().cpu().clone()
                    for k, v in model.state_dict().items()
                    if "lora_" in k.lower()
                }
            else:
                self.stale_evals += 1
            if self.stale_evals >= self.patience:
                control.should_training_stop = True
            return control

        def on_pre_optimizer_step(self, args, state, control, model=None, **kwargs):
            if model is None:
                raise RuntimeError("Trainer optimizer callback 未提供 model")
            grads = [p.grad for p in model.parameters() if p.requires_grad and p.grad is not None]
            if not grads or any(not bool(torch.isfinite(g).all().item()) for g in grads):
                raise RuntimeError("Chronos-2 LoRA 訓練出現非有限梯度或空梯度")
            self.gradient_updates += 1
            return control

    cb = _BestValCallback()
    train_inputs = [
        {"target": torch.as_tensor(np.concatenate([r["context"], r["target"]]), dtype=torch.float32)}
        for r in train_rows
    ]
    val_inputs = [
        {"target": torch.as_tensor(np.concatenate([r["context"], r["target"]]), dtype=torch.float32)}
        for r in val_rows
    ]

    lora = LoraConfig(
        r=int(cfg["loraRank"]),
        lora_alpha=int(cfg["loraAlpha"]),
        lora_dropout=float(cfg["loraDropout"]),
        bias="none",
        target_modules=[
            "self_attention.q",
            "self_attention.v",
            "self_attention.k",
            "self_attention.o",
            "output_patch_embedding.output_layer",
        ],
    )

    trainer_dir = tmp_work_dir / "chronos-training"
    trainer_dir.mkdir(parents=True, exist_ok=True)
    updates = int(cfg["maxUpdates"])
    eval_interval = int(cfg["evalInterval"])

    fine_pipeline = base_pipeline.fit(
        inputs=train_inputs,
        validation_inputs=val_inputs,
        prediction_length=int(cfg["horizon"]),
        finetune_mode="lora",
        lora_config=lora,
        context_length=int(cfg["lookback"]),
        min_past=int(cfg["lookback"]),
        learning_rate=float(cfg["learningRate"]),
        num_steps=updates,
        batch_size=int(cfg["batchSize"]),
        output_dir=trainer_dir,
        finetuned_ckpt_name="live-fit-ckpt",
        callbacks=[cb],
        remove_printer_callback=True,
        disable_data_parallel=True,
        gradient_accumulation_steps=int(cfg["gradientAccumulation"]),
        eval_strategy="steps",
        eval_steps=eval_interval,
        save_strategy="steps",
        save_steps=eval_interval,
        save_total_limit=1,
        load_best_model_at_end=False,
        dataloader_num_workers=0,
        report_to="none",
        tf32=has_sm80 and use_bf16,
        bf16=use_bf16,
        fp16=False,
    )

    # Free original base pipeline copy before final eval/save
    del base_pipeline
    gc.collect()
    torch.cuda.empty_cache()

    model = fine_pipeline.model
    trainable = [(n, p) for n, p in model.named_parameters() if p.requires_grad]
    if not trainable or not all("lora_" in n.lower() for n, _ in trainable):
        raise RuntimeError("Chronos-2 LoRA 訓練未產生可訓練的 PEFT LoRA 權重")
    if cb.gradient_updates < 1:
        raise RuntimeError("Chronos-2 未完成任何有效的有限梯度更新步驟")

    if cb.best_state is None:
        final_metrics = _score_chronos_windows(model, val_rows, horizon=int(cfg["horizon"]))
        cb.best_mae = float(final_metrics["returnMae"])
        cb.best_hit_rate = final_metrics["directionHitRate"]
        cb.best_step = int(cb.gradient_updates)
        cb.best_state = {
            k: v.detach().cpu().clone()
            for k, v in model.state_dict().items()
            if "lora_" in k.lower()
        }

    if cb.best_state:
        model.load_state_dict(cb.best_state, strict=False)

    lora_b = [p.detach() for n, p in model.named_parameters() if "lora_b" in n.lower()]
    if not any(bool(torch.count_nonzero(p).item()) for p in lora_b):
        raise RuntimeError("Chronos-2 LoRA 權重未從零初始化產生改變")

    adapter_out_dir.mkdir(parents=True, exist_ok=True)
    model.save_pretrained(adapter_out_dir, safe_serialization=True)

    peak_alloc_mb = round(torch.cuda.max_memory_allocated() / (1024 * 1024), 2)
    peak_res_mb = round(torch.cuda.max_memory_reserved() / (1024 * 1024), 2)
    gpu_name = torch.cuda.get_device_name(0)

    # Remove intermediate HuggingFace trainer checkpoints so stored versions remain compact
    shutil.rmtree(trainer_dir, ignore_errors=True)
    del fine_pipeline, model
    gc.collect()
    torch.cuda.empty_cache()

    return {
        "device": device,
        "gpuName": gpu_name,
        "dtype": "bfloat16" if use_bf16 else "float32",
        "optimizerUpdates": int(cb.gradient_updates),
        "bestStep": int(cb.best_step),
        "valReturnMae": float(cb.best_mae),
        "valDirectionHitRate": cb.best_hit_rate,
        "valPretrainedReturnMae": float(baseline_val["returnMae"]),
        "valPretrainedDirectionHitRate": baseline_val["directionHitRate"],
        "trainableParameters": int(sum(p.numel() for _, p in trainable)),
        "peakVramAllocatedMb": peak_alloc_mb,
        "peakVramReservedMb": peak_res_mb,
    }


def train_rolling_chronos2(req: dict[str, Any], output_path: Path | None = None) -> dict[str, Any]:
    """
    Train local Chronos-2 LoRA adapter on 180d rolling dataset and atomically promote
    `<data_dir>/model-live/models/chronos2/current.json`.
    """
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    os.environ.setdefault("MPLBACKEND", "Agg")

    import torch

    require_cuda = bool(req.get("requireCuda", True))
    if require_cuda and not torch.cuda.is_available():
        raise CudaUnavailableError("CUDA GPU 不可用；Chronos-2 本機重訓必須使用 GPU")

    data_dir = Path(str(req["dataDir"])).resolve()
    live_root = data_dir / "model-live"
    datasets_dir = live_root / "datasets"
    klines_path = Path(str(req.get("klinesParquet") or (datasets_dir / "klines_1h.parquet"))).resolve()
    if not klines_path.is_file():
        raise FileNotFoundError(f"找不到滾動 1h K 線資料：{klines_path}")

    state_path = datasets_dir / "dataset_state.json"
    dataset_cutoff = None
    if req.get("cutoffTime") is not None:
        dataset_cutoff = int(req["cutoffTime"])
    elif state_path.is_file():
        state_doc = json.loads(state_path.read_text(encoding="utf-8"))
        dataset_cutoff = int(state_doc["lastCutoffTime"])
    if not dataset_cutoff:
        raise ValueError("缺少 cutoffTime 或 dataset_state.json")

    base_cache_dir, lock_info = verify_local_chronos_base_assets(
        Path(req["baseCacheDir"]) if req.get("baseCacheDir") else None
    )

    cfg = {**DEFAULT_TRAIN_CONFIG}
    for k in list(cfg.keys()):
        if k in req and req[k] is not None:
            cfg[k] = req[k]
    if "useBf16" in req and req["useBf16"] is not None:
        cfg["useBf16"] = bool(req["useBf16"])

    df_raw = pd.read_parquet(klines_path)
    df_clean, _ = validate_and_deduplicate_1h(df_raw, cutoff_ms=dataset_cutoff)
    symbols = req.get("universeSymbols")
    if isinstance(symbols, list) and symbols:
        sym_set = {str(s).strip().upper() for s in symbols if str(s).strip()}
        df_clean = df_clean[df_clean["symbol"].astype(str).isin(sym_set)].copy()

    min_val_group = int(req.get("minValGroupSymbols") or MIN_ELIGIBLE_SYMBOLS_PER_GROUP)
    train_rows, val_rows = build_rolling_ts_windows(
        df_clean,
        cutoff_ms=dataset_cutoff,
        window_days=int(cfg["windowDays"]),
        val_days=int(cfg["valDays"]),
        lookback=int(cfg["lookback"]),
        horizon=int(cfg["horizon"]),
        window_stride=int(cfg["windowStride"]),
        min_val_group_symbols=min_val_group,
    )
    if not train_rows or not val_rows:
        raise ValueError(f"Chronos-2 滾動訓練視窗不足：train={len(train_rows)}, val={len(val_rows)}")

    chronos_root = live_root / "models" / "chronos2"
    versions_dir = chronos_root / "versions"
    versions_dir.mkdir(parents=True, exist_ok=True)
    version_id = f"chr2-{dataset_cutoff}-{int(time.time() * 1000)}"
    staging_dir = chronos_root / f".staging-{version_id}-{uuid.uuid4().hex[:8]}"
    attempt_dir = staging_dir / "attempt"
    adapter_dir = attempt_dir / "adapter"
    final_dir = versions_dir / version_id

    started = time.perf_counter()
    staging_dir.mkdir(parents=True, exist_ok=False)
    try:
        fit_stats = _run_chronos_lora_fit(
            base_dir=base_cache_dir,
            train_rows=train_rows,
            val_rows=val_rows,
            tmp_work_dir=staging_dir,
            adapter_out_dir=adapter_dir,
            cfg=cfg,
        )

        adapter_sha_map: dict[str, str] = {}
        for fpath in sorted(adapter_dir.iterdir()):
            if fpath.is_file() and fpath.name != "adapter.sha256.json":
                adapter_sha_map[fpath.name] = _sha256_file(fpath)
        if "adapter_config.json" not in adapter_sha_map or "adapter_model.safetensors" not in adapter_sha_map:
            raise RuntimeError("Chronos-2 LoRA 未輸出必要之 adapter_config.json 或 adapter_model.safetensors")

        _atomic_write_json(adapter_dir / "adapter.sha256.json", adapter_sha_map)

        trained_at = int(time.time() * 1000)
        elapsed_sec = round(time.perf_counter() - started, 2)
        artifact_hashes = {f"adapter/{k}": v for k, v in adapter_sha_map.items()}
        artifact_hashes["adapter/adapter.sha256.json"] = _sha256_file(adapter_dir / "adapter.sha256.json")

        meta_doc = {
            "mode": "local-rolling",
            "versionId": version_id,
            "trainedAt": trained_at,
            "cutoffTime": dataset_cutoff,
            "windowDays": int(cfg["windowDays"]),
            "valDays": int(cfg["valDays"]),
            "trainingWindows": int(len(train_rows)),
            "validationWindows": int(len(val_rows)),
            "elapsedSeconds": elapsed_sec,
            "baseRepoId": str(lock_info["repo_id"]),
            "baseRevision": str(lock_info["revision"]),
            "baseFiles": dict(lock_info["files"]),
            "config": cfg,
            **fit_stats,
        }
        _atomic_write_json(attempt_dir / "training_metadata.json", meta_doc)

        version_manifest = {
            "status": "SUCCESS",
            "mode": "local-rolling",
            "versionId": version_id,
            "trainedAt": trained_at,
            "cutoffTime": dataset_cutoff,
            "attemptDir": str((final_dir / "attempt").resolve()),
            "base": {
                "repo_id": str(lock_info["repo_id"]),
                "revision": str(lock_info["revision"]),
                "files": dict(lock_info["files"]),
            },
            "artifact_hashes": artifact_hashes,
            "training": meta_doc,
        }
        _atomic_write_json(staging_dir / "version_manifest.json", version_manifest)
        os.rename(staging_dir, final_dir)
    except BaseException as exc:
        if staging_dir.exists():
            shutil.rmtree(staging_dir, ignore_errors=True)
        # Keep existing `current.json` untouched on error, only update failure telemetry
        _atomic_write_json(
            chronos_root / "training_status.json",
            {
                "isTraining": False,
                "lastAttemptAt": int(time.time() * 1000),
                "lastError": str(exc),
            },
        )
        raise

    retrain_hours = int(cfg["retrainIntervalHours"])
    next_retrain_at = trained_at + retrain_hours * ONE_HOUR_MS

    current_doc = {
        "mode": "local-rolling",
        "versionId": version_id,
        "versionDir": str(final_dir),
        "attemptDir": str((final_dir / "attempt").resolve()),
        "trainedAt": trained_at,
        "cutoffTime": dataset_cutoff,
        "elapsedSeconds": float(meta_doc["elapsedSeconds"]),
        "valReturnMae": float(fit_stats["valReturnMae"]),
        "valDirectionHitRate": fit_stats["valDirectionHitRate"],
        "valPretrainedReturnMae": float(fit_stats["valPretrainedReturnMae"]),
        "bestStep": int(fit_stats["bestStep"]),
        "optimizerUpdates": int(fit_stats["optimizerUpdates"]),
        "peakVramAllocatedMb": float(fit_stats["peakVramAllocatedMb"]),
        "peakVramReservedMb": float(fit_stats["peakVramReservedMb"]),
        "gpuName": fit_stats["gpuName"],
        "dtype": fit_stats["dtype"],
        "baseRepoId": str(lock_info["repo_id"]),
        "baseRevision": str(lock_info["revision"]),
        "baseFiles": dict(lock_info["files"]),
        "artifactHashes": artifact_hashes,
        "adapterSha256Json": adapter_sha_map,
        "retrainIntervalHours": retrain_hours,
        "nextRetrainAt": next_retrain_at,
    }
    _atomic_write_json(chronos_root / "current.json", current_doc)
    _atomic_write_json(
        chronos_root / "training_status.json",
        {
            "isTraining": False,
            "lastAttemptAt": trained_at,
            "lastSuccessAt": trained_at,
            "currentVersionId": version_id,
            "nextRetrainAt": next_retrain_at,
            "retrainIntervalHours": retrain_hours,
            "lastError": None,
        },
    )

    keep_versions = int(cfg.get("keepVersions") or 24)
    if keep_versions > 0:
        existing_dirs = sorted(
            [d for d in versions_dir.iterdir() if d.is_dir() and d.name != version_id],
            key=lambda p: p.stat().st_mtime,
            reverse=True,
        )
        for stale_dir in existing_dirs[max(0, keep_versions - 1) :]:
            shutil.rmtree(stale_dir, ignore_errors=True)

    if output_path is not None:
        _atomic_write_json(output_path, current_doc)
    return current_doc


def main(argv: list[str] | None = None) -> int:
    global _PROTOCOL_STDOUT
    _PROTOCOL_STDOUT = sys.stdout
    sys.stdout = sys.stderr

    parser = argparse.ArgumentParser(description="Local GPU Chronos-2 LoRA rolling training")
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)

    try:
        req = json.loads(args.request.read_text(encoding="utf-8"))
        if not isinstance(req, dict):
            raise ValueError("request 檔案必須為 JSON object")
        with contextlib.redirect_stdout(sys.stderr):
            res = train_rolling_chronos2(req, args.output.resolve())
        _emit({"event": "result", "data": res})
        return 0
    except CudaUnavailableError as exc:
        sys.stderr.write(traceback.format_exc() + "\n")
        _emit({"event": "error", "errorCode": "CUDA_UNAVAILABLE", "message": str(exc)})
        return 3
    except AssetVerificationError as exc:
        sys.stderr.write(traceback.format_exc() + "\n")
        _emit({"event": "error", "errorCode": "ASSET_VERIFICATION_FAILED", "message": str(exc)})
        return 2
    except FileNotFoundError as exc:
        sys.stderr.write(traceback.format_exc() + "\n")
        _emit({"event": "error", "errorCode": "MODEL_OR_DATA_MISSING", "message": str(exc)})
        return 2
    except Exception as exc:
        sys.stderr.write(traceback.format_exc() + "\n")
        _emit({"event": "error", "errorCode": "CHRONOS_TRAIN_ERROR", "message": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
