"""Generate the portable, output-free Colab benchmark notebook."""
from __future__ import annotations

import argparse
import json
import secrets
from pathlib import Path


def markdown(source: str) -> dict:
    return {"cell_type": "markdown", "id": secrets.token_hex(4), "metadata": {}, "source": source.splitlines(keepends=True)}


def code(source: str) -> dict:
    return {
        "cell_type": "code",
        "execution_count": None,
        "id": secrets.token_hex(4),
        "metadata": {},
        "outputs": [],
        "source": source.splitlines(keepends=True),
    }


def build_notebook() -> dict:
    cells = [
        markdown("""# 四模型選幣與 K 線預測（Colab T4／CUDA）

本 Notebook 透過既有 runner 依序訓練 CatBoost、XGBoost、Chronos-2、TimesFM 2.5，最後輸出比較報告。資料、切分、超參數及評估維持專案 v3 規格。

在 VS Code 連接 Colab 遠端 kernel 執行，支援 kernel Python 3.12／3.13（包含 3.13.16），不必切換 Colab 網站 runtime。訓練仍以資料包內固定並驗證 SHA256 的獨立 CPython 3.12.12 建立原有三個鎖定環境。GPU 分配及 session 長度由 Google 管理，無法保證每次取得 A100 或單次完成全部訓練。

預設 `MODE = "full"` 直接執行正式訓練，不會額外先跑 smoke。若要在正式訓練前另跑四模型 smoke，設定 `RUN_SMOKE_BEFORE_FULL = True`。`MODE = "smoke"` 仍只執行 smoke，其 `PARTIAL / SMOKE_ONLY` 狀態不是正式比較結果。

中斷恢復只沿用完整、已提交且身份吻合的模型／候選／checkpoint。尚未完成的時序微調可能從新 attempt 重跑，不能宣稱逐 optimizer step 恢復。CUDA OOM 後依原計畫允許 CPU 新 attempt，輸出會標明實際裝置。
"""),
        markdown("## 1. 設定與連接 Drive\n\n將新版 ZIP 放在遠端 `/content` 或 Google Drive，並設定檔案路徑。Drive 未掛載時，在 VS Code 使用 `Ctrl+Shift+P` → `Colab: Mount Google Drive to Server...`。若要恢復正式 run，填入此前輸出的 `RESTORE_SESSION_ID` 與 `RESTORE_RUN_ID`。"""),
        code("""from pathlib import Path

BUNDLE_ZIP_PATH = "/content/fadachi-colab-bundle.zip"
DRIVE_OUTPUT_DIR = "/content/drive/MyDrive/fadachi-model-benchmark/outputs"
MODE = "full"  # "smoke" or "full"
REQUIRE_A100 = False  # allow the assigned T4; CUDA remains required
RUN_SMOKE_BEFORE_FULL = False  # optional extra smoke before a full run
TRY_COLAB_DRIVE_MOUNT = False  # VS Code Colab users should mount Drive with the command palette.
RESTORE_SESSION_ID = None  # e.g. "a1b2c3d4e5f60718"
RESTORE_RUN_ID = None      # e.g. "colab-20261110T193000Z-a1b2c3d4"
RECOVERY_RUN_PATH = None   # optional smoke run directory when recovering after a kernel restart
RUN_RECOVERY = False       # enable only to inspect/recover a completed smoke run

if MODE not in {"smoke", "full"}:
    raise ValueError("MODE must be 'smoke' or 'full'.")
if (RESTORE_SESSION_ID is None) != (RESTORE_RUN_ID is None):
    raise ValueError("Set both RESTORE_SESSION_ID and RESTORE_RUN_ID to restore, or leave both None.")

MY_DRIVE = Path("/content/drive/MyDrive")
if MY_DRIVE.is_dir():
    print(f"Google Drive 已掛載：{MY_DRIVE}", flush=True)
elif TRY_COLAB_DRIVE_MOUNT:
    from google.colab import drive
    drive.mount("/content/drive", timeout_ms=60000)
    if not MY_DRIVE.is_dir():
        raise RuntimeError("Drive 掛載逾時或 MyDrive 不存在；請在 VS Code 使用 Colab: Mount Google Drive to Server...。")
else:
    raise RuntimeError(
        "Google Drive 尚未掛載。請在 VS Code 按 Ctrl+Shift+P，執行 "
        "'Colab: Mount Google Drive to Server...'，再重跑此設定格。"
    )
"""),
        markdown("## 2. 核對 Colab 執行環境\n\nGPU 名稱及顯存會在此顯示。預設允許 T4，仍須通過實際 CUDA 運算檢查。"""),
        code("""import json
import platform
import shutil
import subprocess
import sys
import time

def run_bounded_gpu_probe(probe_code, timeout_seconds=90):
    started = time.monotonic()
    process = subprocess.Popen(
        [sys.executable, "-u", "-c", probe_code], stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, encoding="utf-8", errors="replace",
    )
    try:
        while process.poll() is None:
            elapsed = time.monotonic() - started
            if elapsed >= timeout_seconds:
                process.kill()
                stdout, stderr = process.communicate()
                raise RuntimeError(
                    f"CUDA probe timed out after {timeout_seconds}s. Colab runtime/driver may be unavailable. "
                    f"stdout={stdout[-1000:]!r}; stderr={stderr[-1000:]!r}"
                )
            try:
                process.wait(timeout=min(5, timeout_seconds - elapsed))
            except subprocess.TimeoutExpired:
                print(f"CUDA 初始化仍在進行（已 {int(elapsed)} 秒）；上限 {timeout_seconds} 秒。", flush=True)
    except BaseException:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()
        process.communicate()
        raise
    stdout, stderr = process.communicate()
    if process.returncode != 0:
        raise RuntimeError(f"CUDA probe failed (exit {process.returncode}): {stderr[-2000:]}")
    lines = [line for line in stdout.splitlines() if line.strip()]
    if not lines:
        raise RuntimeError("CUDA probe returned no result.")
    try:
        return json.loads(lines[-1])
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"CUDA probe returned invalid JSON: {lines[-1]!r}") from exc

print("步驟 2/6：開始檢查 Colab runtime 與本機磁碟。", flush=True)
if platform.system() != "Linux" or sys.version_info[:2] not in {(3, 12), (3, 13)}:
    raise RuntimeError(f"需要 Linux／Python 3.12 或 3.13 Colab kernel；目前為 {platform.system()} / {sys.version.split()[0]}。")
content_free_bytes = shutil.disk_usage("/content").free
if content_free_bytes < 8 * 1024**3:
    raise RuntimeError("/content 至少需要 8 GiB 可用空間。")
print("步驟 2/6：以獨立子程序檢查 CUDA 初始化與實際 tensor 運算（最多 90 秒）。", flush=True)
CUDA_PROBE = r'''import json, torch
if not torch.cuda.is_available():
    raise RuntimeError("CUDA is unavailable")
name = torch.cuda.get_device_name(0)
props = torch.cuda.get_device_properties(0)
a = torch.ones((2, 2), device="cuda")
result = a @ a
torch.cuda.synchronize()
if not bool(torch.isfinite(result).all().item()):
    raise RuntimeError("CUDA tensor operation failed")
print(json.dumps({"gpu_name": name, "gpu_memory_bytes": props.total_memory, "cuda_version": torch.version.cuda, "cuda_tensor_op_passed": True}))
'''
GPU_INFO = run_bounded_gpu_probe(CUDA_PROBE, timeout_seconds=90)
GPU_NAME = GPU_INFO["gpu_name"]
if REQUIRE_A100 and "a100" not in GPU_NAME.casefold():
    raise RuntimeError(f"要求 A100，但目前分配到 {GPU_NAME}；未啟動訓練。")
RUNTIME = {
    "platform": platform.platform(), "kernel_python": sys.version,
    "gpu_name": GPU_NAME, "gpu_memory_bytes": GPU_INFO["gpu_memory_bytes"],
    "torch_cuda": GPU_INFO["cuda_version"], "cuda_tensor_op_passed": GPU_INFO["cuda_tensor_op_passed"],
    "content_free_bytes": content_free_bytes, "a100_verified": "a100" in GPU_NAME.casefold(),
}
print("Colab kernel GPU 預檢完成：", json.dumps(RUNTIME, indent=2, ensure_ascii=False), flush=True)
"""),
        markdown("## 3. 驗證並解開白名單資料包\n\n資料包含 v3 manifest／資料、LightGBM 基準與必要程式，不含虛擬環境、快取或憑證。程式先驗證清單及每個檔案的 SHA256，再解壓。"""),
        code("""import hashlib
import json
import os
import stat
import sys
import zipfile
from pathlib import Path, PurePosixPath

print("步驟 3/6：準備尋找、複製並驗證白名單資料包。", flush=True)
DRIVE_ROOT = Path(DRIVE_OUTPUT_DIR)
DRIVE_ROOT.mkdir(parents=True, exist_ok=True)
print(f"Drive 輸出位置已確認：{DRIVE_ROOT}", flush=True)

def copy_with_progress(source, destination, label):
    source, destination = Path(source), Path(destination)
    size = source.stat().st_size
    copied = 0
    destination.parent.mkdir(parents=True, exist_ok=True)
    with source.open("rb") as src, destination.open("wb") as dst:
        while True:
            chunk = src.read(4 * 1024 * 1024)
            if not chunk:
                break
            dst.write(chunk)
            copied += len(chunk)
            print(f"{label}：{copied}/{size} bytes", flush=True)
        dst.flush()
        os.fsync(dst.fileno())
    if copied != size:
        raise IOError(f"複製大小不符：{source} -> {destination}")

bundle_path = Path(BUNDLE_ZIP_PATH).expanduser() if BUNDLE_ZIP_PATH else None
if bundle_path is None:
    bundle_path = Path("/content/fadachi-colab-bundle.zip")
if not bundle_path.is_file():
    raise FileNotFoundError(
        f"找不到新版資料包：{bundle_path}。請先將新版 ZIP 放到遠端 /content 或 Drive，"
        "並在設定格將 BUNDLE_ZIP_PATH 指向它。舊版 ZIP 不含 managed Python 3.12.12 runtime，不能用於此 Notebook。"
    )
bundle_path = bundle_path.resolve()
def is_content_local_bundle(path, content_root="/content", drive_root="/content/drive"):
    resolved = Path(path).resolve()
    try:
        resolved.relative_to(Path(drive_root).resolve())
        return False
    except ValueError:
        pass
    try:
        resolved.relative_to(Path(content_root).resolve())
        return True
    except ValueError:
        return False

is_content_local = is_content_local_bundle(bundle_path)
if is_content_local:
    local_bundle_path = bundle_path
    print(f"ZIP 已在 /content：{local_bundle_path}", flush=True)
else:
    local_bundle_path = Path("/content") / f"fadachi-colab-input-{os.urandom(8).hex()}.zip"
    print(f"從 Drive 分塊複製 ZIP 到本機：{bundle_path}", flush=True)
    copy_with_progress(bundle_path, local_bundle_path, "Drive → /content")
bundle_path = local_bundle_path

def sha256_file(path, label):
    digest = hashlib.sha256()
    size = Path(path).stat().st_size
    read = 0
    with Path(path).open("rb") as source:
        while True:
            chunk = source.read(4 * 1024 * 1024)
            if not chunk:
                break
            digest.update(chunk)
            read += len(chunk)
            print(f"{label}：{read}/{size} bytes", flush=True)
    return digest.hexdigest()

def verify_bundle(path):
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        if len(names) != len(set(names)) or "fadachi_colab_bundle.json" not in names:
            raise ValueError("ZIP 缺少 manifest 或包含重複路徑。")
        manifest = json.loads(archive.read("fadachi_colab_bundle.json"))
        if manifest.get("schema") != 1 or not isinstance(manifest.get("files"), list):
            raise ValueError("不支援此資料包版本。")
        expected = {item["path"]: item for item in manifest["files"]}
        if len(expected) != len(manifest["files"]) or set(names) != set(expected) | {"fadachi_colab_bundle.json"}:
            raise ValueError("ZIP 成員與白名單不一致。")
        total_size = 0
        members = [info for info in archive.infolist() if info.filename != "fadachi_colab_bundle.json"]
        for index, info in enumerate(members, start=1):
            rel = PurePosixPath(info.filename)
            mode = info.external_attr >> 16
            if rel.is_absolute() or "\\\\" in info.filename or any(part in {"", ".", ".."} for part in rel.parts) or stat.S_ISLNK(mode):
                raise ValueError(f"不安全的 ZIP 路徑：{info.filename}")
            if info.file_size != expected[info.filename]["size"] or info.file_size > 128 * 1024 * 1024:
                raise ValueError(f"資料包檔案大小不符：{info.filename}")
            total_size += info.file_size
            if total_size > 512 * 1024 * 1024:
                raise ValueError("資料包總解壓大小超過上限。")
            if (info.file_size and info.compress_size == 0) or info.file_size > max(4 * 1024 * 1024, info.compress_size * 1000):
                raise ValueError(f"資料包壓縮比例異常：{info.filename}")
            digest = hashlib.sha256(archive.read(info.filename)).hexdigest()
            if digest != expected[info.filename]["sha256"]:
                raise ValueError(f"資料包 SHA256 不符：{info.filename}")
            print(f"ZIP 白名單 hash：{index}/{len(members)} {info.filename}", flush=True)
        return manifest

print("開始驗證本機 ZIP 的白名單與逐檔 SHA256。", flush=True)
BUNDLE_MANIFEST = verify_bundle(bundle_path)
required_bundle_files = {
    "research/model_benchmark/managed_python.py",
    "research/model_benchmark/python-runtime.lock.json",
}
manifest_files = {record["path"] for record in BUNDLE_MANIFEST["files"]}
if "managed-python-runtime-v1" not in BUNDLE_MANIFEST.get("features", []) or not required_bundle_files <= manifest_files:
    raise RuntimeError("這是舊版資料包或缺少 managed Python runtime；請換新版 fadachi-colab-bundle.zip。")
BUNDLE_SHA256 = sha256_file(bundle_path, "本機 ZIP SHA256")
bundle_store = DRIVE_ROOT.parent / "bundles"
bundle_store.mkdir(parents=True, exist_ok=True)
stored_bundle = bundle_store / f"bundle-{BUNDLE_SHA256[:16]}.zip"
if not stored_bundle.exists():
    uploading = stored_bundle.with_suffix(".zip.uploading")
    print(f"備份原始資料包至 Drive：{stored_bundle}", flush=True)
    copy_with_progress(bundle_path, uploading, "本機 → Drive")
    if sha256_file(uploading, "Drive 備份 SHA256") != BUNDLE_SHA256:
        uploading.unlink(missing_ok=True)
        raise IOError("資料包複製到 Drive 後 hash 不符。")
    os.replace(uploading, stored_bundle)
elif sha256_file(stored_bundle, "既有 Drive 備份 SHA256") != BUNDLE_SHA256:
    raise ValueError("Drive 上已存在同名資料包，但 hash 不符。")
else:
    print(f"Drive 已有相同 hash 的資料包：{stored_bundle}", flush=True)

WORK_ROOT = Path("/content") / f"fadachi-benchmark-{BUNDLE_SHA256[:12]}"
REPO_ROOT = WORK_ROOT / "repo"
SOURCE_ROOT = REPO_ROOT / "data-reruns/20261110-004810/model-research"
RUNS_ROOT = WORK_ROOT / "runs"
CACHE_ROOT = WORK_ROOT / "cache"
ENV_ROOT = WORK_ROOT / "envs"
TMP_ROOT = WORK_ROOT / "tmp"
RUNTIME.update(bundle_sha256=BUNDLE_SHA256, drive_bundle_copy=str(stored_bundle))

# Verify every archive member before importing any code from the supplied ZIP.
sys.path.insert(0, str(bundle_path))
from research.model_benchmark.bundle import extract_bundle
bundle_info = extract_bundle(bundle_path, REPO_ROOT)
while str(bundle_path) in sys.path:
    sys.path.remove(str(bundle_path))
for module_name in list(sys.modules):
    if module_name == "research" or module_name.startswith("research."):
        del sys.modules[module_name]
sys.path.insert(0, str(REPO_ROOT))
print(f"資料包驗證及解壓完成：{bundle_info['bundle_id']}；解壓至 {REPO_ROOT}", flush=True)
"""),
        markdown("## 4. 建立鎖定環境並下載固定權重\n\n環境、快取與訓練檔案留在 Colab 本機磁碟，避免直接在 Drive 上頻繁讀寫小檔。Notebook kernel 不會安裝或升級模型套件。"""),
        code("""import json
import os
import sys

from research.model_benchmark.colab import (
    make_colab_environment,
    prepare_environments,
    verify_torch_environments,
)
from research.model_benchmark.managed_python import prepare_managed_python

print("準備固定的隔離 Python 3.12.12 訓練執行器。", flush=True)
TRAINING_PYTHON_INFO = prepare_managed_python(
    WORK_ROOT / "managed-python",
    CACHE_ROOT / "python-runtime",
    progress=lambda message: print(message, flush=True),
)
TRAINING_PYTHON = Path(TRAINING_PYTHON_INFO["python"]).resolve()
ENV = make_colab_environment(REPO_ROOT, SOURCE_ROOT, RUNS_ROOT, CACHE_ROOT, ENV_ROOT, TMP_ROOT)
ENV["FADACHI_MODEL_BENCHMARK_PYTHON"] = str(TRAINING_PYTHON)
RUNTIME.update(
    kernel_python=sys.version.split()[0],
    training_python=TRAINING_PYTHON_INFO["python_version"],
    training_python_asset_sha256=TRAINING_PYTHON_INFO["asset_sha256"],
    training_python_path=str(TRAINING_PYTHON),
)
os.environ.update(ENV)
for directory in (RUNS_ROOT, CACHE_ROOT, ENV_ROOT, TMP_ROOT):
    directory.mkdir(parents=True, exist_ok=True)

BOOTSTRAP = prepare_environments(REPO_ROOT, ENV)
print(json.dumps(BOOTSTRAP, indent=2, ensure_ascii=False))
TS_GPU = verify_torch_environments(ENV_ROOT, require_a100=REQUIRE_A100)
print("隔離時序模型 GPU：")
print(json.dumps(TS_GPU, indent=2, ensure_ascii=False))
"""),
        markdown("## 5. 依序執行正式訓練或選擇性 smoke\n\n`MODE = 'full'` 預設直接執行正式規格；只有 `RUN_SMOKE_BEFORE_FULL = True` 才先跑額外 smoke。若設定 `MODE = 'smoke'`，則只執行 smoke。正式 run 可指定已提交的 session／run 來恢復；Drive 中每個完整 stage 以獨立 ZIP 保存，只有完成雜湊驗證後才寫入 `COMMITTED`。"""),
        code("""import json
import secrets
import time
from datetime import datetime, timezone

from research.model_benchmark.colab import (
    commit_notebook_artifacts,
    current_portable_identity,
    python_executable,
    restore_latest_snapshot,
    run_with_snapshots,
    smoke_succeeded,
)
from research.model_benchmark.snapshots import SnapshotStore
import research.model_benchmark.colab as cb

# Kernel-only race fix: drain complete JSONL rows that arrive while the last
# immutable Drive snapshot is being written. This does not modify the bundle.
def _snapshot_events_fixed(event_file, run_root, store, *, offset, stop_event, errors, on_snapshot):
    seen = set()
    while True:
        try:
            offset, events = cb._read_new_events(event_file, offset)
            for event in events:
                event_id = str(event.get("event_id", ""))
                if event_id in seen:
                    continue
                seen.add(event_id)
                path = store.save_event(run_root, event)
                if on_snapshot:
                    on_snapshot(path)
            if stop_event.is_set():
                next_offset, _ = cb._read_new_events(event_file, offset)
                if next_offset > offset:
                    continue
                if event_file.is_file() and event_file.stat().st_size > offset:
                    errors.append("stage event log ended with an incomplete JSONL record")
                return
        except Exception as exc:
            errors.append(f"{type(exc).__name__}: {exc}")
            return
        stop_event.wait(0.5)

cb._snapshot_events = _snapshot_events_fixed

def print_run_status(run_dir):
    manifest_path = Path(run_dir) / "run_manifest.json"
    if not manifest_path.is_file():
        print(f"run_manifest.json 尚不存在：{manifest_path}", flush=True)
        return None
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    print(f"run={manifest.get('run_id')} status={manifest.get('status')} reason={manifest.get('status_reason')}", flush=True)
    for key, item in manifest.get("models", {}).items():
        print(
            f"{key}: status={item.get('status')} evaluation={item.get('evaluation_status')} "
            f"device={item.get('device')} error={item.get('error')}",
            flush=True,
        )
    log_path = RUN_LOGS / f"{Path(run_dir).name}.log"
    print(f"Runner log: {log_path} (exists={log_path.is_file()})", flush=True)
    return manifest

def replay_complete_run_events(run_dir):
    event_file = Path(run_dir) / "stage_events.jsonl"
    if not event_file.is_file():
        raise FileNotFoundError(f"stage event log is missing: {event_file}")
    with event_file.open("rb") as stream:
        stream.seek(0, 2)
        event_size = stream.tell()
        if event_size:
            stream.seek(-1, 2)
            if stream.read(1) not in {b"\\n", b"\\r"}:
                raise RuntimeError("stage_events.jsonl has an incomplete trailing record; refusing to publish a success snapshot.")
    offset = 0
    last_status_event = None
    while True:
        next_offset, events = cb._read_new_events(event_file, offset)
        for event in events:
            if event.get("event") == "run_status_changed":
                last_status_event = event
        if next_offset == offset:
            break
        offset = next_offset
    if last_status_event is None:
        raise RuntimeError("stage_events.jsonl has no complete run_status_changed event to recover.")
    archive_path = SNAPSHOTS.save_event(Path(run_dir), last_status_event)
    return last_status_event, archive_path

def saved_notebook_artifacts(run_dir, event, archive_path):
    artifact_paths = [record["path"] for record in event.get("artifact_manifest", [])]
    runner_log = next((path for path in artifact_paths if "/logs/runner-" in path), None)
    runtime_metadata = next((path for path in artifact_paths if "/runtime/hardware-" in path), None)
    return {
        "event": event, "archive_path": str(archive_path),
        "runner_log_path": str(Path(run_dir) / runner_log) if runner_log else "included in committed snapshot",
        "runtime_metadata_path": str(Path(run_dir) / runtime_metadata) if runtime_metadata else "included in committed snapshot",
    }

SESSION_ID = globals().get("SESSION_ID") or secrets.token_hex(8)
SNAPSHOTS = SnapshotStore(
    DRIVE_ROOT,
    SESSION_ID,
    local_lock_root=TMP_ROOT / "snapshot-locks",
)
RUNNER_PYTHON = python_executable(ENV_ROOT, "rank")
RUN_LOGS = WORK_ROOT / "logs"
RUN_LOG_PATHS = {}

def new_run_dir(label):
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    run_id = f"colab-{stamp}-{secrets.token_hex(4)}-{label}"
    return RUNS_ROOT / run_id

def execute_run(run_dir, *, smoke):
    command = [str(RUNNER_PYTHON), "-u", "-m", "research.model_benchmark.runner", "--run-dir", str(run_dir)]
    if smoke:
        command.append("--smoke")
    result = run_with_snapshots(
        command,
        repo_root=REPO_ROOT,
        env=ENV,
        run_root=run_dir,
        store=SNAPSHOTS,
        log_path=RUN_LOGS / f"{run_dir.name}.log",
        on_snapshot=lambda path: print(f"Drive checkpoint saved: {path}"),
    )
    RUN_LOG_PATHS[run_dir.name] = Path(result["log_path"])
    manifest_path = run_dir / "run_manifest.json"
    if not manifest_path.is_file():
        raise RuntimeError(f"runner did not produce a manifest: {result}")
    return result, manifest_path

RUN_SMOKE_BEFORE_FULL = globals().get("RUN_SMOKE_BEFORE_FULL", False)
previous_smoke_dir = globals().get("SMOKE_DIR")
SMOKE_DIR = Path(previous_smoke_dir) if previous_smoke_dir is not None else None
smoke_reused = False
existing_smoke_failed = False
if SMOKE_DIR is not None and (SMOKE_DIR / "run_manifest.json").is_file():
    prior_manifest = print_run_status(SMOKE_DIR)
    if prior_manifest and smoke_succeeded(SMOKE_DIR / "run_manifest.json"):
        smoke_reused = True
        RUN_LOG_PATHS[SMOKE_DIR.name] = RUN_LOGS / f"{SMOKE_DIR.name}.log"
        recovered_event, recovered_archive = replay_complete_run_events(SMOKE_DIR)
        if recovered_event.get("stage") == "notebook_completed":
            NOTEBOOK_ARTIFACTS = saved_notebook_artifacts(SMOKE_DIR, recovered_event, recovered_archive)
        else:
            NOTEBOOK_ARTIFACTS = commit_notebook_artifacts(
                SMOKE_DIR,
                runner_log=RUN_LOG_PATHS[SMOKE_DIR.name],
                runtime=RUNTIME,
                ts_gpu=TS_GPU,
                session_id=SESSION_ID,
                store=SNAPSHOTS,
            )
        _NOTEBOOK_ARTIFACTS_RUN_ID = SMOKE_DIR.name
        print("既有 smoke 的四模型狀態全數通過；已補存完整日誌與最終快照，未重新訓練。", flush=True)
    else:
        print("既有 smoke 未通過；上方狀態與日誌供檢查，不會標示為成功。", flush=True)
        existing_smoke_failed = True
else:
    existing_smoke_failed = False

if MODE == "full" and existing_smoke_failed and not RUN_SMOKE_BEFORE_FULL:
    raise RuntimeError(
        "偵測到既有 smoke 未通過，已停止正式訓練以免浪費 GPU。檢查上方各模型狀態與 runner log；"
        "若要明確重跑 smoke，設定 RUN_SMOKE_BEFORE_FULL=True。"
    )

should_run_smoke = MODE == "smoke" or (MODE == "full" and RUN_SMOKE_BEFORE_FULL and not smoke_reused)
if should_run_smoke and not smoke_reused:
    SMOKE_DIR = new_run_dir("smoke")
    try:
        smoke_result, smoke_manifest_path = execute_run(SMOKE_DIR, smoke=True)
    except Exception:
        print_run_status(SMOKE_DIR)
        raise
    if not smoke_succeeded(smoke_manifest_path):
        print_run_status(SMOKE_DIR)
        raise RuntimeError(f"四模型 smoke 未全部通過；未進入正式訓練。Runner log: {RUN_LOGS / (SMOKE_DIR.name + '.log')}")
    print("四模型真實 smoke 通過。這只是介面／訓練路徑檢查，不是正式性能結果。")
    recovered_event, recovered_archive = replay_complete_run_events(SMOKE_DIR)
    if recovered_event.get("stage") == "notebook_completed":
        NOTEBOOK_ARTIFACTS = saved_notebook_artifacts(SMOKE_DIR, recovered_event, recovered_archive)
    else:
        NOTEBOOK_ARTIFACTS = commit_notebook_artifacts(
            SMOKE_DIR, runner_log=RUN_LOG_PATHS[SMOKE_DIR.name], runtime=RUNTIME,
            ts_gpu=TS_GPU, session_id=SESSION_ID, store=SNAPSHOTS,
        )
    _NOTEBOOK_ARTIFACTS_RUN_ID = SMOKE_DIR.name
elif MODE == "full" and not smoke_reused:
    print("MODE='full'：依設定略過額外 smoke，直接執行正式規格。")

if MODE == "smoke":
    if SMOKE_DIR is None:
        raise RuntimeError("Smoke run 未建立。")
    RESULT_RUN_ID = SMOKE_DIR.name
    FINAL_RUN_DIR = SMOKE_DIR
    print(f"Smoke 報告：{SMOKE_DIR / 'comparison.md'}")
else:
    if RESTORE_RUN_ID is not None:
        expected = current_portable_identity(REPO_ROOT, ENV, smoke=False)
        restored = restore_latest_snapshot(
            SNAPSHOTS,
            run_id=RESTORE_RUN_ID,
            source_session_id=RESTORE_SESSION_ID,
            local_runs_root=RUNS_ROOT,
            expected_identity=expected,
        )
        FULL_DIR = Path(restored["destination"])
        print(f"已恢復完整快照 {restored['event_id']}，來源 session={restored['source_session_id']}")
    else:
        FULL_DIR = new_run_dir("full")
    full_result, full_manifest_path = execute_run(FULL_DIR, smoke=False)
    FINAL_RUN_DIR = FULL_DIR
    full_manifest = json.loads(full_manifest_path.read_text(encoding="utf-8"))
    RESULT_RUN_ID = FULL_DIR.name
    print(f"正式 run 狀態：{full_manifest.get('status')}；裝置紀錄與報告以 manifest 為準。")
    print(f"比較報告：{FULL_DIR / 'comparison.md'}")
    print(f"本次 Drive session：{SESSION_ID}")
    print(f"Drive 快照目錄：{DRIVE_ROOT / 'sessions' / SESSION_ID}")
    print(f"本機日誌：{RUN_LOGS}")
if globals().get("_NOTEBOOK_ARTIFACTS_RUN_ID") != FINAL_RUN_DIR.name:
    NOTEBOOK_ARTIFACTS = commit_notebook_artifacts(
        FINAL_RUN_DIR,
        runner_log=RUN_LOG_PATHS[FINAL_RUN_DIR.name],
        runtime=RUNTIME,
        ts_gpu=TS_GPU,
        session_id=SESSION_ID,
        store=SNAPSHOTS,
    )
    _NOTEBOOK_ARTIFACTS_RUN_ID = FINAL_RUN_DIR.name
print(f"runner 完整日誌已進入 snapshot：{NOTEBOOK_ARTIFACTS['runner_log_path']}")
print(f"Colab／CUDA 硬體紀錄已進入 snapshot：{NOTEBOOK_ARTIFACTS['runtime_metadata_path']}")
"""),
        markdown("## 5A. 讀取 smoke 狀態並補存已完成結果\n\n若第 5 步曾因快照 watcher 訊息中斷，可執行此格。它只讀取 run manifest，不重新啟動訓練；只有 `smoke_succeeded` 通過才會補存日誌與最終快照。"),
        code("""from pathlib import Path
import json
import secrets
import research.model_benchmark.colab as cb
from research.model_benchmark.colab import commit_notebook_artifacts, smoke_succeeded
from research.model_benchmark.snapshots import SnapshotStore

RUN_RECOVERY = globals().get("RUN_RECOVERY", False)
if not RUN_RECOVERY:
    print("Recovery cell 已停用；只有手動設 RUN_RECOVERY=True 才會讀取或補存 smoke run。", flush=True)
else:
    RECOVERY_VALUE = globals().get("RECOVERY_RUN_PATH") or globals().get("SMOKE_DIR")
    if not RECOVERY_VALUE:
        raise FileNotFoundError("請將 RECOVERY_RUN_PATH 設為已完成 smoke run 資料夾，再執行此格。")
    RECOVERY_RUN_DIR = Path(RECOVERY_VALUE)
    if not RECOVERY_RUN_DIR.is_dir():
        raise FileNotFoundError("請將 RECOVERY_RUN_PATH 設為已完成 smoke run 資料夾，再執行此格。")
    RECOVERY_MANIFEST_PATH = RECOVERY_RUN_DIR / "run_manifest.json"
    if not RECOVERY_MANIFEST_PATH.is_file():
        raise FileNotFoundError(f"run manifest 尚不存在：{RECOVERY_MANIFEST_PATH}")
    RECOVERY_MANIFEST = json.loads(RECOVERY_MANIFEST_PATH.read_text(encoding="utf-8"))
    print(f"run={RECOVERY_MANIFEST.get('run_id')} status={RECOVERY_MANIFEST.get('status')} reason={RECOVERY_MANIFEST.get('status_reason')}", flush=True)
    for model_key, model_item in RECOVERY_MANIFEST.get("models", {}).items():
        print(
            f"{model_key}: status={model_item.get('status')} evaluation={model_item.get('evaluation_status')} "
            f"device={model_item.get('device')} error={model_item.get('error')}",
            flush=True,
        )
    RECOVERY_LOG = Path(globals().get("RUN_LOGS", WORK_ROOT / "logs")) / f"{RECOVERY_RUN_DIR.name}.log"
    print(f"Runner log: {RECOVERY_LOG} (exists={RECOVERY_LOG.is_file()})", flush=True)

    if not smoke_succeeded(RECOVERY_MANIFEST_PATH):
        print("smoke_succeeded=False；沒有標示成功，也沒有補存成功結果。請依上方 model status 與 runner log 檢查。", flush=True)
    elif not RECOVERY_LOG.is_file():
        print("四模型 smoke manifest 通過，但 runner 完整日誌不存在；未建立不完整的最終快照。", flush=True)
    else:
        if "SNAPSHOTS" not in globals():
            SESSION_ID = globals().get("SESSION_ID") or secrets.token_hex(8)
            SNAPSHOTS = SnapshotStore(DRIVE_ROOT, SESSION_ID, local_lock_root=TMP_ROOT / "snapshot-locks")
        else:
            SESSION_ID = globals().get("SESSION_ID") or secrets.token_hex(8)

        event_file = RECOVERY_RUN_DIR / "stage_events.jsonl"
        last_status_event = None
        if event_file.is_file():
            with event_file.open("rb") as stream:
                stream.seek(0, 2)
                event_size = stream.tell()
                if event_size:
                    stream.seek(-1, 2)
                    if stream.read(1) not in {b"\\n", b"\\r"}:
                        raise RuntimeError("stage_events.jsonl 尾端紀錄未完整結束；已保留現況，未補報成功快照。")
            offset = 0
            while True:
                next_offset, events = cb._read_new_events(event_file, offset)
                for event in events:
                    if event.get("event") == "run_status_changed":
                        last_status_event = event
                if next_offset == offset:
                    break
                offset = next_offset
        if last_status_event is None:
            raise RuntimeError("stage_events.jsonl 沒有完整的 run_status_changed event，未補存成功快照。")
        RECOVERY_ARCHIVE = SNAPSHOTS.save_event(RECOVERY_RUN_DIR, last_status_event)
        if last_status_event.get("stage") == "notebook_completed":
            print(f"Smoke 最終 snapshot 已存在：{RECOVERY_ARCHIVE}", flush=True)
        else:
            NOTEBOOK_ARTIFACTS = commit_notebook_artifacts(
                RECOVERY_RUN_DIR,
                runner_log=RECOVERY_LOG,
                runtime=RUNTIME,
                ts_gpu=TS_GPU,
                session_id=SESSION_ID,
                store=SNAPSHOTS,
            )
            print(f"已補存 smoke 日誌與最終 snapshot：{NOTEBOOK_ARTIFACTS['archive_path']}", flush=True)
        SMOKE_DIR = RECOVERY_RUN_DIR
        _NOTEBOOK_ARTIFACTS_RUN_ID = RECOVERY_RUN_DIR.name
        RESULT_RUN_ID = RECOVERY_RUN_DIR.name
        FINAL_RUN_DIR = RECOVERY_RUN_DIR
        print("可接著執行最後的結果封裝 cell；本 recovery cell 沒有啟動模型或 GPU。", flush=True)
"""),
        markdown("""## 6. 查看結果與恢復方式

正式訓練完成後，主要產物是 `comparison.md`、`comparison.csv`、`comparison.json`、run manifest、模型／adapter 與每階段日誌。已提交快照位於 Drive 的 `sessions/<session-id>/<run-id>/generations/`。最後一個完整結果 snapshot 會複製成 ZIP，保留 Drive 原檔並顯示可由 VS Code 遠端檔案檢視器開啟的路徑。

若 runtime 中斷，重新連線並重新執行前置儲存格。將前次輸出的 session 和 run ID 填入第一個設定儲存格，然後選 `MODE = "full"`。Notebook 會驗證來源、環境、資料、權重和快照雜湊；不相符時停止，不會把 Windows run 或其他 Python／CUDA 環境接續到目前 run。

Drive 是持久保存位置，訓練仍在臨時 Colab VM 執行。若連線在下一個 checkpoint 提交前中斷，該段進度可能需要重跑。
"""),
        code("""# Create a download bundle from the last complete run snapshot.
import hashlib
import os
import shutil

result_candidates = [
    item for item in SNAPSHOTS.list_committed(RESULT_RUN_ID)
    if item["session_id"] == SESSION_ID and item["event"].get("event") == "run_status_changed"
]
if not result_candidates:
    raise RuntimeError("找不到已提交的最終報告快照，無法建立下載包。")
RESULT_SNAPSHOT = result_candidates[-1]
RESULT_RUN_MANIFEST = json.loads((RUNS_ROOT / RESULT_RUN_ID / "run_manifest.json").read_text(encoding="utf-8"))
print("模型／訓練裝置摘要：")
print(json.dumps({
    key: {"status": item.get("status"), "evaluation_status": item.get("evaluation_status"), "device": item.get("device")}
    for key, item in RESULT_RUN_MANIFEST.get("models", {}).items()
}, indent=2, ensure_ascii=False))
print("Colab 執行環境：")
print(json.dumps({"runtime": RUNTIME, "timeseries_environments": TS_GPU}, indent=2, ensure_ascii=False))

LOCAL_DELIVERABLES = WORK_ROOT / "deliverables"
LOCAL_DELIVERABLES.mkdir(parents=True, exist_ok=True)
RESULT_ZIP_NAME = f"{RESULT_RUN_ID}-{RESULT_SNAPSHOT['event_id']}-results.zip"
LOCAL_RESULT_ZIP = LOCAL_DELIVERABLES / RESULT_ZIP_NAME
DRIVE_RESULT_ZIP = DRIVE_ROOT.parent / RESULT_ZIP_NAME
for destination in (LOCAL_RESULT_ZIP, DRIVE_RESULT_ZIP):
    if not destination.exists():
        temporary = destination.with_suffix(destination.suffix + ".uploading")
        shutil.copyfile(RESULT_SNAPSHOT["archive_path"], temporary)
        if hashlib.sha256(temporary.read_bytes()).hexdigest() != RESULT_SNAPSHOT["archive_sha256"]:
            temporary.unlink(missing_ok=True)
            raise IOError(f"結果 ZIP 複製後 SHA256 不符：{destination}")
        os.replace(temporary, destination)
    elif hashlib.sha256(destination.read_bytes()).hexdigest() != RESULT_SNAPSHOT["archive_sha256"]:
        raise ValueError(f"結果 ZIP 已存在但 hash 不符：{destination}")

print(f"Drive 結果 ZIP 已保存：{DRIVE_RESULT_ZIP}")
print(f"Colab 本機結果 ZIP：{LOCAL_RESULT_ZIP}")
print("可在 VS Code Colab 遠端檔案檢視器或已掛載的 Google Drive 開啟結果 ZIP。")
"""),
    ]
    return {
        "cells": cells,
        "metadata": {
            "kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python", "version": "3.12"},
            "colab": {"name": "model_benchmark_colab.ipynb", "provenance": []},
        },
        "nbformat": 4,
        "nbformat_minor": 5,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("notebooks/model_benchmark_colab.ipynb"))
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    notebook = build_notebook()
    args.output.write_text(json.dumps(notebook, ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(args.output.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
