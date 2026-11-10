"""Generate the output-free GitHub -> Colab web benchmark entrypoint."""
from __future__ import annotations
import argparse
import hashlib
import json
from pathlib import Path


def cell(kind: str, source: str) -> dict:
    item = {"cell_type": kind, "id": hashlib.sha256(source.encode()).hexdigest()[:12],
            "metadata": {}, "source": source.splitlines(keepends=True)}
    if kind == "code":
        item.update(execution_count=None, outputs=[])
    return item


CONFIG = '''from pathlib import Path
REPOSITORY = "kevingg601/Cryptocurrency-Trading-Analysis-Binance"
CODE_COMMIT = ""  # REQUIRED: paste the exact 40-character GitHub commit from the release instructions
PRIVATE_REPO = True  # False for a public repository
GITHUB_SECRET_NAME = "FADACHI_GITHUB_TOKEN"
DRIVE_ROOT = Path("/content/drive/MyDrive/fadachi")
ACTION = "train"  # "train", "infer", "export"
RUN_MODE = "full"  # "full" or explicitly "smoke"; no automatic smoke before full
MODEL_KEYS = ["catboost", "xgboost", "chronos2", "timesfm25"]
RESUME_RUN_ID = None  # completed/interrupted run ID; None creates a new experiment
RESUME_SESSION_ID = None  # required when restoring a run from Drive after runtime loss
MODEL_RUN_PATH = None  # infer only: local extracted model run directory, never starts training
EXPORT_RUN_PATH = ""  # export only: explicit completed local run directory
# Run only export cell 6 to recover results. It does not need GPU/environment setup.
'''

CHECKOUT = r'''import os, re, shlex, subprocess, sys, tempfile, time
from pathlib import Path
if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", REPOSITORY):
    raise ValueError("REPOSITORY must be owner/repository")
if not re.fullmatch(r"[0-9a-fA-F]{40}", CODE_COMMIT):
    raise ValueError("Paste the exact 40-character CODE_COMMIT before connecting to GPU.")
if ACTION not in {"train", "infer", "export"}:
    raise ValueError("ACTION must be train, infer or export")
CODE_COMMIT = CODE_COMMIT.lower()
WORK_ROOT = Path("/content") / ("fadachi-github-" + CODE_COMMIT[:12])
REPO_ROOT = WORK_ROOT / "repo"
WORK_ROOT.mkdir(parents=True, exist_ok=True)
git_env = os.environ.copy()
for key in ("GIT_TRACE", "GIT_TRACE_CURL", "GIT_CURL_VERBOSE", "GIT_TRACE_PACKET"):
    git_env.pop(key, None)
git_env["GIT_TERMINAL_PROMPT"] = "0"
git_env["GIT_CONFIG_NOSYSTEM"] = "1"
git_env["GIT_CONFIG_GLOBAL"] = os.devnull
try:
    with tempfile.TemporaryDirectory(prefix="fadachi-git-") as temporary:
        git_options = ["git", "-c", "credential.helper="]
        if PRIVATE_REPO:
            from google.colab import userdata
            git_env["FADACHI_GIT_TOKEN"] = userdata.get(GITHUB_SECRET_NAME)
            helper = Path(temporary) / "credential.py"
            helper.write_text("import os,sys\nif len(sys.argv)>1 and sys.argv[1]=='get':\n print('username=x-access-token')\n print('password='+os.environ['FADACHI_GIT_TOKEN'])\n", encoding="utf-8")
            git_options += ["-c", "credential.helper=!" + shlex.quote(sys.executable) + " " + shlex.quote(str(helper))]
        def git_checked(arguments, *, cwd=None, network=False):
            for attempt in range(3 if network else 1):
                try:
                    result = subprocess.run(git_options + arguments, cwd=cwd, env=git_env,
                        capture_output=True, text=True, timeout=180)
                    if result.returncode == 0:
                        return result.stdout.strip()
                except subprocess.TimeoutExpired:
                    pass
                if network and attempt < 2:
                    print(f"GitHub download retry {attempt+1}/3", flush=True)
                    time.sleep(2)
            # Do not expose raw credential helper errors or subprocess environments.
            raise RuntimeError("GitHub operation failed; check repository, commit and read permission. No training started.")
        if not REPO_ROOT.exists():
            git_checked(["init", str(REPO_ROOT)])
        origin = "https://github.com/" + REPOSITORY + ".git"
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO_ROOT, capture_output=True, text=True)
        if head.returncode or head.stdout.strip() != CODE_COMMIT:
            if git_checked(["status", "--porcelain"], cwd=REPO_ROOT):
                raise RuntimeError("Checkout contains local edits; preserved without checkout.")
            git_checked(["fetch", "--depth", "1", origin, CODE_COMMIT], cwd=REPO_ROOT, network=True)
            git_checked(["checkout", "--detach", "FETCH_HEAD"], cwd=REPO_ROOT)
        if git_checked(["rev-parse", "HEAD"], cwd=REPO_ROOT) != CODE_COMMIT:
            raise RuntimeError("Checkout commit mismatch")
        if git_checked(["diff", "--name-only", "HEAD"], cwd=REPO_ROOT):
            raise RuntimeError("Tracked checkout files changed; refusing mixed code identity")
finally:
    git_env.pop("FADACHI_GIT_TOKEN", None)
sys.path.insert(0, str(REPO_ROOT))
# A reused notebook kernel must not import modules from an earlier checkout.
for module_name, module in list(sys.modules.items()):
    if module_name == "research" or module_name.startswith("research."):
        location = getattr(module, "__file__", None)
        if location and not Path(location).resolve().is_relative_to(REPO_ROOT.resolve()):
            for stale in list(sys.modules):
                if stale == "research" or stale.startswith("research."):
                    del sys.modules[stale]
            break
from google.colab import drive
if not Path("/content/drive/MyDrive").is_dir():
    drive.mount("/content/drive", timeout_ms=60000)
if not Path("/content/drive/MyDrive").is_dir():
    raise RuntimeError("Run Drive mount cell and finish authorization first")
print("Code commit:", CODE_COMMIT)
print("Work root:", WORK_ROOT)
print("Drive root:", DRIVE_ROOT)
'''

EXPORT = '''# Standalone recovery: change these paths if the kernel was restarted.
from pathlib import Path
import sys, json
EXPORT_REPO_PATH = globals().get("REPO_ROOT", "")
EXPORT_PATH = globals().get("EXPORT_RUN_PATH") or globals().get("RESULT_RUN_PATH", "")
EXPORT_DRIVE_ROOT = globals().get("DRIVE_ROOT", Path("/content/drive/MyDrive/fadachi"))
if not EXPORT_REPO_PATH or not EXPORT_PATH:
    raise ValueError("Set EXPORT_REPO_PATH and EXPORT_PATH to the existing repo/run directories, then rerun only this cell.")
repo = Path(EXPORT_REPO_PATH)
if not (repo / "research/model_benchmark/github_colab.py").is_file():
    raise FileNotFoundError("Export requires the new GitHub checkout; original result files are preserved.")
if not Path("/content/drive/MyDrive").is_dir():
    from google.colab import drive
    drive.mount("/content/drive", timeout_ms=60000)
sys.path.insert(0, str(repo))
from research.model_benchmark.github_colab import export_run
run = Path(EXPORT_PATH)
m = json.loads((run / "run_manifest.json").read_text(encoding="utf-8"))
print("Run status:", m.get("status"))
print("Models:", {k: v.get("status") for k,v in m.get("models",{}).items()})
report = run / "comparison.md"
if report.is_file():
    print(report.read_text(encoding="utf-8"))
export_run(run, Path(EXPORT_DRIVE_ROOT))
'''


def build_notebook() -> dict:
    cells = [
        cell("markdown", """# Fadachi：GitHub → Colab 網頁 → Google Drive

本機撰寫與 push；此 Notebook 取得同一 commit 的完整專案，Colab 執行，Drive 保存資料和成果。

第一次：開啟 GitHub 的固定 commit Notebook → 填 CODE_COMMIT → 私有庫設定 Secrets 的 FADACHI_GITHUB_TOKEN（僅該庫 Contents 唯讀並允許本 Notebook 存取）→ Colab「執行階段／變更執行階段類型」手動選 GPU（T4 可用）→ 依序執行。掛載 Drive 的格子必須執行並完成授權。

開啟私有 Notebook 的 GitHub 網頁授權，與 runtime 下載專案的 token 是不同環節。程式不會自動回推 GitHub。全量訓練不預跑 smoke、不保證單次 session 完成。

資料維持 v3 TRAIN/VAL/TEST 與原有成本算法。TEST 已被查看，只作研究比較。`infer` 僅重新推論已保存模型於固定共同 TEST，不宣稱新資料泛化。
"""),
        cell("markdown", "## 1. 設定\n先填固定 commit；私有庫 token 存 Secrets，不貼進程式。要取回結果可直接執行第 6 格。"),
        cell("code", CONFIG),
        cell("markdown", "## 2. 下載固定程式版本、掛載 Drive\n執行此格並完成授權；只開啟 Notebook 不會取得完整專案。"),
        cell("code", CHECKOUT),
        cell("markdown", "## 3. 短時間 GPU 預檢\n顯示 nvidia-smi、檢查實際 CUDA 運算；不進行模型 smoke。"),
        cell("code", '''if ACTION != "export":
    from research.model_benchmark.github_colab import gpu_probe
    GPU_INFO = gpu_probe(timeout=45)
else:
    print("Export mode: GPU check skipped")
'''),
        cell("markdown", "## 4. 準備鎖定環境與資料\n首次下載後會將 Python 安裝包、套件 wheels 與模型權重備份至 Drive 的 cache/；下次先還原並核對 hash，完整 wheels 以離線方式安裝。實際環境仍在 /content，不訓練。先將資料 ZIP 及 manifest 上傳 Drive 的 inputs/v3-20261110-004810/。"),
        cell("code", '''if ACTION != "export":
    from research.model_benchmark.github_colab import prepare
    ENV = prepare(REPO_ROOT, WORK_ROOT, DRIVE_ROOT, models=MODEL_KEYS)
else:
    print("Export mode: installation and data setup skipped")
'''),
        cell("markdown", "## 5. 明確執行訓練或只推論\n重新執行且 RESUME_RUN_ID=None 會建立新實驗。續跑須填既有 run ID；跨 runtime 另填快照 session ID。同一 commit、資料、環境身分才可續跑。只推論須先把保存的模型 run 解壓到 /content 並指定 MODEL_RUN_PATH；不會呼叫 train。"),
        cell("code", '''if ACTION != "export":
    from research.model_benchmark.github_colab import execute
    resume = WORK_ROOT / "runs" / RESUME_RUN_ID if RESUME_RUN_ID else None
    RESULT_RUN_PATH = execute(REPO_ROOT, WORK_ROOT, DRIVE_ROOT,
        action=ACTION, mode=RUN_MODE, models=MODEL_KEYS,
        resume_run=resume, resume_session=RESUME_SESSION_ID,
        model_run=Path(MODEL_RUN_PATH) if MODEL_RUN_PATH else None)
else:
    print("Export mode: no training or inference")
'''),
        cell("markdown", "## 6. 查看結果／獨立恢復匯出\n不需要第 3～5 格或 SNAPSHOTS 變數。kernel 重啟時，在本格直接填 EXPORT_REPO_PATH、EXPORT_PATH、EXPORT_DRIVE_ROOT 再執行。會建立唯一備份並驗證 SHA256，PARTIAL 仍保留原狀態。"),
        cell("code", EXPORT),
    ]
    return {"cells": cells, "metadata": {"kernelspec": {"display_name": "Python 3", "language": "python", "name": "python3"},
            "language_info": {"name": "python"}, "colab": {"name": "model_benchmark_colab.ipynb", "provenance": []}},
            "nbformat": 4, "nbformat_minor": 5}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("notebooks/model_benchmark_colab.ipynb"))
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(build_notebook(), ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
    print(args.output.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
