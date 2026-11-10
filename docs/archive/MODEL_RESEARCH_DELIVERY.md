# 模型選幣研究（LightGBM 排名 + Kronos 預測）交付說明與驗證報告

## 第三輪複查修正（2026-11-10）

**最終狀態：三項缺陷及後續 CLI／鎖清理問題已修正，獨立 reviewer 精準複查通過。這是程式修正驗收，不代表正式模型與績效已依 v3 重算。**

針對 `features_and_labels.py`、`offline_eval.py` 與模型訓練覆寫風險修正如下：

- 離線 Kronos 評估不再自動重用舊預測快取；每次評估都重新跑模型。若要保留既有評估檔，使用 `evaluate --output-dir <new-directory>` 指向新輸出目錄。此次未執行離線 GPU 評估。
- 資金費淨報酬改按各結算的 `funding_rate × mark_price / entry_price` 計算；實際持有期間結算缺少有效 mark price 時，該筆淨報酬標為缺失並排除。研究資料及 LightGBM 標籤 pipeline 升為 v3；舊 v2 資料／模型可供既有推論查閱，但會警告其結果未反映 v3 成本標籤。訓練需先準備 v3 資料與新的模型目錄。
- LightGBM 訓練拒絕使用非空輸出目錄；可用 `train-lgbm --output-dir <new-empty-directory>` 指定新模型目錄。評估若要使用新模型目錄，請將 `--data-dir` 設為包含同一份資料集、`models/` 與 `weights/` 的獨立研究根目錄，避免替換正式模型。
- 新增測試涵蓋結算 mark 價換算、缺 mark 排除、拒絕覆寫與舊預測快取觸發新推論。完整 Python 測試套件於中途版本 26/26 通過；最後調整後重新執行受影響測試 4/4 通過，並在改成行為測試後 cache 測試 1/1 通過。離線 GPU 評估、正式模型重訓與資料集更新均未執行。
- 後續 CLI 路徑與鎖清理複查補上 `verify-kronos`、`evaluate --output-dir` 與訓練失敗釋放鎖的行為測試，該組受影響測試 3/3 通過；CLI 離線評估仍未實際執行。
- 最後鎖擁有權修正：只在獨占建立成功後標記 `lock_acquired`，集中於 `finally` 清理一次。針對訓練失敗、取得鎖前資料錯誤、競態保留其他程序鎖的測試為 **3 passed、29 deselected**；reviewer 唯讀複查通過。最終 32 項未再全套重跑，上述各批針對性測試不可加總成全套驗收數。
- 主代理另執行 `node --experimental-strip-types --test apps/collector/test/modelResearch.test.ts`，**2/2 通過**。本輪未重跑全專案 Node 測試或前端建置；前次審查的全專案測試曾有本機 socket `EACCES` 與 lifecycle timeout，不能將本輪專測通過稱為全專案通過。
- 修正前後核對六份正式產物 SHA256 均一致：`models/lgbm_long_ranker.txt`、`models/lgbm_short_ranker.txt`、`models/lgbm_metadata.json`、`datasets/dataset_manifest.json`、`datasets/research_panel.parquet`、`evaluation/offline_comparison.json`（皆位於 `data/model-research/`）。沒有重建正式資料、重訓或重新執行 GPU 評估；既有數值不可當作 v3 修正後績效。
- 依使用者要求，未進行瀏覽器、畫面與互動驗證。

## 0. 第二輪 Codex 審查與修正（2026-11-09）

**第二輪程式修正與非瀏覽器驗證已完成；第一輪模型與離線績效尚未依修正後規則重建。下方第 1～6 節的實測數字是第一輪歷史紀錄，不能當作第二輪修正後的評估結果。**

本輪直接審查並修正，未啟動 planner、Boost、子代理、外部 AI 或任何瀏覽器。所有檔案查閱、Python 執行與測試暫存均限制於本專案；Python 使用 `D:\PYTHON\fadachi\.venv\Scripts\python.exe`。專案及本次來源子目錄未找到額外的 `AGENTS.md`，依本次提供的全域規範與任務契約執行。未執行 Git 操作，未變更 `reviews/**` 或任何既有資料、權重、模型、評估與推論結果檔。

### 0.1 有依據的缺陷與修正

以下行號為本輪交付版本。P1 表示影響資料隔離、成本正確性或既有結果保存；P2 表示影響狀態、協定、邊界或可重現性。

| 嚴重度 | 位置 | 觸發條件、影響及最小修正 |
|---|---|---|
| P1 | `research/model_research/features_and_labels.py:748` | 原先只有 `exit_time > split_end` 才排除，等於邊界時仍讀取下一切分的開盤價。改為 `>=`。現有 train、val 各有 20 筆此類合格樣本；test 另 20 筆原已因缺退出價而不合格。 |
| P1 | `research/model_research/features_and_labels.py:653` | 固定 8h 完整性檢查漏掉 1h／4h 結算缺失，且單側觀測不足以證明零成本。改採持有區間附近觀測到的最短 1h／4h／8h 間隔保守檢查；無區間內預期結算時，必須同時具有前後邊界覆蓋。缺失樣本淨報酬維持 NaN。 |
| P1 | `research/model_research/features_and_labels.py:671` | 將實際結算先取整到分鐘，會把 entry+1ms 排除、exit+1ms 納入。現在只以取整時間檢查排程，費用加總按實際毫秒時間套用 `(entry_time, exit_time]`，保持多頭扣正費、空頭收正費與雙邊 20 bps 成本。 |
| P1 | `research/model_research/worker.py:155`、`:410` | 重複或帶路徑的 run ID 原可刪除／覆寫既有目錄。現在驗證單一 `run-...` 名稱，拒絕既有目錄，移除刪除舊 run 的行為；新完整輸出仍使用 staging 後 rename 提交。 |
| P2 | `research/model_research/lightgbm_ranker.py:190` | early stopping 的預設指數 relevance gain 與 sklearn 網格選模／報告的線性 gain 不一致。明訂 `label_gain=[0,1,2,3,4]` 並保存於新 metadata。載入 LightGBM 時也核對實際檔案 SHA256，避免 metadata 冒稱另一模型。 |
| P2 | `research/model_research/worker.py:160`、`:294` | 無指定 cutoff 時沒有排除時鐘以後的資料；全部候選都缺 256 根窗口時卻回報 SUCCESS。現在預設截止於目前時間、拒絕未來 cutoff；全無預測改為 INSUFFICIENT_DATA，不更新最近成功指標檔。 |
| P2 | `apps/collector/src/research/modelResearchRunner.ts:138`、`:445` | 超時後在作業系統尚未關閉 worker 前就釋放鎖。現在直到子程序 close 才釋放推論鎖，期間仍拒絕新推論；終止作業狀態包含資料不足亦持久化，重啟後可以查詢。 |
| P2 | `apps/collector/src/research/modelResearchRunner.ts:175`、`:393`、`:457` | 原回傳只驗證 runId 是字串，損壞的持久化結果仍可能被判成成功，重複終止協定訊息可覆蓋錯誤，UTF-8 跨 chunk 可能損壞中文。Worker 與磁碟結果共用身分、狀態、時間及主要集合結構檢查，拒絕重複或未知終止訊息，改用 StringDecoder。API 同時拒絕未來 cutoff。 |
| P2 | `packages/core/src/research/researchTypes.ts:364`、`apps/web/src/components/ModelResearchCenter.tsx:372` | 真實 status 的 configured 是彙總旗標，缺模型時會先被判成 UNCONFIGURED；面板又硬編 futures。改按 Python、資料與所選模型分別判定，傳入實際市場，保留失敗／資料不足與過期優先處理。 |
| P2 | `research/model_research/offline_eval.py:270` | 空共同樣本仍載入 GPU、第一組超出 max_pairs 仍執行，以及無午夜決策時靜默改成另一時點。現在先驗證非空且至少 10 幣的完整 UTC 00:00 群組，嚴守總筆數上限，無合格群組就明確失敗。small 通過後才執行 base 的順序保留。 |
| P2 | `research/model_research/features_and_labels.py:140`、`:324`、`data_prep.py:435`、`research/requirements.txt:5` | 非有限數值與超出高低範圍的 OHLC 原可通過清理；完全無下載資料時 concat 直接失敗；requirements 未固定 torch。現在剔除無效 OHLCV，空資料仍產出完整缺口報告，固定 `torch==2.6.0+cu126`。 |

### 0.2 既有產物的唯讀查核與限制

- 三份資料 Parquet 的實際 SHA256 均與 dataset manifest 一致；多空 LightGBM 與 Kronos-small／base 權重 SHA256 亦與 metadata／revision manifest 一致。Tokenizer 實際 SHA256 為 `59d85f6af76a2c3b8240ea06cb21db4213b4eeca053f246b23e29cf832fc6bee`，與紀錄相符。這證明檔案身分相符，不表示舊標籤方法正確。
- manifest 的暖機起點是 `1777680000000`，研究起點是 `1778630400000`，相差 **264 小時（11 天）**。實際 `klines_1h.parquet` 是 **86,400 列（20 × 4,320 小時）**，最早時間卻等於研究起點，**暖機列數為 0**。第一輪第 2 節「192 天／12 天暖機」的描述與 manifest、實際資料均不符；本輪保留原始紀錄，明確更正為此查核結果。現有準備程式會保留暖機，舊快取則明確拒絕視為新版資料。
- 對現有 86,400 列進行記憶體內重算，**新增 60 列切分邊界旗標、105 列資金費完整性不足，11,472 列資金費加總改變**。105 列代表依保守規則無法證明完整，不能據此宣稱交易所確實遺失 105 次結算。這些數量是全 panel 的差異，並非只計測試集或 580 筆共同樣本。
- 新版資料記錄 `pipelineVersion=2`，新訓練 metadata 記錄 `pipeline_version=2`。舊資料不會被 prepare-data 靜默重用來宣稱修正完成，train-lgbm／evaluate 會拒絕舊版標籤／模型；一般研究推論仍可讀取舊模型，但 status、結果 warnings 與面板會明示舊版限制。
- **尚未重建新版資料、重訓或重跑 GPU／580 組評估**；本輪授權要求保留既有產物且不啟動長時間訓練／全量下載。因此第 4 節原 NDCG、Top5 淨績效、MAE、方向率與比較結論均僅為第一輪紀錄，未以第二輪程式重新驗證。不能直接沿用為新版模型結論。
- 資金費排程完整性目前由附近歷史結算推定，排程變更處會保守排除；若需證明所有結算都完整，仍需帶版本的歷史排程來源。不能僅由稀疏紀錄保證從未遺漏整段結算。
- 目前資料是離線快照；POST 不回補資料。面板過期提示已說明單純重跑不會更新 K 線。單邊 5 bps 費用 + 5 bps 滑價、多空相反資金費方向、排名非勝率、衝突標記、最多 6 幣 sequential Kronos、固定 256→4／5 次抽樣、small 先於 base 的程式規則均保留。未接入交易、未產生累積淨值曲線。

### 0.3 實際驗證結果

Python 測試的暫存與 cache 都指定於 `research/model_research/`，沒有使用全域 Python 或專案外暫存。初始既有測試為 **7 passed**；修正後為 **15 passed，0 warnings（17.28 秒）**：

```powershell
$env:PYTHONIOENCODING='utf-8'
$env:PYTHONUTF8='1'
$env:TEMP='D:\PYTHON\fadachi\research\model_research\.test-tmp'
$env:TMP=$env:TEMP
.\.venv\Scripts\python.exe -m pytest research/tests/test_model_research.py -o cache_dir=research/model_research/.pytest_cache --basetemp=research/model_research/.test-tmp/final
```

其他結果：

| 指令／查核 | 實際結果 |
|---|---|
| `npm.cmd test` | **301 passed、0 failed**（最終 6.02 秒）；含本輪 worker/API、UTF-8 切塊、錯誤結構、磁碟結果損壞與指標路徑、重複協定、資料不足重啟持久化、延遲 close 並行鎖及面板狀態回歸。第一次新增測試錯把既有 schema 接受的數字字串視為非法，已改以非整數邊界測試並通過。 |
| `npm.cmd run lint` | 原樣執行遇既有根目錄 `.pytest_cache` 的 `EPERM scandir`，未改權限或修改設定。 |
| `npm.cmd run lint -- --ignore-pattern .pytest_cache --ignore-pattern .venv --ignore-pattern research --ignore-pattern reviews` | **exit 0，0 errors／0 warnings**；排除權限阻礙、Python 環境／研究暫存與本輪排除目錄，其餘既有 JS／TS lint 正常執行。 |
| `npm.cmd run build` | **exit 0**，core／collector 型別檢查與 web TypeScript／Vite 建置通過，web dist 已同步。保留 Vite 大於 500 kB chunk 的非阻擋警告。 |
| 真實本機 `handle_status` 唯讀查核 | `.venv` Python 3.12.14、torch 2.6.0+cu126、LightGBM 4.6.0、RTX 4050 Laptop GPU；資料與三個模型元件存在，並回傳舊版 artifact warning。未載入模型執行新的 GPU 預測。 |

測試包含合成資料的小型 Ranker 訓練、mock worker 與 Fastify inject；**不代表實際 GPU 推論、模型修正後績效或瀏覽器驗收通過**。後續若要數值重驗，應另行授權，以新的 `--data-dir` 隔離建立資料、模型與評估輸出，保留第一輪目錄；本輪未執行此工作。

**依使用者要求，未進行瀏覽器、畫面與互動驗證。** 人工可檢查：現貨提示與停用推論、缺模型／資料不足與舊版警告、兩榜衝突標記、預測圖與抽樣離散程度、失敗與過期提示。第 6 節原人工清單亦保留，沒有將建置成功宣稱為畫面驗收成功。

---

## 1. 環境與硬體規格

- **GPU 硬體**：`NVIDIA GeForce RTX 4050 Laptop GPU`（總顯存 `6140.5 MiB` / `6141 MiB`，CUDA UMD `13.4`）
- **Python 虛擬環境**：專案內獨立環境 `D:\PYTHON\fadachi\.venv\Scripts\python.exe`（`Python 3.12.14`）
- **固定依賴版本**：詳見 [`research/requirements.txt`](file:///d:/PYTHON/fadachi/research/requirements.txt)
  - `torch==2.6.0+cu126`
  - `lightgbm==4.6.0`
  - `duckdb==1.2.1`
  - `pandas==2.2.3`、`pyarrow==19.0.1`、`numpy==2.2.3`、`scipy==1.15.2`、`scikit-learn==1.6.1`
  - `einops==0.8.1`、`huggingface_hub==0.33.1`、`safetensors==0.5.3`
  - `requests==2.32.3`、`tqdm==4.67.1`、`pytest==8.3.5`

### 環境安裝命令

```powershell
# 於專案根目錄 D:\PYTHON\fadachi 執行
.\.venv\Scripts\python.exe -m pip install --extra-index-url https://download.pytorch.org/whl/cu126 -r research/requirements.txt
```

---

## 2. 資料準備、訓練、驗證、離線評估與推論命令

> **重要原則**：啟動 Node Collector 或桌面／網頁應用時，**不會**自動安裝套件、下載權重、回補研究資料或訓練模型。所有研究資料與權重均透過下列明確 CLI 命令離線準備。

| 步驟 | 命令 | 規模與資源預估 | 實測耗時 |
|---|---|---|---|
| **1. 準備研究資料集** | `.\.venv\Scripts\python.exe -m research.model_research.cli --data-dir data prepare-data` | 20 幣 USDT 永續 × 192 天（含 12 天暖機 + 180 天研究期 `120d/30d/30d`）1h K 線與資金費率，Parquet 約 `5 MB` | ~36 秒 |
| **2. 下載 Kronos 權重** | `.\.venv\Scripts\python.exe -m research.model_research.cli --data-dir data download-weights --model all` | 下載 `Kronos-Tokenizer-base` (~20 MB)、`Kronos-small` (~99 MB)、`Kronos-base` (~409 MB) 至 `data/model-research/weights/` | ~27 秒 |
| **3. 訓練 LightGBM** | `.\.venv\Scripts\python.exe -m research.model_research.cli --data-dir data train-lgbm` | CPU 訓練多空雙 `LGBMRanker`，4 組超參數網格 (`num_leaves={15,31}` × `min_child_samples={50,100}`)，依驗證集 `NDCG@5` 選模 | ~36 秒 |
| **4. 單幣 GPU 驗證** | `.\.venv\Scripts\python.exe -m research.model_research.cli --data-dir data verify-kronos --symbol BTCUSDT` | 先驗證 `Kronos-small` 通過後再驗證 `Kronos-base`（256 根輸入預測 4 根，`sample_count=5`） | ~18 秒 |
| **5. 離線公平比較** | `.\.venv\Scripts\python.exe -m research.model_research.cli --data-dir data evaluate --max-pairs 600` | 測試集每日 `UTC 00:00` 共同有效時點（29 個時點 × 20 幣 = 580 組），比較 LightGBM、Kronos-small、Kronos-base 與雙基準 | ~238 秒 |
| **6. 單次研究推論** | `.\.venv\Scripts\python.exe -m research.model_research.cli --data-dir data infer --model small --run-id run-initial-small` | 全合格幣種 LightGBM 排名 + 多空各 Top 3 去重後最多 6 幣 Kronos 推論，原子寫入 `data/model-research/<run-id>/` | ~7 秒 |

---

## 3. 資料與模型 Manifest 及 SHA256 摘要

- **資料集 Manifest（v2 正式版）**：[`data/model-research/datasets/dataset_manifest.json`](file:///d:/PYTHON/fadachi/data/model-research/datasets/dataset_manifest.json)（第一輪 v1 備份保留於 `data/model-research/archive-v1/`）
  - `pipelineVersion`: `2`
  - `datasetVersion`: `ds-1794182400000-09f7474bc8`
  - `klines_1h.parquet` SHA256: `09f7474bc8866d3fe632617045573ec89002a4e1a541cc4b363932a05613c2a9`（共 `91,680` 列 = 20 幣 × 4,584 小時，含完整 264 小時暖機 + 4,320 小時研究期）
  - `funding_rates.parquet` SHA256: `7549b2c98a09d0257ab0dae2be328b12d6efb320740c8d8d2c49aa2037e9143d`（共 `15,408` 列）
  - `research_panel.parquet` SHA256: `180f9def5909addad7cd9d72a5f43709cd5bf61a8f5424b3a0a3f30eecd0476c`（共 `91,680` 列）
  - 切分規模（含 `exit_time >= split_end` 邊界排除與資金費完整性檢查）：
    - 訓練集（120 天）：`2,875` 個合格排名小時（`57,480` 筆合格標的／時點），跨切分邊界排除 `100` 筆、缺資金費排除 `20` 筆
    - 驗證集（30 天）：`715` 個合格排名小時（`14,258` 筆合格標的／時點），跨切分邊界排除 `100` 筆、缺資金費排除 `42` 筆
    - 測試集（30 天）：`715` 個合格排名小時（`14,269` 筆合格標的／時點），跨切分邊界排除 `100` 筆、缺資金費排除 `31` 筆
- **LightGBM 模型 Metadata（v2 正式版）**：[`data/model-research/models/lgbm_metadata.json`](file:///d:/PYTHON/fadachi/data/model-research/models/lgbm_metadata.json)
  - `lgbm_long_ranker.txt` SHA256: `0453e31014c5a4e40e4b333337c9202102bfea50aa9e526f8859616e8da156df`（選中參數：`num_leaves=31, min_child_samples=100, best_iteration=43`，Val `NDCG@5 = 0.5185`）
  - `lgbm_short_ranker.txt` SHA256: `09c81f709d71f4e32083b829a0099e7bc3eb4a91b3856529257c9af7946138c3`（選中參數：`num_leaves=15, min_child_samples=50, best_iteration=45`，Val `NDCG@5 = 0.5361`）
- **Kronos 官方預訓練權重**：
  - `NeoQuasar/Kronos-Tokenizer-base` Revision: `0e0117387f39004a9016484a186a908917e22426`, SHA256: `59d85f6af76a2c3b8240ea06cb21db4213b4eeca053f246b23e29cf832fc6bee`
  - `NeoQuasar/Kronos-small` Revision: `901c26c1332695a2a8f243eb2f37243a37bea320`, SHA256: `b082dfcbd8e8c142a725c8bbb99781802f38fec81210e13479effb32b3c3e020`
  - `NeoQuasar/Kronos-base` Revision: `2b554741eca47781b64468546e77fef3e85130e6`, SHA256: `abff193acab6db1a0368e9773e75799d11403b6d054ee6d5f0a11aeabc5f4b83`
- **比較輸出檔案**：
  - Markdown 報告：[`data/model-research/evaluation/offline_comparison_report.md`](file:///d:/PYTHON/fadachi/data/model-research/evaluation/offline_comparison_report.md)
  - CSV 表格：[`data/model-research/evaluation/offline_comparison.csv`](file:///d:/PYTHON/fadachi/data/model-research/evaluation/offline_comparison.csv)
  - JSON 結構：[`data/model-research/evaluation/offline_comparison.json`](file:///d:/PYTHON/fadachi/data/model-research/evaluation/offline_comparison.json)
  - 推論結果：[`data/model-research/run-v2-latest/result.json`](file:///d:/PYTHON/fadachi/data/model-research/run-v2-latest/result.json)、[`data/model-research/run-v2-latest/manifest.json`](file:///d:/PYTHON/fadachi/data/model-research/run-v2-latest/manifest.json)（舊版 `run-initial-small` 亦完整保留）

---

## 4. 實測比較結果摘要（v2 修正後如實交付）

### 4.1 單幣實際 GPU 推論驗證（BTCUSDT，256 根預測 4 根，`sample_count=5`）

| 模型 | Revision | 權重載入耗時 (ms) | 單幣推論耗時 (ms) | 峰值分配顯存 (MiB) | 峰值保留顯存 (MiB) |
|---|---|---:|---:|---:|---:|
| `Kronos-small` | `901c26c13326` | 674.9 | 899.5 | 154.55 | 176.00 |
| `Kronos-base` | `2b554741eca4` | 1620.9 | 271.9 | 477.19 | 534.00 |

### 4.2 測試集未來第 4 根收盤報酬預測誤差（580 組每日 UTC 00:00 共同樣本）

| 模型／基準 | 樣本數 | 未來第 4 根收盤報酬 MAE | 方向命中率 | 總耗時 (ms) | 單筆平均耗時 (ms) | 峰值分配顯存 (MiB) |
|---|---:|---:|---:|---:|---:|---:|
| `Kronos-small` | 580 | 0.017513 | 49.04% | 68,980.2 | 105.3 | 154.93 |
| `Kronos-base` | 580 | 0.017532 | 51.30% | 149,611.0 | 243.0 | 479.93 |
| `價格不變基準 (0 報酬)` | 580 | **0.015979** | 0.00% | - | - | - |
| `過去 4 小時動能基準` | 580 | 0.024588 | **51.83%** | - | - | - |

### 4.3 跨模型同時間同標的排名比較（29 個測試集每日 UTC 00:00 共同時點，v2 管線）

| 模型 | 未來 4h 收盤 Spearman IC | 多頭 NDCG@5 | 多頭 Top5 平均淨報酬 | 多頭 Top5 正淨報酬率 | 空頭 NDCG@5 | 空頭 Top5 平均淨報酬 | 空頭 Top5 正淨報酬率 |
|---|---:|---:|---:|---:|---:|---:|---:|
| `LightGBM Ranker (v2)` | +0.0547 | 0.5389 | -0.534% | 37.24% | **0.5651** | **+0.097%** | **52.41%** |
| `Kronos-small` | +0.0575 | **0.5653** | -0.164% | 40.69% | 0.5385 | -0.010% | 47.59% |
| `Kronos-base` | **+0.0970** | 0.5380 | **-0.156%** | 42.76% | 0.5444 | +0.083% | 46.90% |
| `過去 4h 動能基準` | -0.0391 | 0.4815 | -0.319% | **44.14%** | 0.5232 | +0.049% | 46.21% |

> **客觀結論**：
> - 在 4 小時收盤報酬 MAE 上，`Kronos-small` (`0.017513`) 與 `Kronos-base` (`0.017532`) 雖優於過去 4h 動能基準 (`0.024588`)，但**未優於「價格不變（0 報酬）」基準 (`0.015979`)**。
> - 在橫截面排序上，修正 v2 暖機與線性 `label_gain` 後，`LightGBM Ranker` 空頭 `NDCG@5` (`0.5651`)、空頭淨報酬 Spearman IC (`+0.1611`) 與空頭 Top 5 正淨報酬率 (`52.41%`) 表現最佳；`Kronos-base` 的未來 4h 收盤 Spearman IC (`+0.0970`) 最高。惟扣除單邊 5 bps 手續費 + 5 bps 滑價（雙邊 20 bps）與資金費後，各模型多頭 Top 5 平均淨報酬仍為負、空頭 Top 5 平均淨報酬僅約 `+0.08% ~ +0.10%`，**整體不具直接實盤獲利顯著性，依規範如實呈現，不宣稱模型有效，亦不升級為交易訊號**。

---

## 5. 研究限制與未完成事項

1. **存活與事後選擇偏差（Survivorship & Selection Bias）**：標的清單係依準備資料當下之 24 小時成交額選取前 20 檔可交易 USDT 永續合約，屬於「目前可交易幣種的歷史試驗」，不得稱為歷史全市場驗證。
2. **Kronos 預訓練資料重疊未知**：官方 `Kronos-small` / `Kronos-base` 預訓練權重之訓練期間與幣種重疊情況未知，不可宣稱為完全獨立的樣本外驗證。
3. **成本假設與不產生淨值曲線**：固定採用 1x 槓桿、單邊 5 bps 手續費、單邊 5 bps 不利滑價與持有期間實際資金費結算；第一版不將重疊的 4 小時視窗累加為模擬帳戶淨值曲線。
4. **第一版不微調與不接入交易**：第一版僅使用 Kronos 官方預訓練權重（未做微調），且與下單模組、A/B 模擬交易、`AIAnalysisResult` 及 CLI 配額完全隔離。

---

## 6. 前端「模型選幣研究」面板人工檢查清單（未進行瀏覽器自動驗證）

依使用者要求，本次實作未啟動瀏覽器進行畫面與互動驗證。人工驗收時請依序檢查下列項目：

1. **面板切換與現貨模式阻擋**：
   - 於頂部導覽切換至「模型選幣研究」分頁。
   - 當右上角市場切換為「現貨 (Spot)」時，面板應顯示「此功能僅支援 Binance USDT 永續合約研究」提示與「切換至 USDT 永續合約模式」按鈕。
2. **多空 Top 5 排名榜與衝突標記**：
   - 切換至「合約 (Futures)」後，檢查左側多頭 Top 5 與空頭 Top 5 表格是否顯示「排名分數（非勝率／非預期報酬）」、多空各自名次、截止時間（UTC），以及同時進入兩榜時的「多空排名衝突」徽章。
3. **歷史 K 線與 Kronos 未來 4 根預測圖**：
   - 點選多空 Top 3 候選幣種（如 `BTCUSDT`、`DOGEUSDT` 等），確認 SVG 預測 K 線圖（`KronosForecastSvgChart`）顯示最近 64 根已收盤 1h K 線、未來 4 根 Kronos 平均預測 K 線，以及標示為「抽樣離散程度（5 次抽樣範圍，非校準信賴區間）」的上下界陰影與表格。
4. **Kronos-small / Kronos-base 切換與手動執行**：
   - 預設選取 `Kronos-small`；切換至 `Kronos-base` 並點擊「執行模型選幣與預測」，確認按鈕進入載入中狀態，且並行點擊時不會重複啟動多個推論程序。
5. **離線比較報告與狀態橫幅**：
   - 檢查下方「Kronos-small vs Kronos-base 離線公平比較報告」表格是否完整呈現單幣驗證耗時、峰值顯存、MAE、方向命中率、跨模型 `NDCG@5` 與四大研究限制聲明。
   - 驗證過期狀態（超過下一個小時截止點時顯示 `EXPIRED` 橫幅）與錯誤提示橫幅是否正常渲染。
