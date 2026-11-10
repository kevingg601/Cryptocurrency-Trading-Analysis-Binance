"""Prepare isolated, pinned environments and model snapshots for the benchmark."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import subprocess
import sys
import time
from pathlib import Path
from typing import Any

os.environ["MPLBACKEND"] = "Agg"

from . import config
from .common import exclusive_lock

PROJECT_ROOT = config.REPO_ROOT
BENCHMARK_ROOT = Path(__file__).resolve().parent
ENV_ROOT = config.ENV_ROOT
CACHE_ROOT = config.CACHE_ROOT
TMP_ROOT = config.TMP_ROOT
ASSET_LOCK = BENCHMARK_ROOT / "model-assets.lock.json"
ENV_REQUIREMENTS = {
    "rank": BENCHMARK_ROOT / "requirements-rank.txt",
    "chronos": BENCHMARK_ROOT / "requirements-chronos.txt",
    "timesfm": BENCHMARK_ROOT / "requirements-timesfm.txt",
}
ENV_LOCKS = {
    "rank": BENCHMARK_ROOT / "requirements-rank.lock.txt",
    "chronos": BENCHMARK_ROOT / "requirements-chronos.lock.txt",
    "timesfm": BENCHMARK_ROOT / "requirements-timesfm.lock.txt",
}
LINUX_ENV_LOCKS = {
    "rank": BENCHMARK_ROOT / "requirements-rank.linux.lock.txt",
    "chronos": BENCHMARK_ROOT / "requirements-chronos.linux.lock.txt",
    "timesfm": BENCHMARK_ROOT / "requirements-timesfm.linux.lock.txt",
}


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _python_path(name: str) -> Path:
    if sys.platform.startswith("win"):
        return ENV_ROOT / name / "Scripts" / "python.exe"
    return ENV_ROOT / name / "bin" / "python"


def _runtime_info(python: Path, *, require_torch: bool = False) -> dict[str, Any]:
    script = "\n".join([
        "import importlib.metadata as md, json, platform, sys",
        "try:",
        "    import torch",
        "    tv, tc = torch.__version__, torch.version.cuda",
        "except ImportError:",
        "    tv = tc = None",
        "print(json.dumps({'python_version': sys.version.split()[0],",
        "    'implementation': sys.implementation.name, 'cache_tag': sys.implementation.cache_tag,",
        "    'system': platform.system(), 'machine': platform.machine().lower(),",
        "    'torch_version': tv, 'torch_cuda': tc, 'pip_version': md.version('pip')}))",
    ])
    result = subprocess.run([str(python), "-c", script], check=True, capture_output=True,
                            text=True, encoding="utf-8")
    runtime = json.loads(result.stdout.strip().splitlines()[-1])
    if require_torch and not runtime.get("torch_version"):
        raise RuntimeError("torch is required in Chronos/TimesFM isolated environments")
    if not str(runtime.get("python_version", "")).startswith("3.12."):
        raise RuntimeError(f"benchmark environments require Python 3.12.x, got {runtime.get('python_version')}")
    runtime["platform"] = platform.platform()
    return runtime


def _write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = path.with_suffix(path.suffix + ".tmp")
    temp_path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    temp_path.replace(path)


def _portable_path(path: Path) -> str:
    try:
        return path.resolve().relative_to(PROJECT_ROOT.resolve()).as_posix()
    except ValueError:
        return path.name


def _prepare_wheels(name: str, lock: Path, env: dict[str, str]) -> Path:
    """Resolve/download once, then install the exact saved wheel set offline."""
    directory = CACHE_ROOT / "wheels" / f"{name}-{_sha256(lock)[:16]}"
    marker = directory / "wheel-manifest.json"
    if marker.is_file():
        saved = json.loads(marker.read_text(encoding="utf-8"))
        records = saved.get("files", {})
        if saved.get("lock_sha256") == _sha256(lock) and records and all(
            Path(filename).name == filename and filename.endswith(".whl") and
            (directory / filename).is_file() and _sha256(directory / filename) == digest
            for filename, digest in records.items()
        ):
            print(f"Verified wheel cache: {name}; no package downloads", flush=True)
            return directory
    directory.mkdir(parents=True, exist_ok=True)
    command = [sys.executable, "-m", "pip", "download", "--disable-pip-version-check",
               "--only-binary=:all:", "--dest", str(directory), "-r", str(lock), "pip==25.1.1"]
    for attempt in range(3):
        try:
            subprocess.run(command, cwd=PROJECT_ROOT, env=env, check=True)
            break
        except subprocess.CalledProcessError:
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)
    records = {path.name: _sha256(path) for path in directory.glob("*.whl")}
    if not records:
        raise RuntimeError("download did not produce wheel files")
    _write_json(marker, {"lock_sha256": _sha256(lock), "files": records})
    return directory


def _prepare_env(name: str, *, force: bool = False) -> dict[str, Any]:
    env_dir = ENV_ROOT / name
    python = _python_path(name)
    requirement = ENV_REQUIREMENTS[name]
    lock = LINUX_ENV_LOCKS[name] if sys.platform.startswith("linux") else ENV_LOCKS[name]
    result: dict[str, Any] = {
        "name": name,
        "python": python.relative_to(ENV_ROOT).as_posix(),
        "requirements": _portable_path(requirement),
        "lock": _portable_path(lock),
        "status": "failed",
    }
    try:
        task_tmp = TMP_ROOT
        task_tmp.mkdir(parents=True, exist_ok=True)
        env = os.environ.copy()
        env["TEMP"] = str(task_tmp)
        env["TMP"] = str(task_tmp)
        if not python.exists():
            env_dir.parent.mkdir(parents=True, exist_ok=True)
            create_args = [sys.executable, "-m", "venv"]
            if sys.platform.startswith("linux"):
                create_args.append("--without-pip")
            create_args.append(str(env_dir))
            subprocess.run(create_args, check=True, env=env)
        if not python.exists():
            raise RuntimeError(f"隔離環境未建立 Python：{python}")

        if not lock.is_file():
            raise FileNotFoundError(f"預先解析的精確環境鎖檔不存在：{lock}")
        install_file = lock
        env["HF_HOME"] = str(CACHE_ROOT / "hf")
        env["HF_HUB_CACHE"] = str(CACHE_ROOT / "hf" / "hub")
        env["PIP_CACHE_DIR"] = str(CACHE_ROOT / "pip")
        env["TORCH_HOME"] = str(CACHE_ROOT / "torch")
        env["CUDA_CACHE_PATH"] = str(CACHE_ROOT / "cuda")
        env["HF_HUB_DISABLE_TELEMETRY"] = "1"
        env["PYTHONUTF8"] = "1"
        if sys.platform.startswith("linux"):
            wheels = _prepare_wheels(name, lock, env)
            offline = ["--no-index", "--find-links", str(wheels)]
            # Seed pip from the already working interpreter; hosted runtimes
            # sometimes omit ensurepip from their Python 3.12 installation.
            subprocess.run([sys.executable, "-m", "pip", "--python", str(python),
                            "install", "--disable-pip-version-check", *offline, "pip==25.1.1"],
                           cwd=PROJECT_ROOT, env=env, check=True)
            pip_cmd = [sys.executable, "-m", "pip", "--python", str(python),
                       "install", "--disable-pip-version-check", *offline]
        else:
            pip_cmd = [str(python), "-m", "pip", "install", "--disable-pip-version-check"]
        if name in {"chronos", "timesfm"}:
            pip_cmd.extend(["--extra-index-url", "https://download.pytorch.org/whl/cu126"])
        pip_cmd.extend(["-r", str(install_file)])
        last_error = None
        for attempt in range(1, 4):
            try:
                subprocess.run(pip_cmd, cwd=PROJECT_ROOT, env=env, check=True)
                last_error = None
                break
            except subprocess.CalledProcessError as exc:
                last_error = exc
                if attempt < 3:
                    time.sleep(min(2 ** (attempt - 1), 8))
        if last_error is not None:
            raise last_error
        runtime = _runtime_info(python, require_torch=name in {"chronos", "timesfm"})
        version = f"Python {runtime['python_version']}"
        env_lock = env_dir / "requirements.lock"
        env_lock.write_bytes(lock.read_bytes())
        result.update(status="ready", python_version=version, runtime=runtime,
                      platform=runtime["system"].lower(), lock_sha256=_sha256(lock))
    except Exception as exc:  # preserve each environment result and continue other models
        result["error"] = f"{type(exc).__name__}: {exc}"
    _write_json(env_dir / "environment-manifest.json", result)
    return result


def _download_models(*, retries: int = 3) -> dict[str, Any]:
    try:
        from huggingface_hub import hf_hub_download
    except Exception as exc:
        return {"status": "failed", "error": f"huggingface_hub import failed: {exc}"}

    lock = json.loads(ASSET_LOCK.read_text(encoding="utf-8"))
    model_results: dict[str, Any] = {}
    for key, model in lock["models"].items():
        selected = os.environ.get("FADACHI_MODEL_BENCHMARK_MODELS", ",".join(config.MODEL_KEYS)).split(",")
        if key not in selected:
            continue
        model_dir = CACHE_ROOT / "models" / key
        model_dir.mkdir(parents=True, exist_ok=True)
        files: dict[str, Any] = {}
        for filename, expected_hash in model["files"].items():
            target = model_dir / filename
            if target.is_file() and not target.is_symlink() and _sha256(target).lower() == expected_hash.lower():
                files[filename] = {"status": "ready", "path": str(target), "sha256": expected_hash}
                continue
            error = None
            for attempt in range(1, retries + 1):
                try:
                    source = Path(
                        hf_hub_download(
                            repo_id=model["repo_id"],
                            filename=filename,
                            revision=model["revision"],
                            cache_dir=str(CACHE_ROOT / "hf"),
                            local_dir=str(model_dir),
                            force_download=False,
                        )
                    )
                    actual_hash = _sha256(source)
                    if actual_hash.lower() != expected_hash.lower():
                        raise ValueError(f"SHA-256 mismatch for {filename}: expected {expected_hash}, got {actual_hash}")
                    target = source
                    files[filename] = {"status": "ready", "path": str(target), "sha256": actual_hash}
                    error = None
                    break
                except Exception as exc:
                    error = f"{type(exc).__name__}: {exc}"
                    if attempt < retries:
                        time.sleep(min(2 ** (attempt - 1), 8))
            if error:
                files[filename] = {"status": "failed", "error": error}
        status = "ready" if all(v["status"] == "ready" for v in files.values()) else "failed"
        model_results[key] = {
            "status": status,
            "repo_id": model["repo_id"],
            "revision": model["revision"],
            "files": files,
            "local_dir": str(model_dir),
        }
    return {"status": "ready" if all(m["status"] == "ready" for m in model_results.values()) else "partial", "models": model_results}


def prepare(*, force: bool = False, manifest_path: Path | None = None) -> dict[str, Any]:
    owner_lock = config.RUNS_ROOT.parent / ".benchmark-owner.lock"
    with exclusive_lock(owner_lock):
        return _prepare_locked(force=force, manifest_path=manifest_path)


def _prepare_locked(*, force: bool = False, manifest_path: Path | None = None) -> dict[str, Any]:
    from .registry import get_spec
    selected = os.environ.get("FADACHI_MODEL_BENCHMARK_MODELS", ",".join(config.MODEL_KEYS)).split(",")
    if not selected or len(set(selected)) != len(selected):
        raise ValueError("invalid model selection")
    required_envs = {"rank", *(get_spec(key).environment for key in selected)}
    ENV_ROOT.mkdir(parents=True, exist_ok=True)
    CACHE_ROOT.mkdir(parents=True, exist_ok=True)
    env_results: dict[str, Any] = {}
    # One setup failure must not prevent setup attempts for later environments.
    for name in ("rank", "chronos", "timesfm"):
        if name in required_envs:
            env_results[name] = _prepare_env(name, force=force)
    # The rank env owns the shared Hugging Face downloader dependency too, but
    # asset preparation only runs once one of the TS envs has the library.
    downloader = next((n for n in ("chronos", "timesfm") if env_results.get(n, {}).get("status") == "ready"), None)
    if downloader:
        python = _python_path(downloader)
        # Download via the environment interpreter to honor its exact hub version.
        helper = subprocess.run(
            [str(python), "-c", "from research.model_benchmark.bootstrap import _download_models; import json; print(json.dumps(_download_models()))"],
            cwd=PROJECT_ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            env={**os.environ, "HF_HOME": str(CACHE_ROOT / "hf"), "HF_HUB_CACHE": str(CACHE_ROOT / "hf" / "hub")},
        )
        if helper.returncode == 0:
            try:
                asset_results = json.loads(helper.stdout.strip().splitlines()[-1])
            except Exception as exc:
                asset_results = {"status": "failed", "error": f"Invalid download status JSON: {exc}", "stdout": helper.stdout[-2000:]}
        else:
            asset_results = {"status": "failed", "error": helper.stderr[-3000:]}
    else:
        asset_results = ({"status": "ready", "models": {}} if required_envs == {"rank"} else
                         {"status": "failed", "error": "No TimesFM/Chronos environment is ready to download assets."})

    for key in ("chronos2", "timesfm25"):
        if key not in selected:
            continue
        env_name = "chronos" if key == "chronos2" else "timesfm"
        manifest = {
            **env_results[env_name],
            "model": asset_results.get("models", {}).get(key, {"status": "not_downloaded"}),
        }
        _write_json(ENV_ROOT / env_name / "environment-manifest.json", manifest)
        model = manifest["model"]
        _write_json(
            ENV_ROOT / env_name / "model-revision.json",
            {
                "repo_id": model.get("repo_id"), "revision": model.get("revision"),
                "status": model.get("status"),
                "files": {filename: {"status": record.get("status"), "sha256": record.get("sha256")}
                          for filename, record in sorted(model.get("files", {}).items())},
            },
        )
    result: dict[str, Any] = {
        "status": "ready" if all(e["status"] == "ready" for e in env_results.values()) and asset_results["status"] == "ready" else "partial",
        "environments": env_results,
        "assets": asset_results,
    }
    if manifest_path:
        _write_json(manifest_path, result)
    return result


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prepare", action="store_true", help="prepare all isolated environments and pinned model snapshots")
    parser.add_argument("--manifest", type=Path, help="write the combined status JSON to this path")
    parser.add_argument("--force", action="store_true", help="reserved; environment locks remain immutable")
    args = parser.parse_args()
    if not args.prepare:
        parser.error("specify --prepare")
    if sys.version_info[:2] != (3, 12):
        parser.error(f"benchmark bootstrap requires Python 3.12.x; current runtime is {sys.version.split()[0]}")
    requested_python = os.environ.get("FADACHI_MODEL_BENCHMARK_PYTHON")
    if requested_python and Path(requested_python).resolve() != Path(sys.executable).resolve():
        parser.error(
            "bootstrap must run with FADACHI_MODEL_BENCHMARK_PYTHON; "
            f"requested {requested_python}, current interpreter is {sys.executable}"
        )
    result = prepare(force=args.force, manifest_path=args.manifest)
    print(json.dumps(result, indent=2, ensure_ascii=False))
    return 0 if result["status"] == "ready" else 2


if __name__ == "__main__":
    raise SystemExit(main())
