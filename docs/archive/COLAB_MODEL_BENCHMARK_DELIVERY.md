# Colab 四模型 Notebook 交付紀錄

本文保留初版及先前補修的驗證紀錄。最新的 VS Code／Python 3.13 核心支援版本，請見 [VS Code 交付紀錄](VSCODE_COLAB_DELIVERY.md) 與 [目前操作說明](../COLAB_MODEL_BENCHMARK_USAGE.md)；下方舊 ZIP hash 對應初版資料包。

日期：2026-11-10。工作目錄：`D:\PYTHON\fadachi`。

使用者於 Colab 改造計畫後回覆「修改」，本次依確認範圍實作、測試及獨立審查。操作方式見 [使用說明](../COLAB_MODEL_BENCHMARK_USAGE.md)。

## 交付檔案

- `notebooks/model_benchmark_colab.ipynb`：Colab 操作入口，13 cells，其中 6 個 code cells。預設 `MODE = "full"`，先執行四模型真實 smoke，通過後再啟動正式訓練。
- `data/model-benchmark/colab/fadachi-colab-bundle.zip`：33 檔，33,850,433 bytes（約 34 MB）；必要程式、v3 原始資料、三份 Linux 精確依賴鎖及 LightGBM 基準。
- `research/model_benchmark/colab.py`、`bundle.py`、`snapshots.py`：環境檢查、安全封裝／解壓、即時日誌、Drive 提交快照與恢復。
- 共用核心：跨平台 roots、獨立 venv interpreter、可攜內容身分、逐模型程序、候選及模型階段恢復、不可變事件與已關閉日誌保存。
- `scripts/build_colab_benchmark_notebook.py`：Notebook 產生器。

資料包 SHA256：

```text
4b5368037f03eff3fe263a4505ea7da359d8fb08c6bd830a7648a49f507a4915
```

Notebook 操作順序參考使用者提供的 `D:\PYTHON\fr_shoulder\tmp\colab_gpu.ipynb`：GPU 檢查、Drive 掛載、ZIP 核對、獨立程序即時日誌、狀態摘要與結果下載。原 Notebook 只讀取，沒有執行或修改；其訓練資料及 HPO 設定沒有混入本專案。

## 實際驗證證據

| 範圍 | 結果 |
| --- | --- |
| Notebook | nbformat 5.10.4 正式 schema 驗證通過，6 個 code cells AST 通過，沒有預存未經驗證的執行結果。沒有宣稱 Notebook 已在 Colab 由上到下執行。 |
| 核心與 TS 測試 | 最後一批 41 passed；涵蓋跨平台路徑／身分、資料與切分、程序、候選與模型恢復、閉合日誌、nested artifact POSIX 路徑等。 |
| 排序環境測試 | 6 passed；包含真實 CPU 訓練，以及只保留最新候選快照、刪除原 run 後已完成候選仍可略過的測試。 |
| Colab／封裝／快照測試 | 7 passed；包含安全 ZIP、提交與損毀驗證、完整模型／報告／日誌／硬體紀錄恢復及舊 Windows nested key 相容。各批次分屬不同環境，不相加為一次全套測試數。 |
| Linux 套件鎖 | rank 31／Chronos 62／TimesFM 60 個固定版本。保留原已驗證共通套件版本，補 Linux 的 NVIDIA／Triton 相依；以 manylinux CPython 3.12 wheel metadata 及明確 Linux marker 依賴閉合檢查，缺失為 0。這不是 Linux 安裝或 A100 實測。 |
| 真實四模型 smoke | 最終來源版本在 Windows 執行：四模型各自 SUCCESS、評估 PASSED、fresh_load=true。Chronos-2／TimesFM 各完成 1 次 CUDA optimizer update、有效梯度與 LoRA 權重變更；排序模型在 CPU 實際訓練。 |
| 真實事件保存 | 訓練期間即時 watcher 加 Notebook 完成事件共 32 份已提交快照；儲存位置為本機模擬 Drive，沒有冒稱 Google Drive FUSE 實測。 |
| 真實中途恢復 | 只恢復第 2 個 CatBoost 候選事件，兩個已完成候選及四份必要模型／state 產物均存在；模型完成事件在沒有 `comparison.md` 的情況下恢復，模型完整性仍通過。 |
| 真實完整恢復與續跑 | 完整快照還原 70 檔，包含三份報告、模型、worker／外層日誌與硬體 JSON；重新執行 runner，四模型全部沿用原 attempt，未重新訓練。 |
| 舊 Windows 相容 | 用前一輪真實快照驗證 `adapter\\README.md` 等舊鍵，四模型完整性通過；不重寫原 metadata 或 hash。跨程式版本 runner 續跑仍拒絕身分漂移。 |
| 最終資料包 | 實際封裝、白名單／檔案 hash 核對與安全解壓通過；隔離程序曾驗證可攜程式與 91,680 列資料載入；最後版本解壓後檔案 hash 完整核對。 |
| 原始產物保留 | v3 manifest、三份資料、LightGBM metadata／多空權重及舊比較 JSON 共八份 SHA256 不變；參考 Notebook 的 SHA256 也不變。 |
| 獨立審查 | reviewer 找出的模型階段依賴最終報告、候選未累積、日誌未持久保存均已修正並複查；Windows 分隔符補修另經精準複查，未發現新的具體缺陷。 |

最終真實驗證 run：

```text
.benchmark-tmp/colab-verification/windows-final-runs/verify-20261110T033521Z
```

該 run 整體刻意為 `PARTIAL / SMOKE_ONLY`，四模型個別均成功。共同樣本為 40 pairs／2 個 UTC 午夜群組／20 幣；不能將此小樣本數值當成正式性能比較。

可檢查的機器可讀證據：

- `.benchmark-tmp/colab-verification/final-integration.json`
- `.benchmark-tmp/colab-verification/final-notebook-bundle.json`
- `.benchmark-tmp/colab-verification/legacy-real-restore.json`
- `.benchmark-tmp/colab-verification/preservation-check.json`
- `data/model-benchmark/colab/linux-lock-validation.json`

## 執行與驗證邊界

- **Colab A100、Linux 實際安裝及 Google Drive FUSE 提交仍未實測。** 首次在自己的 Colab 執行 Notebook 的 smoke gate 後，才有該 runtime 的真實相容證據；CPU／GPU 名稱、torch／CUDA 與日誌會保存到結果包。
- 未啟動正式長時間訓練。使用者在 Colab 選 A100 與相容 Python 3.12 runtime，執行 Notebook 後才啟動；預設 full 模式包含正式四模型流程。
- 保留 CatBoost／XGBoost CPU、Chronos-2／TimesFM 2.5 CUDA LoRA、v3 資料及原訓練／評估規格；OOM 依原政策改新 attempt 用 CPU，報告標示實際裝置。
- 保證已提交模型／候選階段恢復；未落盤或無完整 optimizer 狀態的時序微調可能重跑，不保證逐步精確續訓或零進度損失。
- Windows 原 PowerShell 入口保留，舊 Windows run 不直接接續至 Linux；不保證 Colab 分配 A100、session 壽命或一夜完成。
- TEST 已被查看，來源幣種清單有存活／選擇偏差；結果為既有資料研究比較，不代表新的獨立測試或實盤獲利。
- 沒有修改前端、交易功能或自動下單。依使用者要求，未操作瀏覽器、畫面或互動驗證。

## 更新：第 2 步環境檢查與上傳等待

2026-11-10 使用者提供的畫面顯示 `files.upload()` 的上傳元件已不適用於目前瀏覽器工作階段，程式仍等待選檔。可先停止該格，再重跑並選取 ZIP。

此次只更新 Notebook、其產生器及相關測試：

- 第 2 步只檢查 Linux／Python 3.12、磁碟與 GPU，立即顯示進度；CUDA 檢查在子程序執行，設 90 秒逾時，逾時或中斷時清理並等待子程序結束。
- 第 3 步才選取 ZIP，選檔前說明上傳元件失效的處理方式。Drive 路徑先複製到 Colab 本機，再進行逐檔 hash、ZIP 匯入及解壓；本機檔案沿用。路徑判斷明確排除 `/content/drive` 掛載點。
- 相關測試最後 10 passed，包含實際生成 helper 的子程序逾時與 Drive／本機路徑分類；Notebook schema 及 6 個 code cells 的 AST 檢查通過。
- 原 ZIP 的 SHA256 及其 33 個封裝檔案均未改變，無需重新下載資料包；模型、依賴、訓練規格及快取身分保持原設定。本次未重跑模型訓練，未在 Colab／A100 或瀏覽器實測。
