"""
Isolated live Chronos-2 LoRA inference entrypoint executed inside the `chronos` venv.
Strictly requires CUDA GPU when `requireCuda` is true (never falls back to CPU),
verifies adapter and pinned base model hashes before every run, and outputs a
single JSON status line on stdout while redirecting all other logs to stderr.
"""
from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import math
import os
import sys
import time
import traceback
import uuid
from pathlib import Path, PurePosixPath
from typing import Any

import numpy as np
import pandas as pd

from .features_and_labels import ONE_HOUR_MS, validate_and_deduplicate_1h

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


class CudaUnavailableError(RuntimeError):
    """Raised when CUDA is unavailable and CPU fallback is forbidden."""


class AdapterVerificationError(ValueError):
    """Raised when adapter manifest, files, or base revision fail verification."""


def _emit(payload: dict[str, Any]) -> None:
    _PROTOCOL_STDOUT.write(json.dumps(payload, ensure_ascii=False) + "\n")
    _PROTOCOL_STDOUT.flush()


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def _atomic_write_json(target_path: Path, data: dict[str, Any]) -> None:
    target_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = target_path.parent / f".{target_path.name}.{uuid.uuid4().hex}.tmp"
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp_path, target_path)


def _rebase_attempt_dir(adapter_run_dir: Path, raw_attempt_dir: str) -> Path:
    run_root = adapter_run_dir.resolve()
    portable = PurePosixPath(str(raw_attempt_dir).replace("\\", "/"))
    raw = Path(*portable.parts) if portable.parts else Path(".")
    if portable.is_absolute() or raw.is_absolute() or (portable.parts and portable.parts[0].endswith(":")):
        parts = portable.parts
        if run_root.name not in parts:
            raise AdapterVerificationError(f"無法重定位 attempt_dir：{raw_attempt_dir}")
        idx = len(parts) - 1 - parts[::-1].index(run_root.name)
        raw = Path(*parts[idx + 1 :])
    resolved = (run_root / raw).resolve()
    try:
        resolved.relative_to(run_root)
    except ValueError as exc:
        raise AdapterVerificationError(f"attempt_dir 越出 run 目錄範圍：{raw_attempt_dir}") from exc
    if resolved == run_root or not resolved.is_dir():
        raise AdapterVerificationError(f"attempt_dir 不存在或無效：{resolved}")
    return resolved


def _verify_rolling_current_adapter(
    current_json_path: Path,
    *,
    expected_version_id: str | None = None,
    expected_adapter_sha256: str | None = None,
    expected_base_revision: str | None = None,
) -> tuple[Path, dict[str, str], dict[str, Any], dict[str, Any]]:
    from .chronos2_train import verify_local_chronos_base_assets

    cur_path = current_json_path.resolve()
    if not cur_path.is_file():
        raise AdapterVerificationError(f"找不到本機 Chronos-2 滾動權重指標：{cur_path}")

    current_doc = json.loads(cur_path.read_text(encoding="utf-8"))
    version_id = str(current_doc.get("versionId") or "")
    if not version_id or "/" in version_id or "\\" in version_id or ".." in version_id:
        raise AdapterVerificationError(f"Chronos-2 versionId 不合法：{version_id}")
    if expected_version_id and version_id != expected_version_id:
        raise AdapterVerificationError(f"Chronos-2 版本不符：預期 {expected_version_id}，實際 {version_id}")

    chronos_root = cur_path.parent.resolve()
    version_dir = (chronos_root / "versions" / version_id).resolve()
    try:
        version_dir.relative_to(chronos_root)
    except ValueError as exc:
        raise AdapterVerificationError(f"Chronos-2 版本路徑越界：{version_dir}") from exc

    attempt_dir = (version_dir / "attempt").resolve()
    adapter_dir = (attempt_dir / "adapter").resolve()
    inner_sha_path = adapter_dir / "adapter.sha256.json"
    if not adapter_dir.is_dir() or not inner_sha_path.is_file():
        raise AdapterVerificationError(f"找不到 Chronos-2 adapter 目錄或雜湊清單：{adapter_dir}")

    inner_hashes = json.loads(inner_sha_path.read_text(encoding="utf-8"))
    if not isinstance(inner_hashes, dict) or "adapter_model.safetensors" not in inner_hashes or "adapter_config.json" not in inner_hashes:
        raise AdapterVerificationError("adapter.sha256.json 缺少必要檔案雜湊")

    verified_hashes: dict[str, str] = {}
    for name, expected_hex in inner_hashes.items():
        fpath = (adapter_dir / name).resolve()
        try:
            fpath.relative_to(adapter_dir)
        except ValueError as exc:
            raise AdapterVerificationError(f"adapter 檔案路徑越界：{name}") from exc
        if fpath.is_symlink() or not fpath.is_file():
            raise AdapterVerificationError(f"缺少 Chronos-2 adapter 檔案：{name}")
        actual_hex = _sha256_file(fpath).lower()
        if actual_hex != str(expected_hex).lower():
            raise AdapterVerificationError(f"Chronos-2 adapter 雜湊不符：{name}")
        verified_hashes[f"adapter/{name}"] = actual_hex

    if expected_adapter_sha256 and verified_hashes.get("adapter/adapter_model.safetensors") != str(expected_adapter_sha256).lower():
        raise AdapterVerificationError("Chronos-2 adapter_model.safetensors 雜湊與預期不符")

    _, lock_info = verify_local_chronos_base_assets()
    lock_rev = str(lock_info.get("revision") or "")
    if expected_base_revision and lock_rev != str(expected_base_revision):
        raise AdapterVerificationError(f"基礎模型 revision 不符：預期 {expected_base_revision}，鎖定 {lock_rev}")

    return adapter_dir, verified_hashes, lock_info, current_doc


def _verify_adapter_and_base(
    adapter_run_dir: Path,
    expected_adapter_hashes: dict[str, str],
    expected_base_revision: str,
) -> tuple[Path, dict[str, str], dict[str, Any]]:
    from research.model_benchmark.ts_adapters import _read_asset_lock, _verify_adapter_hashes

    run_dir = adapter_run_dir.resolve()
    manifest_path = run_dir / "run_manifest.json"
    if not manifest_path.is_file():
        raise AdapterVerificationError(f"找不到 run_manifest.json：{manifest_path}")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    saved = manifest.get("models", {}).get("chronos2")
    if not isinstance(saved, dict) or saved.get("status") != "SUCCESS":
        raise AdapterVerificationError("run_manifest.json 中 models.chronos2 狀態非 SUCCESS")

    attempt_dir = _rebase_attempt_dir(run_dir, str(saved.get("attempt_dir") or ""))

    raw_manifest_hashes = saved.get("artifact_hashes")
    if not isinstance(raw_manifest_hashes, dict) or not raw_manifest_hashes:
        raise AdapterVerificationError("run_manifest.json 缺少 artifact_hashes")

    manifest_hashes = {
        str(k).replace("\\", "/"): str(v).lower() for k, v in raw_manifest_hashes.items()
    }
    expected_norm = {
        str(k).replace("\\", "/"): str(v).lower() for k, v in (expected_adapter_hashes or {}).items()
    }
    if not expected_norm:
        raise AdapterVerificationError("缺少 expectedAdapterHashes")

    if manifest_hashes != expected_norm:
        raise AdapterVerificationError("expectedAdapterHashes 與 run_manifest artifact_hashes 不一致")

    for rel_key, expected_digest in expected_norm.items():
        target = (attempt_dir / rel_key).resolve()
        try:
            target.relative_to(attempt_dir)
        except ValueError as exc:
            raise AdapterVerificationError(f"artifact 路徑不合法：{rel_key}") from exc
        if target.is_symlink() or not target.is_file():
            raise AdapterVerificationError(f"缺少或無效的 adapter 檔案：{rel_key}")
        actual_digest = _sha256_file(target).lower()
        if actual_digest != expected_digest:
            raise AdapterVerificationError(f"adapter 雜湊驗證失敗：{rel_key}")

    adapter_dir = attempt_dir / "adapter"
    try:
        _verify_adapter_hashes(adapter_dir)
    except (ValueError, FileNotFoundError) as exc:
        raise AdapterVerificationError(f"adapter.sha256.json 驗證失敗：{exc}") from exc

    lock_info = _read_asset_lock().get("models", {}).get("chronos2")
    if not isinstance(lock_info, dict):
        raise AdapterVerificationError("model-assets.lock.json 缺少 chronos2 設定")
    lock_revision = str(lock_info.get("revision") or "")
    if not expected_base_revision or lock_revision != str(expected_base_revision):
        raise AdapterVerificationError(
            f"基礎模型 revision 不符：預期 {expected_base_revision}，鎖定 {lock_revision}"
        )

    training_rev = saved.get("training", {}).get("revision")
    if training_rev and str(training_rev) != lock_revision:
        raise AdapterVerificationError(
            f"Adapter 訓練基礎模型 revision ({training_rev}) 與鎖定 ({lock_revision}) 不符"
        )

    return adapter_dir, expected_norm, lock_info


def _extract_256_closes(df_1h: pd.DataFrame, symbol: str, decision_open_time: int) -> np.ndarray | None:
    start_open = int(decision_open_time) - 255 * ONE_HOUR_MS
    sub = df_1h[
        (df_1h["symbol"] == symbol)
        & (df_1h["open_time"] >= start_open)
        & (df_1h["open_time"] <= int(decision_open_time))
    ].sort_values("open_time")
    if len(sub) != 256:
        return None
    times = sub["open_time"].to_numpy(dtype=np.int64)
    if int(times[0]) != start_open or int(times[-1]) != int(decision_open_time):
        return None
    if not np.all(np.diff(times) == ONE_HOUR_MS):
        return None
    closes = sub["close"].to_numpy(dtype=np.float32)
    if not np.all(np.isfinite(closes)) or np.any(closes <= 0):
        return None
    return closes


def _load_klines_for_live(
    base_parquet_path: Path,
    klines_csv_path: Path | None,
    symbols: list[str],
    decision_open_time: int,
) -> pd.DataFrame:
    if not base_parquet_path.is_file():
        raise FileNotFoundError(f"找不到基礎 K 線檔：{base_parquet_path}")

    df_1h = pd.read_parquet(base_parquet_path)
    if list(df_1h.columns) != EXPECTED_KLINES_COLUMNS:
        raise ValueError(f"baseKlinesParquet 欄位與常數不一致：{list(df_1h.columns)}")

    if klines_csv_path is not None and klines_csv_path.is_file():
        extra_df = pd.read_csv(klines_csv_path)
        if list(extra_df.columns) != EXPECTED_KLINES_COLUMNS:
            raise ValueError(f"klinesCsv 欄位與常數不一致：{list(extra_df.columns)}")
        if not extra_df.empty:
            if extra_df["is_final"].dtype == object:
                extra_df["is_final"] = (
                    extra_df["is_final"].astype(str).str.strip().str.lower().isin(("true", "1"))
                )
            else:
                extra_df["is_final"] = extra_df["is_final"].astype(bool)
            df_1h = pd.concat([df_1h, extra_df], ignore_index=True)

    symbol_set = set(symbols)
    if symbol_set:
        df_1h = df_1h[df_1h["symbol"].astype(str).isin(symbol_set)].copy()

    cutoff_ms = int(decision_open_time) + ONE_HOUR_MS
    clean_df, _ = validate_and_deduplicate_1h(df_1h, cutoff_ms=cutoff_ms)
    return clean_df


def run_chronos2_live(req: dict[str, Any], output_path: Path) -> dict[str, Any]:
    import torch
    from research.model_benchmark.ts_adapters import _base_model, _prediction_mean

    require_cuda = bool(req.get("requireCuda", True))
    if require_cuda and not torch.cuda.is_available():
        raise CudaUnavailableError("CUDA GPU 不可用；Chronos-2 即時推論必須使用 GPU（不退回 CPU）")

    device = "cuda" if torch.cuda.is_available() else "cpu"

    expected_base_revision = str(req.get("expectedBaseRevision") or "")
    decision_open_time = int(req["decisionOpenTime"])
    symbols = list(dict.fromkeys(str(s).strip().upper() for s in (req.get("symbols") or []) if str(s).strip()))
    base_parquet = Path(str(req.get("liveKlinesParquet") or req["baseKlinesParquet"]))
    klines_csv = Path(str(req["klinesCsv"])) if req.get("klinesCsv") else None

    rolling_meta: dict[str, Any] = {}
    if req.get("liveChronosCurrentJson"):
        adapter_dir, verified_hashes, lock_info, rolling_meta = _verify_rolling_current_adapter(
            Path(str(req["liveChronosCurrentJson"])),
            expected_version_id=req.get("expectedVersionId"),
            expected_adapter_sha256=req.get("expectedAdapterSha256"),
            expected_base_revision=expected_base_revision or None,
        )
        adapter_run_dir = Path(str(rolling_meta.get("versionDir") or adapter_dir.parent.parent))
    else:
        adapter_run_dir = Path(str(req["adapterRunDir"]))
        expected_adapter_hashes = req.get("expectedAdapterHashes") or {}
        adapter_dir, verified_hashes, lock_info = _verify_adapter_and_base(
            adapter_run_dir=adapter_run_dir,
            expected_adapter_hashes=expected_adapter_hashes,
            expected_base_revision=expected_base_revision,
        )

    clean_df = _load_klines_for_live(
        base_parquet_path=base_parquet,
        klines_csv_path=klines_csv,
        symbols=symbols,
        decision_open_time=decision_open_time,
    )

    contexts: list[np.ndarray] = []
    ready_symbols: list[str] = []
    skipped: list[dict[str, str]] = []

    for sym in symbols:
        ctx = _extract_256_closes(clean_df, sym, decision_open_time)
        if ctx is None:
            skipped.append({"symbol": sym, "reason": "連續 256 根已收盤 1h 資料不足或存在缺口"})
        else:
            ready_symbols.append(sym)
            contexts.append(ctx)

    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

    started = time.perf_counter()
    forecasts: dict[str, dict[str, Any]] = {}

    if contexts:
        from peft import PeftModel

        torch.manual_seed(42)
        base = _base_model("chronos2", device)
        model = PeftModel.from_pretrained(base, adapter_dir, is_trainable=False).to(
            device=device, dtype=torch.float32
        )
        model.eval()
        preds = _prediction_mean("chronos2", model, contexts, device)
        if len(preds) != len(ready_symbols):
            raise ValueError("Chronos-2 回傳預測筆數與輸入標的數不符")

        for sym, ctx, row in zip(ready_symbols, contexts, preds, strict=True):
            path_vals = [float(x) for x in row[:4]]
            if len(path_vals) != 4 or any(not math.isfinite(v) or v <= 0 for v in path_vals):
                raise ValueError(f"Chronos-2 針對 {sym} 產生無效預測值：{path_vals}")
            forecasts[sym] = {
                "symbol": sym,
                "lastClose": float(ctx[-1]),
                "predictedClose4h": float(path_vals[3]),
                "predictedPath": path_vals,
            }

    elapsed_ms = round((time.perf_counter() - started) * 1000.0, 2)
    gpu_name = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None

    result_doc: dict[str, Any] = {
        "decisionOpenTime": decision_open_time,
        "forecasts": forecasts,
        "skipped": skipped,
        "modelInfo": {
            "mode": "local-rolling" if rolling_meta else "adapter-run",
            "versionId": rolling_meta.get("versionId"),
            "trainedAt": rolling_meta.get("trainedAt"),
            "valReturnMae": rolling_meta.get("valReturnMae"),
            "adapterRunDir": str(adapter_run_dir.resolve()),
            "adapterDir": str(adapter_dir),
            "adapterHashes": verified_hashes,
            "baseRepoId": str(lock_info.get("repo_id") or "amazon/chronos-2"),
            "baseRevision": str(lock_info.get("revision") or expected_base_revision),
            "torchVersion": str(torch.__version__),
            "cudaAvailable": bool(torch.cuda.is_available()),
            "cudaVersion": torch.version.cuda,
            "gpuName": gpu_name,
        },
        "elapsedMs": elapsed_ms,
    }

    _atomic_write_json(output_path, result_doc)
    return result_doc


def main(argv: list[str] | None = None) -> int:
    global _PROTOCOL_STDOUT
    _PROTOCOL_STDOUT = sys.stdout
    sys.stdout = sys.stderr

    parser = argparse.ArgumentParser(description="Live Chronos-2 LoRA inference")
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args(argv)

    try:
        req = json.loads(args.request.read_text(encoding="utf-8"))
        if not isinstance(req, dict):
            raise ValueError("request 檔案必須為 JSON object")
        with contextlib.redirect_stdout(sys.stderr):
            res = run_chronos2_live(req, args.output.resolve())
        _emit({"event": "result", "data": res})
        return 0
    except CudaUnavailableError as exc:
        sys.stderr.write(traceback.format_exc() + "\n")
        _emit({"event": "error", "errorCode": "CUDA_UNAVAILABLE", "message": str(exc)})
        return 3
    except AdapterVerificationError as exc:
        sys.stderr.write(traceback.format_exc() + "\n")
        _emit({"event": "error", "errorCode": "ADAPTER_VERIFICATION_FAILED", "message": str(exc)})
        return 2
    except FileNotFoundError as exc:
        sys.stderr.write(traceback.format_exc() + "\n")
        _emit({"event": "error", "errorCode": "MODEL_OR_DATA_MISSING", "message": str(exc)})
        return 2
    except Exception as exc:
        sys.stderr.write(traceback.format_exc() + "\n")
        _emit({"event": "error", "errorCode": "CHRONOS_LIVE_ERROR", "message": str(exc)})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
