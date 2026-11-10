"""Fresh-process inference from saved artifacts; contains no training route."""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path, PurePosixPath

from .common import atomic_json, hash_file
from .config import SOURCE_ROOT, dataset_identity
from .dataset import freeze_common_cohort, load_source
from .registry import get_spec


def run_inference(model_run: Path, output: Path, keys: list[str]) -> dict:
    from .runner import _run_worker, _env_identity, _validate_prediction
    original = json.loads((model_run / "run_manifest.json").read_text(encoding="utf-8"))
    if not keys or len(set(keys)) != len(keys):
        raise ValueError("select unique saved models")
    if original.get("source_identity") != dataset_identity(SOURCE_ROOT):
        raise ValueError("saved model source identity differs from the selected dataset")
    if (output / "run_manifest.json").exists():
        raise FileExistsError("inference output already exists")
    output.mkdir(parents=True, exist_ok=True)
    panel, klines, identity = load_source()
    freeze_common_cohort(panel, klines, output, identity, smoke=bool(original.get("smoke")))
    state = {"schema": 1, "run_id": output.name, "action": "infer", "status": "RUNNING",
             "source_model_run": str(model_run), "source_identity": identity, "models": {}}
    atomic_json(output / "run_manifest.json", state)
    for key in keys:
        try:
            spec = get_spec(key)
            saved = original["models"][key]
            if saved.get("status") != "SUCCESS" or not saved.get("artifact_hashes"):
                raise ValueError("saved model has no successful, hashed artifacts")
            portable = PurePosixPath(str(saved["attempt_dir"]).replace("\\", "/"))
            raw = Path(*portable.parts)
            if portable.is_absolute() or raw.is_absolute() or (portable.parts and portable.parts[0].endswith(":")):
                # Portable exports can contain the former Colab absolute path.
                parts = portable.parts
                if model_run.name not in parts:
                    raise ValueError("saved attempt path cannot be rebased")
                raw = Path(*parts[parts.index(model_run.name) + 1:])
            attempt_source = (model_run / raw).resolve()
            attempt_source.relative_to(model_run.resolve())
            attempt = output / "models" / key / "inference"
            attempt.mkdir(parents=True, exist_ok=False)
            for relative, digest in saved["artifact_hashes"].items():
                source = (attempt_source / relative).resolve()
                source.relative_to(attempt_source)
                if source.is_symlink() or hash_file(source) != digest:
                    raise ValueError(f"saved artifact hash mismatch: {relative}")
                target = attempt / source.relative_to(attempt_source)
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(source, target)
            device = "cpu" if spec.family == "rank" else "cuda"
            env_id = _env_identity(spec.environment, key)
            if env_id.get("error"):
                raise ValueError(env_id["error"])
            # The worker is explicitly predict-only and loads a saved adapter/model.
            prediction, rc, stderr = _run_worker(key, "predict", attempt, output, device,
                bool(original.get("smoke")), saved["fingerprint"], env_id,
                output / "logs" / (key + ".log"), output / "run_manifest.json")
            if rc:
                raise RuntimeError(stderr[-2000:])
            _validate_prediction(attempt / "predictions.parquet", key)
            state["models"][key] = {"status": "SUCCESS", "predict": prediction,
                                     "source_fingerprint": saved["fingerprint"], "device": device}
        except Exception as exc:
            state["models"][key] = {"status": "FAILED", "error": f"{type(exc).__name__}: {exc}"}
        atomic_json(output / "run_manifest.json", state)
    count = sum(item["status"] == "SUCCESS" for item in state["models"].values())
    state["status"] = "SUCCESS" if count == len(keys) else ("PARTIAL" if count else "FAILED")
    state["note"] = "Saved-model inference on the fixed research TEST cohort; no training or new out-of-sample claim."
    atomic_json(output / "run_manifest.json", state)
    return state


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-run", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--models", required=True)
    args = parser.parse_args()
    result = run_inference(args.model_run, args.output, args.models.split(","))
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result["status"] == "SUCCESS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
