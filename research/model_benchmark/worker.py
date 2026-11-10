"""One-model child-process adapter runner. Heavy libraries load only in their env."""
from __future__ import annotations

import argparse
import json
import sys
import time
import traceback
from pathlib import Path
from typing import Any

from .registry import load_adapter, get_spec


def execute(context: dict[str, Any]) -> dict[str, Any]:
    action = context.get("action")
    if action not in {"train", "predict"}:
        raise ValueError(f"unsupported worker action: {action}")
    if action == "train":
        adapter = load_adapter(str(context["model_key"]))
        started = time.perf_counter()
        result = adapter.train(context)
        if not isinstance(result, dict) or result.get("trained") is not True:
            raise RuntimeError("adapter did not confirm actual training/fine-tuning (trained=True)")
        return {**result, "worker_training_elapsed_seconds": time.perf_counter() - started}
    started = time.perf_counter()
    adapter = load_adapter(str(context["model_key"]))
    load_started = time.perf_counter()
    torch = None
    try:
        import torch as torch_module
        torch = torch_module
        if str(context.get("device", "")).startswith("cuda") and torch.cuda.is_available():
            torch.cuda.reset_peak_memory_stats()
    except ImportError:
        pass
    loaded = adapter.load(context)
    if loaded is not None:
        adapter = loaded
    load_seconds = time.perf_counter() - load_started
    predict_started = time.perf_counter()
    result = adapter.predict(context)
    predict_seconds = time.perf_counter() - predict_started
    if not isinstance(result, dict):
        raise TypeError("adapter.predict must return a metadata dict")
    output = Path(context["attempt_dir"]) / "predictions.parquet"
    if not output.is_file():
        raise FileNotFoundError(f"predict action did not write {output}")
    peak_vram_mib = None
    if torch is not None and str(context.get("device", "")).startswith("cuda") and torch.cuda.is_available():
        peak_vram_mib = float(torch.cuda.max_memory_allocated() / (1024 * 1024))
    warmup_latency = result.get("warmup_latency_ms", result.get("warm_inference_latency_ms"))
    return {**result, "predictions_path": str(output), "predictions_sha256": _hash(output), "fresh_load": True,
            "worker_device": context.get("device"),
            "worker_load_seconds": load_seconds, "worker_inference_seconds": predict_seconds,
            "warm_inference_latency_ms": warmup_latency,
            "worker_total_elapsed_seconds": time.perf_counter() - started, "peak_vram_mib": peak_vram_mib}


def _hash(path: Path) -> str:
    import hashlib
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--context", required=True, type=Path)
    args = parser.parse_args()
    try:
        context = json.loads(args.context.read_text(encoding="utf-8"))
        spec = get_spec(context["model_key"])
        if spec.environment != context.get("environment"):
            raise ValueError("context environment does not match registry")
        result = execute(context)
        print(json.dumps({"ok": True, "model_key": spec.key, "action": context["action"], "result": result}, ensure_ascii=False, default=str))
        return 0
    except BaseException as exc:
        print(json.dumps({"ok": False, "error": f"{type(exc).__name__}: {exc}", "traceback": traceback.format_exc()}, ensure_ascii=False), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
