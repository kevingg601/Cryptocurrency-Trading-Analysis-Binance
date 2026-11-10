"""
Kronos-small and Kronos-base local weight management, single-model VRAM residency,
strict OOM handling (no silent window shrink, model swap, or CPU fallback),
and 256->4 hourly candlestick inference.
"""

from __future__ import annotations

import gc
import hashlib
import json
import os
import time
from pathlib import Path
from typing import Any

import numpy as np
import pandas as pd
import torch
from huggingface_hub import HfApi, snapshot_download

from .features_and_labels import ONE_HOUR_MS, validate_and_deduplicate_1h
from .kronos_arch import (
    Kronos,
    KronosTokenizer,
    auto_regressive_inference_with_samples,
    calc_time_stamps,
)

TOKENIZER_REPO_ID = "NeoQuasar/Kronos-Tokenizer-base"
MODEL_REPO_MAP: dict[str, str] = {
    "small": "NeoQuasar/Kronos-small",
    "kronos-small": "NeoQuasar/Kronos-small",
    "base": "NeoQuasar/Kronos-base",
    "kronos-base": "NeoQuasar/Kronos-base",
}

KRONOS_INFERENCE_CONFIG: dict[str, Any] = {
    "lookback": 256,
    "pred_len": 4,
    "max_context": 512,
    "batch_size": 1,
    "sample_count": 5,
    "seed": 42,
    "temperature": 1.0,
    "top_k": 0,
    "top_p": 0.9,
    "clip": 5.0,
}


class KronosOutOfMemoryError(RuntimeError):
    """Raised when CUDA runs out of memory; never falls back to CPU or shrinks window."""


class KronosModelMissingError(FileNotFoundError):
    """Raised when local Kronos weights or tokenizer are not installed."""


def normalize_model_key(model_key: str) -> str:
    k = str(model_key).strip().lower()
    if k in ("small", "kronos-small"):
        return "small"
    if k in ("base", "kronos-base"):
        return "base"
    raise ValueError(f"Unsupported Kronos model key: {model_key}")


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(65536), b""):
            h.update(chunk)
    return h.hexdigest()


def get_weight_paths(weights_root: Path, model_key: str) -> tuple[Path, Path]:
    norm_key = normalize_model_key(model_key)
    tokenizer_dir = weights_root / "Kronos-Tokenizer-base"
    model_dir = weights_root / f"Kronos-{norm_key}"
    return tokenizer_dir, model_dir


def check_kronos_installed(weights_root: Path, model_key: str) -> dict[str, Any]:
    """Check whether tokenizer and requested Kronos model weights exist locally."""
    norm_key = normalize_model_key(model_key)
    repo_id = MODEL_REPO_MAP[norm_key]
    tokenizer_dir, model_dir = get_weight_paths(weights_root, norm_key)

    tok_ok = (tokenizer_dir / "config.json").exists() and (tokenizer_dir / "model.safetensors").exists()
    mod_ok = (model_dir / "config.json").exists() and (model_dir / "model.safetensors").exists()

    meta_path = model_dir / "revision_manifest.json"
    manifest: dict[str, Any] = {}
    if meta_path.exists():
        try:
            with open(meta_path, "r", encoding="utf-8") as f:
                manifest = json.load(f)
        except Exception:
            manifest = {}

    return {
        "modelKey": norm_key,
        "repoId": repo_id,
        "tokenizerRepoId": TOKENIZER_REPO_ID,
        "installed": bool(tok_ok and mod_ok),
        "tokenizerInstalled": bool(tok_ok),
        "modelInstalled": bool(mod_ok),
        "modelDir": str(model_dir),
        "tokenizerDir": str(tokenizer_dir),
        "revision": manifest.get("model_revision", "unknown"),
        "tokenizerRevision": manifest.get("tokenizer_revision", "unknown"),
        "modelSha256": manifest.get("model_safetensors_sha256"),
        "tokenizerSha256": manifest.get("tokenizer_safetensors_sha256"),
    }


def download_kronos_weights(weights_root: Path, model_key: str) -> dict[str, Any]:
    """
    Download official pretrained Kronos tokenizer and model weights into `weights_root`
    (strictly inside workspace) and record exact commit revisions and SHA256 hashes.
    Only invoked from explicit CLI setup command, never during API requests.
    """
    norm_key = normalize_model_key(model_key)
    repo_id = MODEL_REPO_MAP[norm_key]
    weights_root.mkdir(parents=True, exist_ok=True)
    hf_cache = weights_root / ".hf_cache"
    hf_cache.mkdir(parents=True, exist_ok=True)
    os.environ["HF_HOME"] = str(hf_cache)

    tokenizer_dir, model_dir = get_weight_paths(weights_root, norm_key)
    api = HfApi()

    tok_info = api.model_info(TOKENIZER_REPO_ID)
    tok_rev = tok_info.sha
    snapshot_download(
        repo_id=TOKENIZER_REPO_ID,
        revision=tok_rev,
        local_dir=str(tokenizer_dir),
        cache_dir=str(hf_cache),
    )

    mod_info = api.model_info(repo_id)
    mod_rev = mod_info.sha
    snapshot_download(
        repo_id=repo_id,
        revision=mod_rev,
        local_dir=str(model_dir),
        cache_dir=str(hf_cache),
    )

    tok_sha256 = _sha256_file(tokenizer_dir / "model.safetensors")
    mod_sha256 = _sha256_file(model_dir / "model.safetensors")

    manifest = {
        "model_key": norm_key,
        "repo_id": repo_id,
        "model_revision": mod_rev,
        "model_safetensors_sha256": mod_sha256,
        "tokenizer_repo_id": TOKENIZER_REPO_ID,
        "tokenizer_revision": tok_rev,
        "tokenizer_safetensors_sha256": tok_sha256,
        "downloaded_at": int(time.time() * 1000),
    }
    with open(model_dir / "revision_manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)
    with open(tokenizer_dir / "revision_manifest.json", "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

    return check_kronos_installed(weights_root, norm_key)


def get_gpu_environment_info() -> dict[str, Any]:
    cuda_available = bool(torch.cuda.is_available())
    gpu_name = None
    total_vram_mb = 0.0
    allocated_vram_mb = 0.0
    reserved_vram_mb = 0.0
    if cuda_available:
        gpu_name = torch.cuda.get_device_name(0)
        props = torch.cuda.get_device_properties(0)
        total_vram_mb = round(props.total_memory / (1024 * 1024), 2)
        allocated_vram_mb = round(torch.cuda.memory_allocated(0) / (1024 * 1024), 2)
        reserved_vram_mb = round(torch.cuda.memory_reserved(0) / (1024 * 1024), 2)
    return {
        "torchVersion": torch.__version__,
        "cudaAvailable": cuda_available,
        "cudaVersion": torch.version.cuda,
        "gpuName": gpu_name,
        "totalVramMb": total_vram_mb,
        "allocatedVramMb": allocated_vram_mb,
        "reservedVramMb": reserved_vram_mb,
    }


class KronosInferenceEngine:
    """
    Manages loading at most one Kronos model (`small` or `base`) into GPU memory at a time.
    Never keeps both `small` and `base` resident simultaneously.
    Never falls back to CPU or shrinks the 256-bar window on OOM.
    """

    def __init__(self, weights_root: Path, require_cuda: bool = True):
        self.weights_root = weights_root
        self.require_cuda = require_cuda
        self.loaded_model_key: str | None = None
        self.tokenizer: KronosTokenizer | None = None
        self.model: Kronos | None = None
        self.model_info: dict[str, Any] | None = None
        self.device: str = "cuda:0" if torch.cuda.is_available() else "cpu"

    def unload(self) -> None:
        """Unload active model & tokenizer and free GPU VRAM."""
        self.model = None
        self.tokenizer = None
        self.loaded_model_key = None
        self.model_info = None
        gc.collect()
        if torch.cuda.is_available():
            torch.cuda.empty_cache()

    def load_model(self, model_key: str) -> dict[str, Any]:
        norm_key = normalize_model_key(model_key)
        if self.loaded_model_key == norm_key and self.model is not None and self.tokenizer is not None:
            return self.model_info or {}

        # Always unload any previously resident model so small and base never co-reside in VRAM
        self.unload()

        if self.require_cuda and not torch.cuda.is_available():
            raise RuntimeError("CUDA GPU 不可用；依規範 Kronos 推論拒絕退回 CPU 執行。")

        self.device = "cuda:0" if torch.cuda.is_available() else "cpu"
        info = check_kronos_installed(self.weights_root, norm_key)
        if not info["installed"]:
            raise KronosModelMissingError(
                f"Kronos-{norm_key} 或 Tokenizer 本地權重尚未安裝於 {self.weights_root}（禁止於 API 請求中自動下載）"
            )

        tokenizer_dir, model_dir = get_weight_paths(self.weights_root, norm_key)
        try:
            if torch.cuda.is_available():
                torch.cuda.init()
                torch.cuda.reset_peak_memory_stats(0)

            with open(tokenizer_dir / "config.json", "r", encoding="utf-8") as f:
                tok_cfg = json.load(f)
            with open(model_dir / "config.json", "r", encoding="utf-8") as f:
                mod_cfg = json.load(f)

            from safetensors.torch import load_file

            tokenizer = KronosTokenizer(**tok_cfg)
            tok_state = load_file(str(tokenizer_dir / "model.safetensors"))
            tokenizer.load_state_dict(tok_state)
            tokenizer.eval()
            tokenizer = tokenizer.to(self.device)

            model = Kronos(**mod_cfg)
            mod_state = load_file(str(model_dir / "model.safetensors"))
            model.load_state_dict(mod_state)
            model.eval()
            model = model.to(self.device)

            self.tokenizer = tokenizer
            self.model = model
            self.loaded_model_key = norm_key
            self.model_info = info
            return info
        except torch.cuda.OutOfMemoryError as exc:
            self.unload()
            raise KronosOutOfMemoryError(
                f"CUDA OOM while loading Kronos-{norm_key}: {exc}. 依規範不降級模型或改用 CPU。"
            ) from exc
        except RuntimeError as exc:
            if "out of memory" in str(exc).lower():
                self.unload()
                raise KronosOutOfMemoryError(
                    f"CUDA OOM while loading Kronos-{norm_key}: {exc}. 依規範不降級模型或改用 CPU。"
                ) from exc
            raise

    def predict_single_window(
        self,
        window_df: pd.DataFrame,
        symbol: str,
        history_display_bars: int = 64,
    ) -> dict[str, Any]:
        """
        Run Kronos inference on a single symbol's 256 consecutive closed 1h bars.
        Enforces exact 256-bar contiguous window without gaps or NaNs.
        """
        if self.model is None or self.tokenizer is None or self.loaded_model_key is None:
            raise RuntimeError("Kronos model is not loaded")

        lookback = int(KRONOS_INFERENCE_CONFIG["lookback"])
        pred_len = int(KRONOS_INFERENCE_CONFIG["pred_len"])
        max_context = int(KRONOS_INFERENCE_CONFIG["max_context"])
        sample_count = int(KRONOS_INFERENCE_CONFIG["sample_count"])
        seed = int(KRONOS_INFERENCE_CONFIG["seed"])
        temperature = float(KRONOS_INFERENCE_CONFIG["temperature"])
        top_k = int(KRONOS_INFERENCE_CONFIG["top_k"])
        top_p = float(KRONOS_INFERENCE_CONFIG["top_p"])
        clip = float(KRONOS_INFERENCE_CONFIG["clip"])

        if len(window_df) != lookback:
            raise ValueError(
                f"Kronos requires exactly {lookback} consecutive 1h bars for {symbol}, got {len(window_df)}"
            )

        wdf = window_df.sort_values("open_time").reset_index(drop=True)
        diffs = np.diff(wdf["open_time"].to_numpy(dtype=np.int64))
        if not np.all(diffs == ONE_HOUR_MS):
            raise ValueError(f"Kronos input window for {symbol} contains missing 1h bars (non-contiguous timestamps)")

        price_cols = ["open", "high", "low", "close"]
        vol_col = "volume"
        amt_col = "amount"

        df_in = wdf[price_cols + [vol_col]].copy()
        if "quote_volume" in wdf.columns and wdf["quote_volume"].notna().all():
            df_in[amt_col] = wdf["quote_volume"].astype(float)
        else:
            df_in[amt_col] = df_in[vol_col] * df_in[price_cols].mean(axis=1)

        if df_in[price_cols + [vol_col, amt_col]].isnull().values.any():
            raise ValueError(f"Kronos input window for {symbol} contains NaN values")

        last_open_time = int(wdf["open_time"].iloc[-1])
        cutoff_time = last_open_time + ONE_HOUR_MS
        last_close = float(wdf["close"].iloc[-1])

        x_timestamps = pd.Series(pd.to_datetime(wdf["open_time"].to_numpy(dtype=np.int64), unit="ms", utc=True))
        future_open_times = [last_open_time + (i + 1) * ONE_HOUR_MS for i in range(pred_len)]
        y_timestamps = pd.Series(pd.to_datetime(future_open_times, unit="ms", utc=True))

        x_time_df = calc_time_stamps(x_timestamps)
        y_time_df = calc_time_stamps(y_timestamps)

        feat_cols = price_cols + [vol_col, amt_col]
        x_raw = df_in[feat_cols].values.astype(np.float32)
        x_stamp = x_time_df.values.astype(np.float32)
        y_stamp = y_time_df.values.astype(np.float32)

        x_mean = np.mean(x_raw, axis=0)
        x_std = np.std(x_raw, axis=0)
        x_norm = (x_raw - x_mean) / (x_std + 1e-5)
        x_norm = np.clip(x_norm, -clip, clip)

        x_tensor = torch.from_numpy(x_norm[np.newaxis, :]).to(self.device)
        x_stamp_tensor = torch.from_numpy(x_stamp[np.newaxis, :]).to(self.device)
        y_stamp_tensor = torch.from_numpy(y_stamp[np.newaxis, :]).to(self.device)

        if torch.cuda.is_available():
            torch.cuda.synchronize(0)
            torch.cuda.reset_peak_memory_stats(0)
        t0 = time.perf_counter()

        try:
            mean_preds_norm, all_samples_norm = auto_regressive_inference_with_samples(
                tokenizer=self.tokenizer,
                model=self.model,
                x=x_tensor,
                x_stamp=x_stamp_tensor,
                y_stamp=y_stamp_tensor,
                max_context=max_context,
                pred_len=pred_len,
                clip=clip,
                T=temperature,
                top_k=top_k,
                top_p=top_p,
                sample_count=sample_count,
                seed=seed,
            )
            if torch.cuda.is_available():
                torch.cuda.synchronize(0)
        except torch.cuda.OutOfMemoryError as exc:
            raise KronosOutOfMemoryError(
                f"CUDA OOM during Kronos-{self.loaded_model_key} inference on {symbol}: {exc}"
            ) from exc
        except RuntimeError as exc:
            if "out of memory" in str(exc).lower():
                raise KronosOutOfMemoryError(
                    f"CUDA OOM during Kronos-{self.loaded_model_key} inference on {symbol}: {exc}"
                ) from exc
            raise

        elapsed_ms = round((time.perf_counter() - t0) * 1000.0, 2)
        peak_alloc_mb = 0.0
        peak_reserved_mb = 0.0
        if torch.cuda.is_available():
            peak_alloc_mb = round(torch.cuda.max_memory_allocated(0) / (1024 * 1024), 2)
            peak_reserved_mb = round(torch.cuda.max_memory_reserved(0) / (1024 * 1024), 2)

        # Denormalize mean and individual samples
        # mean_preds_norm shape: (1, pred_len, 6), all_samples_norm shape: (1, sample_count, pred_len, 6)
        mean_preds = mean_preds_norm[0] * (x_std + 1e-5) + x_mean
        all_samples = all_samples_norm[0] * (x_std + 1e-5) + x_mean  # (sample_count, pred_len, 6)

        predicted_candles: list[dict[str, Any]] = []
        for step_idx in range(pred_len):
            f_open_t = future_open_times[step_idx]
            f_close_t = f_open_t + ONE_HOUR_MS - 1
            m_row = mean_preds[step_idx]
            sample_closes = all_samples[:, step_idx, 3]
            sample_highs = all_samples[:, step_idx, 1]
            sample_lows = all_samples[:, step_idx, 2]

            p_open = float(m_row[0])
            p_close = float(m_row[3])
            p_high = float(max(m_row[1], p_open, p_close))
            p_low = float(min(m_row[2], p_open, p_close))
            p_vol = float(max(0.0, m_row[4]))

            predicted_candles.append(
                {
                    "step": step_idx + 1,
                    "openTime": f_open_t,
                    "closeTime": f_close_t,
                    "time": f_open_t // 1000,
                    "open": round(p_open, 8),
                    "high": round(p_high, 8),
                    "low": round(p_low, 8),
                    "close": round(p_close, 8),
                    "volume": round(p_vol, 4),
                    "sampleDispersion": {
                        "closeMin": round(float(np.min(sample_closes)), 8),
                        "closeMax": round(float(np.max(sample_closes)), 8),
                        "closeStd": round(float(np.std(sample_closes, ddof=0)), 8),
                        "highMax": round(float(np.max(sample_highs)), 8),
                        "lowMin": round(float(np.min(sample_lows)), 8),
                        "sampleCloses": [round(float(v), 8) for v in sample_closes.tolist()],
                        "sampleCount": sample_count,
                        "label": "抽樣離散程度（5 次抽樣範圍，非校準信賴區間）",
                    },
                }
            )

        pred_close_4h = predicted_candles[-1]["close"]
        pred_return_4h = (pred_close_4h - last_close) / last_close

        hist_slice = wdf.tail(history_display_bars)
        historical_candles = [
            {
                "openTime": int(r["open_time"]),
                "closeTime": int(r["open_time"]) + ONE_HOUR_MS - 1,
                "time": int(r["open_time"]) // 1000,
                "open": float(r["open"]),
                "high": float(r["high"]),
                "low": float(r["low"]),
                "close": float(r["close"]),
                "volume": float(r["volume"]),
            }
            for _, r in hist_slice.iterrows()
        ]

        return {
            "symbol": symbol,
            "modelKey": self.loaded_model_key,
            "repoId": self.model_info.get("repoId") if self.model_info else MODEL_REPO_MAP[self.loaded_model_key],
            "revision": self.model_info.get("revision", "unknown") if self.model_info else "unknown",
            "cutoffTime": cutoff_time,
            "lastOpenTime": last_open_time,
            "lastClosePrice": last_close,
            "predictedClose4h": pred_close_4h,
            "predictedReturn4h": round(float(pred_return_4h), 6),
            "elapsedMs": elapsed_ms,
            "peakVramAllocatedMb": peak_alloc_mb,
            "peakVramReservedMb": peak_reserved_mb,
            "inferenceConfig": KRONOS_INFERENCE_CONFIG,
            "historicalCandles": historical_candles,
            "predictedCandles": predicted_candles,
            "dispersionDisclaimer": "抽樣範圍僅代表 5 次抽樣之離散程度，不得解釋為校準信賴區間。",
        }


def extract_256_window(
    df_1h: pd.DataFrame,
    symbol: str,
    decision_open_time: int,
    lookback: int = 256,
) -> pd.DataFrame | None:
    """
    Extract exact `lookback` (256) consecutive closed 1h candles ending at `decision_open_time`
    for `symbol`. Returns None if any bar in the 256-hour window is missing.
    """
    start_open_time = int(decision_open_time) - (lookback - 1) * ONE_HOUR_MS
    sub = df_1h[
        (df_1h["symbol"] == symbol)
        & (df_1h["open_time"] >= start_open_time)
        & (df_1h["open_time"] <= int(decision_open_time))
    ].sort_values("open_time")
    if len(sub) != lookback:
        return None
    diffs = np.diff(sub["open_time"].to_numpy(dtype=np.int64))
    if not np.all(diffs == ONE_HOUR_MS):
        return None
    return sub.reset_index(drop=True)


def infer_kronos_for_candidates(
    df_1h: pd.DataFrame,
    candidate_symbols: list[str],
    decision_open_time: int,
    weights_root: Path,
    model_key: str = "small",
    require_cuda: bool = True,
) -> dict[str, Any]:
    """
    Run sequential Kronos inference (batch=1) for at most 6 deduplicated top candidate symbols.
    """
    clean_1h, _ = validate_and_deduplicate_1h(df_1h, cutoff_ms=int(decision_open_time) + ONE_HOUR_MS)
    dedup_symbols: list[str] = []
    for s in candidate_symbols:
        if s not in dedup_symbols:
            dedup_symbols.append(s)
        if len(dedup_symbols) >= 6:
            break

    engine = KronosInferenceEngine(weights_root=weights_root, require_cuda=require_cuda)
    t_start = time.perf_counter()
    try:
        model_info = engine.load_model(model_key)
        forecasts: dict[str, dict[str, Any]] = {}
        skipped: list[dict[str, str]] = []
        max_alloc_mb = 0.0
        max_reserved_mb = 0.0

        for sym in dedup_symbols:
            wdf = extract_256_window(clean_1h, sym, decision_open_time, lookback=KRONOS_INFERENCE_CONFIG["lookback"])
            if wdf is None:
                skipped.append({"symbol": sym, "reason": "連續 256 根已收盤 1h K 線不足或存在缺口"})
                continue
            pred = engine.predict_single_window(wdf, symbol=sym)
            forecasts[sym] = pred
            max_alloc_mb = max(max_alloc_mb, float(pred["peakVramAllocatedMb"]))
            max_reserved_mb = max(max_reserved_mb, float(pred["peakVramReservedMb"]))

        total_elapsed_ms = round((time.perf_counter() - t_start) * 1000.0, 2)
        return {
            "modelKey": normalize_model_key(model_key),
            "modelInfo": model_info,
            "gpuEnv": get_gpu_environment_info(),
            "inferenceConfig": KRONOS_INFERENCE_CONFIG,
            "targetSymbols": dedup_symbols,
            "forecasts": forecasts,
            "skippedSymbols": skipped,
            "totalElapsedMs": total_elapsed_ms,
            "peakVramAllocatedMb": max_alloc_mb,
            "peakVramReservedMb": max_reserved_mb,
        }
    finally:
        engine.unload()
