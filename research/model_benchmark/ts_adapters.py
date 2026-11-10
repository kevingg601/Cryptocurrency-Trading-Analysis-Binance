"""LoRA adapters for the pinned Chronos-2 and TimesFM 2.5 checkpoints."""
from __future__ import annotations

import hashlib
import json
import math
import os
import random
import time
from pathlib import Path
from typing import Any, Iterable

import numpy as np
import pandas as pd

from .common import atomic_json, hash_file
from .config import SOURCE_ROOT, TS_COMMON_CONFIG, TS_CONFIGS

HOUR_MS = 3_600_000
DAY_MS = 24 * HOUR_MS
ASSET_LOCK_PATH = Path(__file__).with_name("model-assets.lock.json")
ASSET_CACHE_ROOT = Path(__file__).resolve().parents[2] / ".benchmark-cache" / "models"


def _read_asset_lock() -> dict[str, Any]:
    return json.loads(ASSET_LOCK_PATH.read_text(encoding="utf-8"))


def _asset_dir(model_key: str) -> Path:
    return ASSET_CACHE_ROOT / model_key


def _ensure_asset_hashes(model_key: str) -> dict[str, Any]:
    info = _read_asset_lock()["models"][model_key]
    for filename, expected in info["files"].items():
        path = _asset_dir(model_key) / filename
        if not path.is_file():
            raise FileNotFoundError(f"Pinned model asset missing: {path}; run bootstrap --prepare")
        actual = hash_file(path)
        if actual.lower() != expected.lower():
            raise ValueError(f"Pinned model asset SHA-256 mismatch for {path}: {actual}")
    return info


def _seed(seed: int) -> None:
    import torch

    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    if torch.cuda.is_available():
        torch.cuda.manual_seed_all(seed)
    torch.use_deterministic_algorithms(False)


def _require_peft() -> Any:
    try:
        import peft
    except ImportError as exc:
        raise RuntimeError("PEFT is required for LoRA; refusing silent full fine-tuning fallback") from exc
    return peft


def _timesfm_future_tensor(values: np.ndarray, device: str) -> Any:
    import torch

    tensor = torch.as_tensor(values, dtype=torch.float32, device=device)
    if tensor.ndim != 1 or tensor.numel() != 4:
        raise ValueError("TimesFM supervised targets must contain exactly four future closes")
    return tensor.unsqueeze(0)


def _load_source(context: dict[str, Any]) -> tuple[pd.DataFrame, dict[str, Any]]:
    source_root = Path(context.get("source_root") or SOURCE_ROOT)
    ds = source_root / "datasets"
    manifest_path = ds / "dataset_manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    if int(manifest.get("pipelineVersion", 0)) != 3:
        raise ValueError("TS adapters require the approved immutable v3 data snapshot")
    expected = manifest.get("files", {}).get("klines1hParquet", {}).get("sha256")
    klines_path = ds / "klines_1h.parquet"
    if not expected or hash_file(klines_path) != expected:
        raise ValueError("klines_1h.parquet does not match the v3 dataset manifest")
    klines = pd.read_parquet(klines_path, columns=["symbol", "open_time", "close", "is_final"])
    klines = klines.loc[klines["is_final"].astype(bool)].copy()
    klines["open_time"] = klines["open_time"].astype("int64")
    klines["close"] = klines["close"].astype("float64")
    klines = klines.sort_values(["symbol", "open_time"], kind="stable").reset_index(drop=True)
    boundaries = manifest.get("boundaries", {})
    required = ("startMs", "trainEndMs", "valEndMs", "testEndMs")
    if any(name not in boundaries for name in required):
        raise ValueError("v3 manifest lacks the fixed train/val/test boundaries")
    return klines, {k: int(boundaries[k]) for k in required}


def _window_rows(
    klines: pd.DataFrame,
    boundaries: dict[str, int],
    split: str,
    *,
    midnight_only: bool = False,
    cohort_path: Path | None = None,
    max_windows: int | None = None,
) -> list[dict[str, Any]]:
    lo, hi = {
        "train": (boundaries["startMs"], boundaries["trainEndMs"]),
        "val": (boundaries["trainEndMs"], boundaries["valEndMs"]),
        "test": (boundaries["valEndMs"], boundaries["testEndMs"]),
    }[split]
    desired: dict[tuple[str, int], dict[str, Any]] | None = None
    if cohort_path and cohort_path.is_file():
        frozen = json.loads(cohort_path.read_text(encoding="utf-8"))
        # The v3 panel timestamp is the final closed input candle (decision_time
        # is one hour later); the first predicted candle opens at open_time+1h.
        desired = {(str(r["symbol"]), int(r["open_time"]) + HOUR_MS): r for r in frozen["rows"]}
    out: list[dict[str, Any]] = []
    for symbol, group in klines.groupby("symbol", sort=False):
        times = group["open_time"].to_numpy(dtype=np.int64)
        closes = group["close"].to_numpy(dtype=np.float64)
        if len(times) < 256 + 4:
            continue
        # Every item is assembled within one symbol. Discontinuities discard
        # the affected origin instead of joining across missing hours.
        gap = np.diff(times)
        start_index = max(256, int(np.searchsorted(times, lo, side="left")))
        stop_index = int(np.searchsorted(times, hi - 3 * HOUR_MS, side="right"))
        stride = 24 if midnight_only else 4
        for origin_i in range(start_index, stop_index):
            origin = int(times[origin_i])
            if midnight_only and origin % DAY_MS != 0:
                continue
            if not midnight_only and (origin - lo) % (4 * HOUR_MS) != 0:
                continue
            if origin_i + 4 > len(times):
                continue
            context_times = times[origin_i - 256 : origin_i]
            future_times = times[origin_i : origin_i + 4]
            full_times = np.concatenate((context_times, future_times))
            if len(full_times) != 260 or np.any(np.diff(full_times) != HOUR_MS):
                continue
            if context_times[-1] >= origin or future_times[0] != origin or future_times[-1] + HOUR_MS > hi:
                continue
            if desired is not None and (str(symbol), origin) not in desired:
                continue
            context = closes[origin_i - 256 : origin_i]
            target = closes[origin_i : origin_i + 4]
            if not np.all(np.isfinite(context)) or not np.all(np.isfinite(target)) or context[-1] <= 0:
                continue
            out.append({
                "symbol": str(symbol), "open_time": origin,
                "context": context.astype(np.float32, copy=True),
                "target": target.astype(np.float32, copy=True),
            })
    out.sort(key=lambda row: (row["open_time"], row["symbol"]))
    if split != "train" and midnight_only:
        # Shared forecast cohort requires complete time groups. Keep the full
        # timestamp group and reject groups with fewer than ten symbols.
        counts: dict[int, int] = {}
        for row in out:
            counts[row["open_time"]] = counts.get(row["open_time"], 0) + 1
        out = [r for r in out if counts[r["open_time"]] >= 10]
    if max_windows is not None:
        out = out[: max(8, int(max_windows))]
    return out


def _prediction_mean(model_key: str, model: Any, contexts: list[np.ndarray], device: str) -> np.ndarray:
    import torch

    model.eval()
    outputs: list[np.ndarray] = []
    with torch.inference_mode():
        if model_key == "chronos2":
            from chronos import Chronos2Pipeline

            pipeline = Chronos2Pipeline(model=model)
            quantiles = list(pipeline.quantiles)
            qindex = min(range(len(quantiles)), key=lambda i: abs(float(quantiles[i]) - 0.5))
            inputs = [torch.as_tensor(row, dtype=torch.float32) for row in contexts]
            for start in range(0, len(inputs), 8):
                predictions = pipeline.predict(inputs[start : start + 8], prediction_length=4, batch_size=1)
                for tensor in predictions:
                    outputs.append(tensor[0, qindex, :4].detach().cpu().numpy().astype(np.float64))
        else:
            for row in contexts:
                past = torch.as_tensor(row, dtype=torch.float32, device=device)
                prediction = model(past_values=[past], forecast_context_len=256, return_dict=True)
                forecast_obj = prediction.mean_predictions
                if isinstance(forecast_obj, (list, tuple)):
                    forecast = forecast_obj[0].detach().cpu().reshape(-1).numpy()[:4]
                else:
                    forecast = forecast_obj[0].detach().cpu().reshape(-1).numpy()[:4]
                outputs.append(forecast[:4].astype(np.float64))
    if any(forecast.shape[0] < 4 or not np.all(np.isfinite(forecast[:4])) for forecast in outputs):
        raise ValueError(f"{model_key} returned invalid or short forecast")
    return np.stack(outputs) if outputs else np.empty((0, 4), dtype=np.float64)


def _score(model_key: str, model: Any, rows: list[dict[str, Any]], device: str, variant: str) -> tuple[dict[str, float], list[dict[str, Any]]]:
    if not rows:
        raise ValueError("no eligible TS evaluation windows")
    forecasts = _prediction_mean(model_key, model, [r["context"] for r in rows], device)
    actual_returns = np.asarray([float(r["target"][-1]) / float(r["context"][-1]) - 1.0 for r in rows])
    predicted_returns = forecasts[:, 3] / np.asarray([float(r["context"][-1]) for r in rows]) - 1.0
    errors = np.abs(predicted_returns - actual_returns)
    metrics = {
        "return_mae": float(np.mean(errors)),
        "direction_hit_rate": (
            float(np.mean(np.sign(predicted_returns[actual_returns != 0]) == np.sign(actual_returns[actual_returns != 0])))
            if np.count_nonzero(actual_returns != 0) else None
        ),
        "valid_direction_count": int(np.count_nonzero(actual_returns != 0)),
        "samples": int(len(rows)),
    }
    predictions = [
        {
            # Persist the v3 key candle (last context candle), not the first
            # target candle. This is the same symbol/open_time key as the
            # frozen ranking cohort and research-panel row.
            "symbol": row["symbol"], "open_time": int(row["open_time"] - HOUR_MS), "variant": variant,
            "pred_close_4h": float(forecast[3]), "pred_return_4h": float(forecast[3] / float(row["context"][-1]) - 1.0),
        }
        for row, forecast in zip(rows, forecasts, strict=True)
    ]
    return metrics, predictions


def _base_model(model_key: str, device: str) -> Any:
    _ensure_asset_hashes(model_key)
    model_dir = str(_asset_dir(model_key))
    if model_key == "chronos2":
        from chronos import Chronos2Pipeline

        return Chronos2Pipeline.from_pretrained(model_dir, device_map=device, torch_dtype=__import__("torch").float32).model
    from transformers import TimesFm2_5ModelForPrediction

    return TimesFm2_5ModelForPrediction.from_pretrained(model_dir, torch_dtype=__import__("torch").float32).to(device)


def _base_chronos_pipeline(device: str) -> Any:
    _ensure_asset_hashes("chronos2")
    from chronos import Chronos2Pipeline

    return Chronos2Pipeline.from_pretrained(
        str(_asset_dir("chronos2")), device_map=device, torch_dtype=__import__("torch").float32
    )


class _BestValidationCallback:
    """TrainerCallback which early-stops on external 4-hour return MAE."""

    def __init__(self, adapter: "TsAdapter", val_rows: list[dict[str, Any]], device: str, patience: int):
        from transformers import TrainerCallback

        class Callback(TrainerCallback):
            def __init__(self, outer: "_BestValidationCallback"):
                self.outer = outer

            def on_evaluate(self, args, state, control, **kwargs):
                model = kwargs.get("model")
                if model is None:
                    raise RuntimeError("Transformers evaluate callback did not expose the model")
                score, _ = _score(self.outer.adapter.model_key, model, self.outer.val_rows, self.outer.device, "finetuned")
                score_value = score["return_mae"]
                self.outer.record(score_value, int(state.global_step), model)
                if self.outer.stale_evaluations >= self.outer.patience:
                    control.should_training_stop = True
                return control

            def on_pre_optimizer_step(self, args, state, control, model=None, **kwargs):
                if model is None:
                    raise RuntimeError("training callback did not expose the active model")
                trainable = [p for p in model.parameters() if p.requires_grad]
                grads = [p.grad for p in trainable if p.grad is not None]
                if not grads or any(not self.outer._torch_isfinite(g) for g in grads):
                    raise RuntimeError("Chronos LoRA gradients are missing or non-finite")
                self.outer.gradient_updates += 1
                return control

        self.adapter = adapter
        self.val_rows = val_rows
        self.device = device
        self.patience = patience
        self.best_mae = math.inf
        self.best_step = 0
        self.best_state: dict[str, Any] | None = None
        self.stale_evaluations = 0
        self.gradient_updates = 0
        self.callback = Callback(self)

    @staticmethod
    def _torch_isfinite(tensor: Any) -> bool:
        import torch

        return bool(torch.isfinite(tensor).all().item())

    def record(self, mae: float, step: int, model: Any) -> None:
        import torch

        if math.isfinite(mae) and mae < self.best_mae:
            self.best_mae = mae
            self.best_step = step
            self.stale_evaluations = 0
            state = model.state_dict()
            self.best_state = {k: v.detach().cpu().clone() for k, v in state.items() if "lora_" in k.lower()}
            if not self.best_state:
                raise RuntimeError("validation event found no trainable LoRA adapter weights")
        else:
            self.stale_evaluations += 1


class TsAdapter:
    """Fixed data contract for actual Chronos-2 / TimesFM 2.5 LoRA tuning."""

    def __init__(self, model_key: str):
        if model_key not in {"chronos2", "timesfm25"}:
            raise KeyError(model_key)
        self.model_key = model_key
        self.model: Any | None = None
        self.device = "cpu"

    def _context(self, context: dict[str, Any]) -> tuple[Path, dict[str, Any], dict[str, Any]]:
        attempt = Path(context["attempt_dir"])
        attempt.mkdir(parents=True, exist_ok=True)
        cache_root = Path(__file__).resolve().parents[2] / ".benchmark-cache"
        os.environ.setdefault("HF_HOME", str(cache_root / "hf"))
        os.environ.setdefault("HF_HUB_CACHE", str(cache_root / "hf" / "hub"))
        os.environ.setdefault("PIP_CACHE_DIR", str(cache_root / "pip"))
        os.environ.setdefault("TORCH_HOME", str(cache_root / "torch"))
        os.environ.setdefault("CUDA_CACHE_PATH", str(cache_root / "cuda"))
        source, boundaries = _load_source(context)
        config = {**TS_COMMON_CONFIG, **TS_CONFIGS[self.model_key], **context.get("config", {})}
        self.device = str(context.get("device", "cuda" if __import__("torch").cuda.is_available() else "cpu"))
        return attempt, boundaries, config

    def train(self, context: dict[str, Any]) -> dict[str, Any]:
        import torch

        attempt, boundaries, config = self._context(context)
        _seed(int(config.get("seed", 42)))
        train_rows = _window_rows(
            _load_source(context)[0], boundaries, "train",
            max_windows=int(config.get("smoke_max_windows", 64)) if context.get("smoke") else None,
        )
        val_rows = _window_rows(_load_source(context)[0], boundaries, "val", midnight_only=True)
        if not train_rows or not val_rows:
            raise ValueError(f"insufficient train/val windows: train={len(train_rows)}, val={len(val_rows)}")
        if context.get("smoke"):
            val_rows = val_rows[: min(2, len(val_rows))]
        updates = min(int(config["max_optimizer_updates"]), int(config.get("max_updates_override", 1 if context.get("smoke") else 2000)))
        started = time.perf_counter()
        gradient_accumulation = int(config["gradient_accumulation"])
        if self.model_key == "chronos2":
            model, update_count, finite_gradient_steps, best_mae, best_step, changed = self._train_chronos(
                attempt, train_rows, val_rows, config, updates, gradient_accumulation, context
            )
        else:
            model = _base_model(self.model_key, self.device)
            model.to(device=self.device, dtype=torch.float32)
            model.train()
            from peft import LoraConfig, get_peft_model

            lora = LoraConfig(
                r=int(config["lora_rank"]), lora_alpha=int(config["lora_alpha"]),
                lora_dropout=float(config["lora_dropout"]), target_modules="all-linear",
                bias="none", task_type=None,
            )
            model = get_peft_model(model, lora)
            trainable = [(name, parameter) for name, parameter in model.named_parameters() if parameter.requires_grad]
            if not trainable or not all("lora_" in name.lower() for name, _ in trainable):
                raise RuntimeError("PEFT did not expose trainable LoRA adapter parameters")
            initial = {name: parameter.detach().cpu().clone() for name, parameter in trainable}
            optimizer = torch.optim.AdamW([p for _, p in trainable], lr=float(config["learning_rate"]))
            rng = np.random.default_rng(int(config.get("seed", 42)))
            update_count = 0
            finite_gradient_steps = 0
            best_mae = math.inf
            best_step = 0
            stale = 0
            best_state: dict[str, torch.Tensor] | None = None
            optimizer.zero_grad(set_to_none=True)
            model.train()
            for step in range(1, updates + 1):
                for _ in range(gradient_accumulation):
                    row = train_rows[int(rng.integers(0, len(train_rows)))]
                    past = torch.as_tensor(row["context"], dtype=torch.float32, device=self.device)
                    future = torch.as_tensor(row["target"], dtype=torch.float32, device=self.device)
                    # TimesFM accepts ragged past series as a list, while its
                    # supervised target is a right-padded (batch, horizon)
                    # tensor. Supplying exactly four columns prevents loss
                    # computation from seeing any extra native forecast steps.
                    output = model(
                        past_values=[past], future_values=_timesfm_future_tensor(row["target"], self.device),
                        forecast_context_len=256, return_dict=True,
                    )
                    loss = output.loss
                    if loss is None or not torch.isfinite(loss):
                        raise RuntimeError("TimesFM emitted an invalid training loss")
                    (loss / gradient_accumulation).backward()
                grad_values = [p.grad for _, p in trainable if p.grad is not None]
                if not grad_values or any(not torch.isfinite(g).all() for g in grad_values):
                    raise RuntimeError("LoRA gradients are missing or non-finite")
                finite_gradient_steps += 1
                optimizer.step()
                optimizer.zero_grad(set_to_none=True)
                update_count += 1
                if context.get("smoke") or step % int(config["eval_interval"]) == 0 or step == updates:
                    val_metric, _ = _score(self.model_key, model, val_rows, self.device, "finetuned")
                    if val_metric["return_mae"] < best_mae:
                        best_mae = val_metric["return_mae"]
                        best_step = step
                        stale = 0
                        best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items() if "lora_" in k.lower()}
                    else:
                        stale += 1
                    if not context.get("smoke") and stale >= int(config["early_stopping_evaluations"]):
                        break
                    model.train()
            if best_state:
                model.load_state_dict(best_state, strict=False)
            changed = any(not torch.equal(initial[name], parameter.detach().cpu()) for name, parameter in trainable)
        if update_count < 1 or finite_gradient_steps != update_count:
            raise RuntimeError("No finite LoRA optimizer update was completed")
        if not changed:
            raise RuntimeError("LoRA weights did not change after optimizer updates")
        trainable = [(name, parameter) for name, parameter in model.named_parameters() if parameter.requires_grad]
        self.model = model
        self.model.eval()
        artifact_hashes = self.save(context)
        pretrained = _base_model(self.model_key, self.device)
        pretrained.to(device=self.device, dtype=torch.float32)
        val_base, _ = _score(self.model_key, pretrained, val_rows, self.device, "pretrained")
        val_fine, _ = _score(self.model_key, model, val_rows, self.device, "finetuned")
        metadata = {
            "trained": True, "model_key": self.model_key, "model_id": TS_CONFIGS[self.model_key]["model_id"],
            "revision": _ensure_asset_hashes(self.model_key)["revision"],
            "weight_hashes": _ensure_asset_hashes(self.model_key)["files"],
            "training_windows": len(train_rows), "validation_windows": len(val_rows),
            "optimizer_updates": update_count, "finite_gradient_updates": finite_gradient_steps,
            "optimizer_steps": update_count, "training_steps": update_count, "updates": update_count,
            "trainable_parameters": len(trainable), "trainable_parameter_count": int(sum(p.numel() for _, p in trainable)),
            "lora_weights_changed": bool(changed), "best_optimizer_step": best_step,
            "best_val_return_mae": float(best_mae), "val_metrics_pretrained": val_base,
            "val_metrics_finetuned": val_fine, "training_elapsed_seconds": time.perf_counter() - started,
            "device": self.device, "training_device": self.device, "dtype": "float32", "split_policy": "TRAIN windows only; VAL UTC midnight return MAE; TEST untouched",
            "config": config,
        }
        metadata["artifact_hashes"] = artifact_hashes
        _write_model_metadata(attempt, metadata)
        return metadata

    def _train_chronos(
        self,
        attempt: Path,
        train_rows: list[dict[str, Any]],
        val_rows: list[dict[str, Any]],
        config: dict[str, Any],
        updates: int,
        accumulation: int,
        context: dict[str, Any],
    ) -> tuple[Any, int, int, float, int, bool]:
        import torch
        _require_peft()
        from peft import LoraConfig

        pipeline = _base_chronos_pipeline(self.device)
        initial_adapter = None
        trainable_after: list[tuple[str, Any]] = []
        callback = _BestValidationCallback(
            self, val_rows, self.device, int(config["early_stopping_evaluations"])
        )
        # fit() samples a random cutoff from each supplied series. Each supplied
        # item is exactly 256 historical closes plus 4 TRAIN labels, so every
        # sampled cutoff has precisely the approved supervised horizon.
        train_inputs = [
            {"target": torch.as_tensor(np.concatenate([r["context"], r["target"]]), dtype=torch.float32)}
            for r in train_rows
        ]
        val_inputs = [
            {"target": torch.as_tensor(np.concatenate([r["context"], r["target"]]), dtype=torch.float32)}
            for r in val_rows
        ]
        output_dir = attempt / "chronos-training"
        output_dir.mkdir(parents=True, exist_ok=True)
        lora = LoraConfig(
            r=int(config["lora_rank"]), lora_alpha=int(config["lora_alpha"]),
            lora_dropout=float(config["lora_dropout"]), bias="none",
            target_modules=[
                "self_attention.q", "self_attention.v", "self_attention.k", "self_attention.o",
                "output_patch_embedding.output_layer",
            ],
        )
        # Chronos2Pipeline.fit silently falls back to full fine-tuning when
        # PEFT is unavailable; _require_peft() has already blocked that path.
        fine_pipeline = pipeline.fit(
            inputs=train_inputs,
            validation_inputs=val_inputs,
            prediction_length=4,
            finetune_mode="lora",
            lora_config=lora,
            context_length=256,
            min_past=256,
            learning_rate=float(config["learning_rate"]),
            num_steps=updates,
            batch_size=1,
            output_dir=output_dir,
            finetuned_ckpt_name="native-fit-checkpoint",
            callbacks=[callback.callback],
            remove_printer_callback=True,
            disable_data_parallel=True,
            gradient_accumulation_steps=accumulation,
            eval_strategy="steps",
            eval_steps=int(config["eval_interval"]),
            save_strategy="steps",
            save_steps=int(config["eval_interval"]),
            save_total_limit=1,
            load_best_model_at_end=False,
            dataloader_num_workers=0,
            report_to="none",
            fp16=False,
            bf16=False,
        )
        model = fine_pipeline.model
        trainable_after = [(n, p) for n, p in model.named_parameters() if p.requires_grad]
        if not trainable_after or not all("lora_" in n.lower() for n, _ in trainable_after):
            raise RuntimeError("Chronos-2 fit did not return a PEFT LoRA model")
        state = getattr(fine_pipeline, "_trainer_state", None)
        # Trainer state is also retained in the last native checkpoint, while
        # callback step counts provide the actual optimizer-update evidence.
        trainer_steps = int(callback.gradient_updates)
        if trainer_steps < 1:
            raise RuntimeError("Chronos-2 performed no verified finite-gradient optimizer update")
        if callback.best_state is not None:
            incompatible = model.load_state_dict(callback.best_state, strict=False)
            if len(incompatible.unexpected_keys) == len(callback.best_state):
                raise RuntimeError("could not restore the VAL-MAE-selected LoRA adapter")
        if callback.best_step == 0:
            # A final evaluation is required for smoke runs whose Trainer may
            # not call on_evaluate at the last partial interval.
            score, _ = _score(self.model_key, model, val_rows, self.device, "finetuned")
            callback.record(score["return_mae"], trainer_steps, model)
            callback.best_step = trainer_steps
            callback.best_mae = score["return_mae"]
            callback.best_state = {k: v.detach().cpu().clone() for k, v in model.state_dict().items() if "lora_" in k.lower()}
        if callback.best_state:
            model.load_state_dict(callback.best_state, strict=False)
        lora_b = [p.detach() for n, p in model.named_parameters() if "lora_b" in n.lower()]
        changed = any(bool(torch.count_nonzero(p).item()) for p in lora_b)
        if not changed:
            raise RuntimeError("Chronos-2 LoRA parameters did not change from PEFT zero-init")
        return model, trainer_steps, trainer_steps, float(callback.best_mae), int(callback.best_step), changed

    def _save_adapter(self, path: Path, model: Any) -> None:
        if path.exists():
            raise FileExistsError(f"refusing to overwrite an existing adapter artifact: {path}")
        path.mkdir(parents=True, exist_ok=True)
        if self.model_key == "chronos2":
            model.save_pretrained(path, safe_serialization=True)
        else:
            model.save_pretrained(path, safe_serialization=True)
        hashes = {p.name: hash_file(p) for p in sorted(path.iterdir()) if p.is_file()}
        if not hashes:
            raise RuntimeError("adapter save created no adapter weight/config files")
        atomic_json(path / "adapter.sha256.json", hashes)

    def save(self, context: dict[str, Any]) -> dict[str, str]:
        if self.model is None:
            raise RuntimeError("no trained model is available to save")
        attempt = Path(context["attempt_dir"])
        self._save_adapter(attempt / "adapter", self.model)
        return {
            str(path.relative_to(attempt)): hash_file(path)
            for path in sorted((attempt / "adapter").iterdir()) if path.is_file()
        }

    def load(self, context: dict[str, Any]) -> "TsAdapter":
        import torch
        from peft import PeftModel

        attempt = Path(context["attempt_dir"])
        self.device = str(context.get("device", "cuda" if torch.cuda.is_available() else "cpu"))
        base = _base_model(self.model_key, self.device)
        self.model = PeftModel.from_pretrained(base, attempt / "adapter", is_trainable=False).to(device=self.device, dtype=torch.float32)
        self.model.eval()
        _verify_adapter_hashes(attempt / "adapter")
        return self

    def predict(self, context: dict[str, Any]) -> dict[str, Any]:
        if self.model is None:
            raise RuntimeError("call load(context) before predict(context)")
        attempt = Path(context["attempt_dir"])
        klines, boundaries = _load_source(context)
        configured_cohort = context.get("config", {}).get("smoke_cohort_path")
        common_path = Path(configured_cohort) if configured_cohort else Path(context.get("run_dir", attempt.parent)) / "common_cohort.json"
        test_rows = _window_rows(klines, boundaries, "test", midnight_only=True, cohort_path=common_path)
        if not test_rows:
            raise ValueError("no valid fixed TEST midnight windows for TS model comparison")
        base = _base_model(self.model_key, self.device)
        warmup_latency: dict[str, float] = {}
        for name, model in (("pretrained", base), ("finetuned", self.model)):
            _prediction_mean(self.model_key, model, [test_rows[0]["context"]], self.device)
            if self.device.startswith("cuda"):
                import torch
                torch.cuda.synchronize()
            warm_start = time.perf_counter()
            _prediction_mean(self.model_key, model, [test_rows[0]["context"]], self.device)
            if self.device.startswith("cuda"):
                torch.cuda.synchronize()
            warmup_latency[name] = (time.perf_counter() - warm_start) * 1000.0
        batch_start = time.perf_counter()
        pretrained_metrics, pretrained_rows = _score(self.model_key, base, test_rows, self.device, "pretrained")
        fine_metrics, fine_rows = _score(self.model_key, self.model, test_rows, self.device, "finetuned")
        if self.device.startswith("cuda"):
            torch.cuda.synchronize()
        batch_predict_seconds = time.perf_counter() - batch_start
        output = pd.DataFrame(pretrained_rows + fine_rows)
        output = output[["symbol", "open_time", "variant", "pred_close_4h", "pred_return_4h"]]
        output_path = attempt / "predictions.parquet"
        output.to_parquet(output_path, index=False)
        if set(output["variant"].unique()) != {"pretrained", "finetuned"}:
            raise RuntimeError("prediction parquet must include both pretrained and finetuned variants")
        return {
            "model_key": self.model_key, "trained": True, "rows": len(output),
            "test_metrics_pretrained": pretrained_metrics, "test_metrics_finetuned": fine_metrics,
            "warmup_latency_ms": warmup_latency, "batch_predict_seconds": batch_predict_seconds,
            "predictions_path": str(output_path), "predictions_sha256": hash_file(output_path),
        }


def _write_model_metadata(attempt: Path, metadata: dict[str, Any]) -> None:
    atomic_json(attempt / "ts_adapter_metadata.json", metadata)


def _verify_adapter_hashes(path: Path) -> None:
    hash_path = path / "adapter.sha256.json"
    if not hash_path.is_file():
        raise FileNotFoundError(f"missing adapter hash manifest: {hash_path}")
    expected = json.loads(hash_path.read_text(encoding="utf-8"))
    for name, digest in expected.items():
        file_path = path / name
        if not file_path.is_file() or hash_file(file_path) != digest:
            raise ValueError(f"adapter hash mismatch: {file_path}")

