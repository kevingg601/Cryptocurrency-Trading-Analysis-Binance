# 四模型選幣與 K 線預測基準

VS Code 連接 Colab A100 的 Notebook 入口與資料包操作方式見 [使用說明](../../COLAB_MODEL_BENCHMARK_USAGE.md)。Notebook 可保留遠端 Python 3.13 核心，程式另準備 Python 3.12 模型環境。Windows 入口仍可使用下列方式執行。

此流程在固定 v3 資料上依序微調／訓練 CatBoost Ranker、XGBoost Ranker、Chronos-2 與 TimesFM 2.5。排序模型使用 CPU；時序模型優先使用可用 CUDA，OOM 後在新的 attempt 以 CPU 重試。各模型使用獨立 Python 環境，runner 不載入所有模型套件。

## 一行啟動

在 PowerShell 執行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\PYTHON\fadachi\scripts\run-model-benchmark.ps1"
```

第一次啟動會準備 `.benchmark-envs\` 環境、安裝鎖定套件並下載鎖定權重。各環境／模型的成功或失敗獨立記錄；準備部分失敗時仍會執行其他可用模型。這個實驗不設總執行時限，不能保證隔天前完成。請接上電源並避免手動休眠。

其他參數：

```powershell
# 建立新的 run，不沿用未完成結果
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\PYTHON\fadachi\scripts\run-model-benchmark.ps1" -NewRun

# 指定 data\model-benchmark\runs 底下的 run 目錄
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\PYTHON\fadachi\scripts\run-model-benchmark.ps1" -RunDir "D:\PYTHON\fadachi\data\model-benchmark\runs\<run-id>"

# 小型真實 adapter smoke；產生 PARTIAL 狀態，不等同完整比較
powershell -NoProfile -ExecutionPolicy Bypass -File "D:\PYTHON\fadachi\scripts\run-model-benchmark.ps1" -Smoke
```

成功 run 再執行同一命令時會驗證模型與報告雜湊，然後直接顯示 `comparison.md`。runner 只會續跑 source、設定、程式、環境及權重身份完全一致的未完成 run；若身份改變，會建立新的 run，不會把新環境接到舊 checkpoint。使用 OS 持有的獨占鎖避免同時啟動；程序結束或異常終止後鎖會自動釋放。Ranker 已完成候選可在身份一致時沿用；時序模型依 adapter 驗證可用檢查點，若沒有 optimizer 狀態就從預訓練權重開始新的 attempt，不宣稱逐 optimizer step 恢復。CUDA OOM CPU 重試使用新 attempt，保留 adapter 可驗證的訓練狀態。

## 固定資料與方法

- 來源只讀：`data-reruns\20261110-004810\model-research`，開始時核對 v3 manifest 及 klines、funding、panel 三個 Parquet 的 SHA256。
- Binance USDT 永續合約；不重新選幣或改資料期間。沿用 120/30/30 天 TRAIN/VAL/TEST 及 v3 funding/cost 欄位。
- 30 個特徵由既有 `research.model_research.features_and_labels.FEATURE_COLUMNS` 指定；候選／超參數只用 TRAIN/VAL 選擇。
- Rankers 使用四組參數候選、多空兩個方向、seed 42、learning rate 0.05、最多 1,000 輪、每 25 輪驗證；以共用 linear-gain NDCG@5 選擇。
- 時序模型使用固定官方模型身分、256 根已收盤小時 close 預測未來 4 根，LoRA rank 8、alpha 16、dropout 0.05；最多 2,000 optimizer updates、每 100 更新驗證，以 VAL 報酬 MAE 選 checkpoint。
- 完整共同比較清單取 TEST 每日 UTC 00:00 決策點，要求 256 根連續小時資料、資料列合格及至少 10 幣完整群組。凍結清單目前由來源產生 29 個時間點、580 個幣種／時間 pair。Smoke 只保留前兩個完整午夜群組。
- 預訓練與微調後的時序模型預測使用相同 cohort，分別報告；另附價格不變與 4 小時動能基準。排序模型不計算預測 MAE。
- 既有 LightGBM 權重在固定共同清單上重新推論並核對檔案 hash。既有 Kronos 數值只作歷史參考，輸入及 cohort 未核實前不混入本次共同樣本。
- 這是已查看過 TEST 的既有資料研究比較，不是新的獨立測試；當前幣種回溯含存活偏差。重疊預測窗不累加為帳戶報酬。

## 輸出位置

每次 run 在 `data\model-benchmark\runs\<run-id>\` 建立獨立目錄，包含：

- `comparison.md`、`comparison.csv`、`comparison.json`
- `run_manifest.json`、凍結 `common_cohort.json`
- 各模型的 attempt、模型／adapter、預測、來源雜湊、訓練 metadata 與日誌
- `baselines\lightgbm_common_predictions.parquet`

`SUCCESS` 表示四個模型均實際訓練／微調、由新程序重新載入推論，且在共同比較樣本完成評估。部分模型失敗為 `PARTIAL`；沒有模型成功為 `FAILED`。非 `SUCCESS` 會以非零 exit code 結束，失敗原因保留在 manifest 及逐模型 log。
