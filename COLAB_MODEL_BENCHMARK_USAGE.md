# 在 VS Code 連接 Colab T4 執行四模型訓練

Notebook：`notebooks/model_benchmark_colab.ipynb`。

使用同一份 v3 Binance USDT 永續合約資料，依序執行 CatBoost、XGBoost、Chronos-2、TimesFM 2.5，再產生共同樣本比較。前兩者維持 CPU，後兩者使用 CUDA LoRA 微調。資料切分、成本與訓練設定沿用既有研究流程。

## 1. 準備 Notebook 與資料包

交付資料包位置：`data/model-benchmark/colab/fadachi-colab-bundle.zip`。若程式或資料有更新，在本機專案目錄重新封裝：

```powershell
.\.venv\Scripts\python.exe -m research.model_benchmark.bundle create --output data/model-benchmark/colab/fadachi-colab-bundle.zip
```

在 VS Code 開啟本機 `.ipynb`，選取 Colab T4 遠端核心。將新版 ZIP 放到遠端 `/content/fadachi-colab-bundle.zip`，或 Google Drive，例如 `MyDrive/fadachi/fadachi-colab-bundle.zip`。ZIP 只包含白名單程式、精確依賴鎖、v3 資料及 LightGBM 基準；大型預訓練權重會依固定 revision 與 SHA256 下載。

上傳至 `/content` 時使用 Colab 擴充功能的遠端檔案區；本機 VS Code 工作區中的 `D:\...` 與遠端 `/content` 是不同檔案系統。若資料包已在 Drive，直接設定該 Drive 路徑即可。[官方使用指南](https://github.com/googlecolab/colab-vscode/wiki/User-Guide#activity-bar)

`BUNDLE_ZIP_PATH` 指的是遠端核心能讀取的檔案路徑，不是 Windows 的 `D:\...`。新版使用實體檔案路徑，不以瀏覽器上傳／下載 widget 作為必要入口。本次新增獨立 Python 準備程式，Notebook 與 ZIP 都需要使用新版。

## 2. 選擇執行環境

保留 VS Code 目前連接的 Colab Python 3.13 核心即可，也支援 3.12 核心。Notebook 會檢查實際 GPU 與磁碟，並在專案快取內準備固定 Python 3.12，使用它建立三個模型環境與執行訓練；不更換 VS Code 核心、不修改系統 Python 或原 `.venv`。下載的 Python 來源、release 與 SHA256 都有固定資產鎖。

核心 Python 版本與模型訓練 Python 版本會分開記錄。模型環境仍沿用原 Python 3.12 精確依賴鎖；模型身分由實際訓練程序計算。

Google Drive 若尚未掛載，可在 VS Code 按 `Ctrl+Shift+P`，執行 `Colab: Mount Google Drive to Server...` 並完成授權。已掛載時 Notebook 會直接使用。[官方擴充功能說明](https://github.com/googlecolab/colab-vscode)

Colab 不保證 A100 可用或固定執行時長；選項與配額依帳戶及當時供應而定。[官方 FAQ](https://research.google.com/colaboratory/faq.html)、[runtime 版本說明](https://research.google.com/colaboratory/runtime-version-faq.html)。

## 3. 修改 Notebook 設定並執行

在設定 cell 指定：

```python
BUNDLE_ZIP_PATH = "/content/fadachi-colab-bundle.zip"
DRIVE_OUTPUT_DIR = "/content/drive/MyDrive/fadachi/model-benchmark"
MODE = "full"  # "smoke" 只做小型真實訓練驗證
RUN_SMOKE_BEFORE_FULL = False  # 正式模式不額外先跑四模型 smoke
RESTORE_SESSION_ID = None
RESTORE_RUN_ID = None
REQUIRE_A100 = False  # 允許目前分配的 T4，仍要求 CUDA 可用
```

在 VS Code 由上到下執行。`full` 模式預設直接執行正式規格，不額外先跑四模型 smoke。只有明確選 `MODE = "smoke"` 或 `RUN_SMOKE_BEFORE_FULL = True` 才會啟動小型訓練；正式訓練中必要的 VAL 選模仍保留。

程式、資料、環境及訓練小檔在 `/content/fadachi-benchmark-<ZIP hash 前綴>` 路徑使用，同一個 ZIP 使用相同工作根目錄；成果以已提交快照保存到設定的 Drive 目錄。全程需保持 Colab runtime 可用，不需要本機 RTX 4050 參與運算。

## 4. 看結果

Notebook 會顯示 session／run 位置、真實狀態與報告。正式 run 的主要產物為：

- `comparison.md`：比較表與限制。
- `comparison.csv`、`comparison.json`：數值資料。
- `run_manifest.json`：逐模型訓練、重新載入、評估與失敗紀錄。
- 各模型權重／adapter、最佳設定、訓練 metadata、預測與日誌。

正式 `SUCCESS` 要求四模型訓練／微調、獨立程序重新載入與共同評估通過。`PARTIAL` 或 `FAILED` 必須查看個別失敗原因；`SMOKE_ONLY` 表示僅完成小型驗證，不可據此選出最強模型。

若 CUDA OOM，保留原流程以新 attempt 改用 CPU 重試的政策，報告會記錄實際裝置。CPU 階段可能很慢，也可能遇上 Colab session 時限；不能將其耗時直接當成 A100 性能。

## 5. Colab 中斷後

若第 5 格出現 `stage event log ended with an incomplete JSONL record`，先保留目前 kernel 與 `/content`。更新 Notebook 的第 5 與 5A 格程式，不必重新上傳 ZIP 或重跑第 1～4 格。在同一 kernel 新增並執行一格 `RUN_RECOVERY = True`，再執行 5A；此格只檢查既有 smoke 狀態並補存成功結果，不會訓練。若顯示 smoke 失敗，先查看列出的模型錯誤與日誌。補存完成後執行 `RUN_RECOVERY = False`，再執行更新後第 5 格；`MODE = "full"`、`RUN_SMOKE_BEFORE_FULL = False` 會進入正式訓練，不額外重跑成功的 smoke。不要按「全部執行」來處理這次恢復。

重新連接相容 runtime、掛載 Drive，使用同一 ZIP 與輸出目錄，將 `RESTORE_SESSION_ID` 和 `RESTORE_RUN_ID` 同時設為之前顯示的 session／run ID，再由上到下執行。恢復只接受有 `COMMITTED` 標記且 hash 通過的快照；新 session 使用獨立命名空間，保留原快照。

可沿用已保存且驗證通過的完整模型／候選階段。未完成的時序微調可能建立新 attempt 重訓；本版不承諾恢復每一個 optimizer step，也不能保證保存 runtime 終止前最後一刻的進度。Windows 舊 run 不直接接續至 Linux。

## 驗證邊界

本機驗證紀錄另見交付文件。沒有真正 Colab A100／T4 執行紀錄時，不把本機 RTX 4050、語法檢查或 mock 測試當成 Colab 驗證。依使用者節省額度要求，smoke 不再是正式模式必要的前置流程。

完整交付驗證紀錄見 [Colab 交付紀錄](COLAB_MODEL_BENCHMARK_DELIVERY.md)。

報告屬於已查看過 TEST 的既有資料研究比較，不能當成新的獨立測試或實盤獲利證據。

## 舊版上傳按鈕失效或一直等待

若出現 `Upload widget is only available ... current browser session`，代表目前這個上傳元件需要在本次瀏覽器工作階段重新建立，程式正在等待選檔。

1. 按該 cell 的停止按鈕。
2. 重新執行同一格，重新建立上傳元件。
3. 按「選擇檔案」，選取 `fadachi-colab-bundle.zip`，等上傳完成。

也可先把 ZIP 放到 Drive，將 `BUNDLE_ZIP_PATH` 設為該檔案的完整路徑，再重跑設定與資料格，即可直接讀取現有檔案。

目前的 VS Code 版本改用實體檔案路徑讀取 ZIP。請更新 Notebook 與資料包，在設定格填入遠端 `/content` 或 Drive 路徑，再依序執行。
