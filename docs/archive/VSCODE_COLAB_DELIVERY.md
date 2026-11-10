# VS Code／Colab Python 3.13 核心相容修訂

日期：2026-11-10。工作目錄：`D:\PYTHON\fadachi`。

依使用者「我都是在 VS Code 中執行的，你改程式」指示，入口改為在 VS Code 保留現有 Colab Python 3.12／3.13 核心。模型訓練仍使用固定 Python 3.12 獨立環境，維持原四模型、依賴鎖、資料、超參數及評估規格。詳見 [操作說明](../COLAB_MODEL_BENCHMARK_USAGE.md)。

## 相容方式

- Notebook 核心負責設定、GPU 預檢、路徑及顯示；實際 bootstrap、runner、模型環境與身分計算由獨立 Python 3.12 子程序執行。
- 程式在專案快取準備 Astral python-build-standalone CPython **3.12.12**、release **20251028**，來源 URL、目標平台與 SHA256 固定於 `research/model_benchmark/python-runtime.lock.json`。
- 新增 `managed_python.py`，在驗證完整 archive hash 後才安全解壓及核對 interpreter，透過 `FADACHI_MODEL_BENCHMARK_PYTHON` 傳給子程序。不更換 VS Code 核心、不修改系統 Python 或原 `.venv`。
- 子程序移除 host 的 Python 環境路徑，只使用專案與精確鎖定 venv，避免 3.13 核心的套件污染 3.12 訓練程序。
- 輸入 ZIP 使用遠端 `/content`／Drive 的實際路徑，成果保存 Drive 並列出路徑；瀏覽器上傳／下載 widget 不作為必要入口。
- 本次 **Notebook 與 ZIP 都需更新**，舊包缺少管理 interpreter 所需的新模組與資產鎖。不同程式／環境身分另開 run，不將舊 checkpoint 強接新版本。

固定 Python archive SHA256：

```text
d136b7168603620bf82fd2ec0fcaed2a5853551aae66f8023b3ae32b435683f2
```

來源核對：[Astral uv 0.9.6 固定版下載 metadata](https://raw.githubusercontent.com/astral-sh/uv/0.9.6/crates/uv-python/download-metadata.json)，項目 `cpython-3.12.12-linux-x86_64-gnu`。

## 已確認的驗證邊界

本機已實際下載 33,321,975 bytes 官方 archive，SHA256 一致；以新安裝器檢查全部 4,740 成員及 1,048 內部連結通過。Windows 本機沒有執行該 Linux binary，不將內容檢查冒稱 Linux 安裝成功。

核心曾以本機真實 Python 3.12 與獨立 rank 子程序取得四模型 fingerprints，沒有以 host Python 3.13 偽造模型身分。這次不調整模型數學運算或重新搜尋超參數，也不自動啟動全量訓練。

**VS Code 連接 Colab Python 3.13／A100 的遠端實際執行仍需在使用者核心完成。** 本機測試、合成 archive、版本 mock 或原本的 Windows GPU smoke，不代表該遠端環境已驗收。

## 最終交付驗證

- 四個相關測試檔同批執行：**53 passed**，包含核心、VS Code 介面、managed Python、probe 隔離、封裝與快照。
- Notebook 正式 nbformat schema、所有 code cells AST 通過，沒有預存假結果，也沒有必要的 `files.upload()`／`files.download()` 元件。
- 真實子程序整合：建立不含 numpy／pandas／pip 的空基底環境，確認排程器仍使用已安裝 numpy／pandas 2.2.3 的 rank venv，正常退出。沒有啟動模型或 GPU。
- Reviewer 找出的基底 Python 誤用問題已修正並複查；rank 入口不解析 symlink 成基底。真 PBS archive 確認含 pip 與 ensurepip。
- 新版 ZIP **35 檔、33,856,206 bytes**，已完成建立、完整 hash／白名單核對與安全解壓；包含 managed runtime feature、helper 與資產鎖。
- 新 ZIP SHA256：`b4bf572b34004f7c81d7d94969f8cca5d6d1fd1b0d607ad77669a26c60f54ebb`。
- 機器可讀證據：`.benchmark-tmp/vscode-python/final-tests.log`、`final-release.json`、`toy-integration.json`、`archive-verification.json`。

## T4 預設設定更新

依使用者選擇改用 T4，Notebook 與產生器預設 `REQUIRE_A100 = False`。仍檢查 CUDA 與實際 GPU，四模型、float32、batch、更新次數及 CPU OOM 重試策略維持原設定。Notebook schema／所有 code cells AST 通過；原 ZIP SHA256 不變，無須更換資料包。未在遠端 T4 執行訓練驗收。
