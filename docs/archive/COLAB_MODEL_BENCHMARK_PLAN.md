# Colab Notebook／A100 四模型訓練改造計畫

狀態：**已確認，進入實作。** 使用者在讀取本計畫後回覆「修改」，授權依此範圍修改。全量訓練仍由使用者在交付後啟動。

日期：2026-11-10。目標工作目錄：`D:\PYTHON\fadachi`。

同日依使用者「我都是在 VS Code 中執行的，你改程式」指示修訂：Notebook 入口支援 VS Code 連接的 Colab Python 3.12／3.13 核心；模型使用程式自動準備的固定 Python 3.12 獨立環境，保留原模型依賴與訓練規格。操作不要求切換到 Colab 網站或更換遠端核心。以下早期 Python 3.12 規格適用於模型訓練程序；舊版網站切換方式由新版 VS Code 使用說明取代。

## 1. 交付目標

交付可上傳 Google Colab 的 `notebooks/model_benchmark_colab.ipynb`，以及白名單封裝的程式／資料 ZIP。使用者將 ZIP 放入 Google Drive，在 Colab 選 A100、掛載 Drive、設定 ZIP 路徑後，即可從 Notebook 執行四模型訓練與比較。

Notebook 作為操作入口，沿用既有 `research/model_benchmark/`，避免複製出另一套訓練邏輯；保留原 Windows PowerShell 入口。

- CatBoost Ranker、XGBoost Ranker：維持 CPU 訓練及多空分開模型。
- Chronos-2、TimesFM 2.5：使用 Colab A100 完成真正的 LoRA 微調。
- 固定沿用本次 v3 資料、120／30／30 天切分、特徵、成本、共同樣本、超參數及評估定義。
- A100 第一版不自動改成 BF16、不擴大 batch、不增加訓練更新次數，以維持既有比較規格。
- 報告、權重、adapter、日誌與續跑快照保存到 Drive；不修改面板或交易功能。

## 2. 已確認的移植問題

- `bootstrap.py` 與 `runner.py` 的環境 interpreter 目前使用 Windows `Scripts/python.exe`。
- 資料／環境身份含絕對路徑，部分 fingerprint 的相對路徑使用平台原生分隔符；搬到 Linux 或另一個 session 需要明確處理。
- source、run、cache 等路徑在多處定義，需統一設定。
- 現有 Windows 套件鎖不能直接視為已驗證的 Linux 鎖，尤其 PyTorch 的 Linux CUDA 相依套件不同。
- 現有微調沒有通用的完整 optimizer／RNG 恢復契約，不能把備份 adapter 宣稱為逐步續訓。

## 3. 修改範圍與步驟

### A. 跨平台核心

修改 `research/model_benchmark/` 的設定、bootstrap、runner 與必要 adapter 路徑使用處：

1. 集中設定資料、環境、快取、暫存及輸出根目錄；Windows 預設保持原有位置。
2. 支援 Windows `Scripts/python.exe` 及 Linux `bin/python`，每個模型仍以獨立子程序執行。
3. 內容身份以相對 POSIX 路徑與 hash 記錄，執行位置另存 provenance；環境身份保留 OS、Python、套件鎖及實際 CUDA／torch 資訊。
4. Windows 舊 run 不直接接續到 Linux。Colab 建立獨立 run；同一 Linux 設定恢復時核對資料、程式、環境及模型身份，身份不符就另開 run。
5. 舊 manifest 保留，不改寫舊模型與結果。

### B. Colab 環境

新增 Linux 專用精確依賴鎖及啟動檢查：

- 以 Python 3.12 為支援版本，建議選 Colab `2026.07` runtime；執行時核對實際版本，不假設最新 runtime 相容。
- 優先保留既有模型／套件版本與 `torch==2.6.0+cu126` 路線，檢查 Linux wheel、NVIDIA driver 與實際 CUDA 運算。
- 三個 venv 建在 `/content`，不覆蓋 Colab 全域套件。
- 下載使用原模型 revision／SHA256，有限重試；安裝或下載失敗如實回報。
- 正式啟動前顯示實際 GPU 名稱與顯存；預設要求 A100，未取得時停止並說明。
- 保留原已確認的 OOM 後 CPU 重試政策，使用新 attempt，報告明確標示實際裝置；不把 CPU 訓練標成 A100 訓練。

### C. 最小可攜資料包

新增白名單封裝程式及操作指令，產出獨立 ZIP：

- benchmark 模組及經 import 盤點後必要的 `model_research` 依賴。
- Linux 依賴鎖、模型資產鎖與 Notebook 所需啟動檔案。
- v3 `dataset_manifest.json`、三份 Parquet，以及既有 LightGBM 基準權重與 metadata。
- 每個檔案的相對路徑、大小與 SHA256 清單。

不包含虛擬環境、下載快取、前端套件、正式資料庫或憑證。封裝不改動來源；解壓防止路徑穿越並重新核對 hash。使用者自行將資料包上傳 Drive，本任務不直接存取或上傳使用者雲端帳戶。

### D. Notebook 流程

新增 `notebooks/model_benchmark_colab.ipynb`，使用繁體中文說明，依序提供：

1. 選擇 A100／相容 runtime 的操作說明與訓練規格。
2. 掛載 Drive、設定 ZIP 路徑、輸出目錄與 smoke／正式模式。
3. GPU、Python、磁碟檢查與安全解壓；固定本地工作路徑 `/content/fadachi-benchmark`。
4. 建立隔離環境、下載固定權重、核對資料與模型 hash。
5. 四模型真實 smoke，確認微調與儲存／重新載入路徑可用。
6. 正式依序執行 CatBoost → XGBoost → Chronos-2 → TimesFM 2.5 → 比較報告。
7. 顯示執行狀態、日誌位置及比較表，將完整產物保存 Drive，提供下載檔。

smoke 與正式 run 分開，smoke 仍標示 `PARTIAL / SMOKE_ONLY`，不冒充完整訓練。Notebook 不預存虛構的訓練輸出。

### E. Drive 保存與中斷恢復

訓練、套件及大量小檔 I/O 在 `/content` 執行；Drive 用來保存輸入 ZIP 與已提交快照：

1. 本地產生不可變的 generation archive 與檔案 hash 清單。
2. 上傳 Drive 並核對完整性，最後寫入 `COMMITTED` 標記。
3. 只恢復標記完整且 hash 通過的快照；拒絕部分上傳與損毀快照。
4. 每個 session 使用唯一儲存命名空間；恢復時建立子 session，避免兩個 VM 同時覆寫同一產物。
5. 本地 OS 鎖只保護同 VM，不宣稱 Drive 支援可靠跨 VM 分散式鎖。
6. 在候選完成、可用驗證 checkpoint、模型完成及報告完成時觸發保存；TS 驗證時增加必要的 adapter 落盤，避免只在記憶體保留最佳權重。

本版保證範圍維持為**已完成模型／候選與已驗證、已提交產物的恢復**。尚未完成的時序微調若沒有完整訓練狀態，建立新 attempt 重跑並清楚標記，不宣稱從相同 optimizer step 接續。斷線可能遺失最後一次成功提交後的進度。

## 4. 驗收條件

- Notebook 格式／schema、code cells 語法、參數與由上到下的依賴順序通過檢查。
- 測試 Windows／Linux interpreter 路徑、統一路徑設定、環境身份、相對路徑、資料／程式／模型 hash 漂移。
- 測試封裝白名單、缺檔、hash 不符、惡意 ZIP 路徑及來源保留。
- 測試完整快照恢復、缺 commit marker、截斷／損毀快照、session 隔離與本機重複啟動。
- 無 CUDA／GPU 不符時明確停止；OOM CPU 重試在報告中顯示真正裝置。
- 四模型真實 smoke：完成訓練／微調、保存、新子程序載入與預測；時序模型證明有效梯度、optimizer update 及 LoRA 權重改變。
- 共同比較的分母、切分與評估定義維持原規格；Windows 入口相關回歸檢查通過。
- 原來源資料、LightGBM 模型及舊比較報告等八份關鍵產物 hash 前後一致。
- 不自動啟動全量長時間實驗；不操作瀏覽器、畫面或互動驗證。

本機測試與真正 Colab A100 測試分開記錄。本工作環境若未接通 Colab A100，交付明示「Colab A100 未實測」，提供使用者執行 smoke 的步驟及需保存的 manifest；不得用 RTX 4050、mock 或靜態檢查冒充 A100 驗證。

## 5. 角色順序與交付

**planner 計畫 → 使用者明確確認 → codex 實作與驗證 → reviewer 獨立審查 → 修復與複查 → 交付。**

交付 Notebook、資料包產生器、可攜 ZIP、跨平台核心修改、Linux 鎖、測試、Colab 操作說明與驗證紀錄。reviewer 重點為訓練規格、Linux 相容性、身份核對、快照完整性及驗證宣稱。

目前沒有必須先決定的產品偏好；採本文件所列預設。若後續要求精確逐 optimizer step 恢復或 A100 專用 BF16／大 batch 加速，另列範圍，避免改變本次已固定的比較規格。

## 6. Colab 的實際限制與來源

Colab 的 GPU 種類、可用性與 session 壽命可能變動，不能保證每次取得 A100 或一夜完成。掛載 Drive 仍依賴 runtime，使用不可變快照降低中斷風險，不能保證零進度損失。

- [Colab 官方 FAQ：GPU、runtime、Drive I/O 限制](https://research.google.com/colaboratory/faq.html)
- [官方 runtime 版本：2026.07 為 Python 3.12.13；2026.10 為 Python 3.13.18](https://research.google.com/colaboratory/runtime-version-faq.html)

上述版本依 2026-11-10 查閱內容，實作與執行時仍需核對。
