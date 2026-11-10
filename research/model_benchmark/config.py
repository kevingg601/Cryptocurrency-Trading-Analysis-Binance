"""Benchmark identity and fixed experiment settings."""
from __future__ import annotations

import os
import platform
import sys
from pathlib import Path
from typing import Any

from .common import canonical_json, hash_bytes, hash_file

def _configured_path(env_name: str, default: Path) -> Path:
    configured = os.environ.get(env_name)
    return Path(configured).expanduser().resolve() if configured else default.resolve()


# Root means the checkout containing research/model_benchmark. Keeping this
# explicit lets the same package run from a Windows checkout or a Colab clone.
REPO_ROOT = _configured_path(
    "FADACHI_MODEL_BENCHMARK_ROOT", Path(__file__).resolve().parents[2]
)
SOURCE_ROOT = _configured_path(
    "FADACHI_MODEL_BENCHMARK_SOURCE_ROOT",
    REPO_ROOT / "data-reruns" / "20261110-004810" / "model-research",
)
RUNS_ROOT = _configured_path(
    "FADACHI_MODEL_BENCHMARK_RUNS_ROOT", REPO_ROOT / "data" / "model-benchmark" / "runs"
)
CACHE_ROOT = _configured_path(
    "FADACHI_MODEL_BENCHMARK_CACHE_ROOT", REPO_ROOT / ".benchmark-cache"
)
ENV_ROOT = _configured_path(
    "FADACHI_MODEL_BENCHMARK_ENV_ROOT", REPO_ROOT / ".benchmark-envs"
)
TMP_ROOT = _configured_path(
    "FADACHI_MODEL_BENCHMARK_TMP_ROOT", REPO_ROOT / ".benchmark-tmp"
)
MODEL_KEYS = ("catboost", "xgboost", "chronos2", "timesfm25")

RANK_CONFIG: dict[str, Any] = {
    "seed": 42, "learning_rate": 0.05, "max_rounds": 1000,
    "checkpoint_interval": 25, "early_stopping_evaluations": 4,
    "trials": [
        {"depth": 4, "l2_leaf_reg": 3}, {"depth": 4, "l2_leaf_reg": 10},
        {"depth": 6, "l2_leaf_reg": 3}, {"depth": 6, "l2_leaf_reg": 10},
    ],
}
XGB_CONFIG: dict[str, Any] = {
    "seed": 42, "learning_rate": 0.05, "max_rounds": 1000,
    "checkpoint_interval": 25, "early_stopping_evaluations": 4,
    "trials": [
        {"max_depth": 3, "min_child_weight": 1}, {"max_depth": 3, "min_child_weight": 10},
        {"max_depth": 5, "min_child_weight": 1}, {"max_depth": 5, "min_child_weight": 10},
    ],
}
TS_CONFIGS: dict[str, dict[str, Any]] = {
    "chronos2": {"model_id": "amazon/chronos-2", "learning_rate": 1e-5},
    "timesfm25": {"model_id": "google/timesfm-2.5-200m-transformers", "learning_rate": 1e-4},
}
TS_COMMON_CONFIG: dict[str, Any] = {
    "lookback": 256, "horizon": 4, "window_stride": 4, "lora_rank": 8,
    "lora_alpha": 16, "lora_dropout": 0.05, "micro_batch": 1,
    "gradient_accumulation": 8, "dtype": "float32", "seed": 42,
    "max_optimizer_updates": 2000, "eval_interval": 100,
    "early_stopping_evaluations": 5,
}


def model_config(key: str, smoke: bool = False) -> dict[str, Any]:
    if key in ("catboost", "xgboost"):
        result = dict(RANK_CONFIG if key == "catboost" else XGB_CONFIG)
    elif key in TS_CONFIGS:
        result = {**TS_COMMON_CONFIG, **TS_CONFIGS[key]}
    else:
        raise KeyError(f"unknown model key: {key}")
    if smoke:
        result["smoke"] = True
        # Preserve the four ranker candidates and checkpoint cadence in smoke mode.
        # TS adapters use one real optimizer update for the isolated contract smoke.
        result["max_optimizer_updates"] = 1
        result["eval_interval"] = 1
    return result


def dataset_identity(source_root: Path = SOURCE_ROOT) -> dict[str, Any]:
    datasets = source_root / "datasets"
    manifest_path = datasets / "dataset_manifest.json"
    manifest = __import__("json").loads(manifest_path.read_text(encoding="utf-8"))
    if int(manifest.get("pipelineVersion", 0)) != 3:
        raise ValueError("benchmark requires immutable v3 dataset")
    files = [manifest_path, datasets / "research_panel.parquet", datasets / "klines_1h.parquet", datasets / "funding_rates.parquet"]
    missing = [str(path) for path in files if not path.is_file()]
    if missing:
        raise FileNotFoundError("required source files missing: " + ", ".join(missing))
    expected = {
        "klines_1h.parquet": manifest.get("files", {}).get("klines1hParquet", {}),
        "funding_rates.parquet": manifest.get("files", {}).get("fundingRatesParquet", {}),
        "research_panel.parquet": manifest.get("files", {}).get("researchPanelParquet", {}),
    }
    for name, record in expected.items():
        expected_sha = record.get("sha256")
        if not expected_sha or hash_file(datasets / name) != expected_sha:
            raise ValueError(f"source SHA256 does not match v3 manifest: {name}")
    return {
        "dataset_version": manifest.get("datasetVersion"),
        "pipeline_version": manifest.get("pipelineVersion"),
        "manifest_sha256": hash_file(manifest_path),
        "files": {p.name: hash_file(p) for p in files},
        "boundaries": manifest.get("boundaries", {}),
        "symbols": manifest.get("universe", {}).get("symbols", []),
        "panel_rows": manifest.get("files", {}).get("researchPanelParquet", {}).get("rows"),
        "test_rows": manifest.get("splitSummary", {}).get("test", {}).get("totalSymbolHourRows"),
    }


def benchmark_fingerprint(key: str, source_id: dict[str, Any], smoke: bool = False) -> str:
    config = model_config(key, smoke)
    tracked = list((REPO_ROOT / "research" / "model_benchmark").glob("*.py"))
    for rel in ("research/model_research/features_and_labels.py", "research/model_research/offline_eval.py"):
        p = REPO_ROOT / rel
        if p.exists():
            tracked.append(p)
    adapter_root = REPO_ROOT / "research" / "model_benchmark"
    tracked.extend(p for p in adapter_root.glob("*adapters*.py") if p.is_file())
    tracked.extend(p for p in adapter_root.glob("*.lock.json") if p.is_file())
    from .registry import get_spec
    env_name = get_spec(key).environment
    env_dir = ENV_ROOT / env_name
    platform_lock = adapter_root / (
        "requirements-" + env_name + (".linux.lock.txt" if sys.platform.startswith("linux") else ".lock.txt")
    )
    config_files = tracked + [
        p for p in (env_dir / "requirements.lock", platform_lock)
        if p.is_file()
    ]
    code_entries: list[tuple[str, str]] = []
    for path in set(config_files):
        if not path.is_file():
            continue
        try:
            label = f"environment/{env_name}/{path.relative_to(env_dir).as_posix()}"
        except ValueError:
            try:
                label = path.relative_to(REPO_ROOT).as_posix()
            except ValueError:
                label = f"external/{path.name}"
        code_entries.append((label, hash_file(path)))
    code_hash = "".join(f"{label}:{digest};" for label, digest in sorted(code_entries))
    runtime = {
        "system": platform.system(),
        "machine": platform.machine().lower(),
        "python": sys.version.split()[0],
        "implementation": sys.implementation.name,
        "cache_tag": sys.implementation.cache_tag,
    }
    return hash_bytes(canonical_json({"model": key, "config": config, "source": source_id,
                                      "code": code_hash, "runtime": runtime}))


def portable_identity(
    source_identity: dict[str, Any],
    fingerprints: dict[str, str],
    environments: dict[str, dict[str, Any]],
) -> dict[str, Any]:
    """Return root-independent identity shared by runner and Colab snapshots."""
    env_records: dict[str, Any] = {}
    for name, identity in sorted(environments.items()):
        manifest = identity.get("manifest", {})
        runtime = manifest.get("runtime", {})
        model = manifest.get("model", {})
        files = model.get("files", {}) if isinstance(model, dict) else {}
        env_records[name] = {
            "status": manifest.get("status"),
            "python_version": manifest.get("python_version"),
            "lock_sha256": manifest.get("lock_sha256"),
            "runtime": {
                key: runtime.get(key)
                for key in ("system", "machine", "python_version", "implementation", "cache_tag", "torch_version", "torch_cuda", "pip_version")
                if key in runtime
            },
            "model": {
                "repo_id": model.get("repo_id"),
                "revision": model.get("revision"),
                "files": {filename: record.get("sha256") for filename, record in sorted(files.items())},
            } if model else None,
        }
    return {
        "schema": 1,
        "platform": {
            "system": platform.system(),
            "machine": platform.machine().lower(),
            "python_version": sys.version.split()[0],
            "implementation": sys.implementation.name,
            "cache_tag": sys.implementation.cache_tag,
        },
        "source_identity": source_identity,
        "fingerprints": dict(sorted(fingerprints.items())),
        "environments": env_records,
    }
