"""Lazy model adapter registry; keep incompatible ML environments isolated."""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable


@dataclass(frozen=True)
class ModelSpec:
    key: str
    family: str
    environment: str
    module: str
    class_name: str
    requires_model_assets: bool = False


REGISTRY: dict[str, ModelSpec] = {
    "catboost": ModelSpec("catboost", "rank", "rank", "research.model_benchmark.rank_adapters", "RankAdapter"),
    "xgboost": ModelSpec("xgboost", "rank", "rank", "research.model_benchmark.rank_adapters", "RankAdapter"),
    "chronos2": ModelSpec("chronos2", "forecast", "chronos", "research.model_benchmark.ts_adapters", "TsAdapter", True),
    "timesfm25": ModelSpec("timesfm25", "forecast", "timesfm", "research.model_benchmark.ts_adapters", "TsAdapter", True),
}


def get_spec(key: str) -> ModelSpec:
    try:
        return REGISTRY[key]
    except KeyError as exc:
        raise ValueError(f"unknown model key {key!r}; registered: {', '.join(REGISTRY)}") from exc


def load_adapter(key: str) -> Any:
    spec = get_spec(key)
    import importlib
    module = importlib.import_module(spec.module)
    cls: Callable[[str], Any] = getattr(module, spec.class_name)
    return cls(key)
