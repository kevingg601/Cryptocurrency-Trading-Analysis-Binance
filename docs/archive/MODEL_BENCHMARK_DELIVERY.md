# 四模型夜間訓練流程交付紀錄

交付日期：2026-11-10。工作目錄：`D:\PYTHON\fadachi`。

## 正式執行

在 PowerShell 執行以下一行；不要加入 `-Smoke`，才會執行正式訓練規格：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\PYTHON\fadachi\scripts\run-model-benchmark.ps1"
```

依序準備鎖定環境及權重，訓練 CatBoost／XGBoost 多空排名模型，微調 Chronos-2／TimesFM 2.5，再產生比較報告。未完成時同一行命令依身分核對後續跑；完成後同命令顯示報告。`-NewRun` 可開新實驗，`-RunDir` 可指定舊 run。詳細介面、資料與擴充說明見 [README](../../research/model_benchmark/README.md)。

報告位置：`data/model-benchmark/runs/<run-id>/comparison.md`，同目錄另有 CSV、JSON、manifest、模型與日誌。

資料固定使用 `data-reruns/20261110-004810/model-research` 的 v3 來源。既有資料、模型及績效報告不覆寫；新環境在 `.benchmark-envs/`，權重和下載快取在 `.benchmark-cache/`，不升級原 `.venv`。GPU OOM 時由新程序以 CPU 重試；不設總時限，不保證一夜內完成。接電並避免手動休眠；流程僅暫時抑制自動睡眠。

## 程式範圍

- `scripts/run-model-benchmark.ps1`：正式一行入口、重複啟動 mutex 與暫時睡眠保護。
- `research/model_benchmark/`：環境與資產鎖、adapter registry、四模型 train/save/load/predict、共同資料與評估、順序排程、失敗處理、續跑及報告。
- `research/model_benchmark/process_tree.py`：worker 程序樹生命週期；Windows kill-on-close Job Object。
- `research/model_benchmark/tests/test_core.py`、`research/tests/test_benchmark_ranks.py`、`research/tests/test_benchmark_ts.py`：核心、排名及時序回歸測試。
- `.gitignore`：僅補入新環境、快取、驗證暫存與模組 Python cache 排除。

新增模型可新增 adapter／設定並註冊 `ModelSpec`；runner 的 schema 與資產驗證依 registry 契約處理，不列舉目前四個模型名稱。

## 實際驗證

| 範圍 | 證據與結果 |
| --- | --- |
| Rank adapter 測試 | 最後 5 passed，涵蓋真函式訓練保存、缺值、評分、續跑身分及 smoke cohort 選取。 |
| TS／bootstrap 測試 | 最後 11 passed，涵蓋 split／gap、四步目標、缺 PEFT 拒絕、方向分母、安裝重試及跨程序準備互斥。 |
| 核心測試 | 核心修正後 21 passed；最後 registry-only 調整另執行 3 個受影響測試通過。未將各批重疊測試加總為一次完整驗收數。 |
| 語法 | 新模組 compileall／py_compile 通過；PowerShell AST 在實際回報 7.6.9 的執行環境通過，啟動器為 UTF-8 BOM。未宣稱實測 Windows PowerShell 5.1。 |
| 四模型實際訓練路徑 | CatBoost／XGBoost 完成小型真實 v3 訓練與保存；Chronos-2／TimesFM 2.5 在 RTX 4050 各完成一次 LoRA optimizer update、有效梯度及 adapter 權重改變。 |
| 一鍵整合 | 真實執行 PowerShell 入口 `-Smoke -NewRun`，四模型各自訓練後由新子程序重新載入並預測；四個模型均為 SUCCESS、評估 PASSED、fresh_load=true。 |
| 共同比較與報告 | 40 pairs／2 個 UTC 午夜群組／20 幣；每個必要 variant 缺失數為 0，LightGBM 基準 PASSED，common_error=None；MD／CSV／JSON 均產生。 |
| 保留既有產物 | 來源 manifest、三份資料 Parquet、舊 LightGBM metadata／多空權重、舊比較 JSON，共 8 份檔案修正前後 SHA256 全部一致。 |
| 獨立複查 | reviewer 分段審查並複查修正；最後 registry 補修複查通過，未發現新的具體缺陷。 |

一鍵小型驗證留存於：

`data/model-benchmark/runs/20261109T191637Z-841e9c37/`

該 run 的整體狀態刻意是 `PARTIAL`、`status_reason=SMOKE_ONLY`，不是模型失敗；四模型個別狀態均為 SUCCESS。它不是正式模型性能或獲利比較，不能拿兩個午夜群組的數字判斷哪個模型較強。

上述一鍵驗證先於最後的 registry-only 補修；該補修以受影響測試及獨立複查驗證，沒有再重跑 GPU 訓練。正式命令會使用最終程式身分建立／選取相符 run，不會把不同程式版本接到舊 checkpoint。

## 邊界與未執行事項

- 未啟動正式 1,000 輪候選搜尋／2,000 次 optimizer updates 的整夜訓練；使用者執行上方正式命令後才開始。
- 沒有把 smoke 權重或數值當成正式訓練完成及正式績效；只有正式四模型訓練、重新載入及共同評估全部通過，才是正式 SUCCESS。
- TEST 已被查看，且固定當前幣種清單有存活與選擇偏差；預訓練資料重疊未知。結果不代表新獨立、前向或實盤驗證。
- 排名分數不是勝率；方向命中率不是交易勝率；重疊四小時研究樣本不累加為帳戶報酬。
- 不修改面板、現有 CLI 分析與交易功能；不自動下單。依使用者要求，未進行瀏覽器、畫面與互動驗證。
