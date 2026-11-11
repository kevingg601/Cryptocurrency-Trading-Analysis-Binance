# Chronos-2 每小時自動推論與模型虛擬帳戶前向測試（實作規格與設計文件）

> 本文件記錄「Chronos-2 每小時自動推論與雙帳戶前向測試（帳戶 A：LightGBM + Chronos-2 >0.25% 門檻；帳戶 B：LightGBM 基準）」的技術決策、系統架構、演算法、資料表設計與驗證方式。

---

## 0. 核心決策

| # | 決策 |
|---|---|
| D1 | **Chronos-2 adapter 來源**：建立實驗時指定 `data/model-benchmark/runs/<run>` 目錄，預設帶入最新一個 `models.chronos2.status == "SUCCESS"` 且驗證通過的 run。建立時驗證 `artifact_hashes`、`adapter/adapter.sha256.json` 與基礎模型 revision 後鎖定；每輪推論前皆重驗雜湊。 |
| D2 | **必須使用 GPU**：`torch.cuda.is_available()` 為 false 時回傳 `CUDA_UNAVAILABLE`（exit code 3），本輪判定推論失敗，不退回 CPU。 |
| D3 | **固定研究幣種清單**：鎖定 `data/model-research/datasets/dataset_manifest.json` 的 `universe.symbols`，實驗建立時寫入 DB 並固定使用；Collector 啟動時會將該清單併入 Futures `aggTrade` 串流訂閱。 |
| D4 | **0.25% 門檻參考價**：取決策提交當下 Collector 收到的最新 Futures `aggTrade` 價格，需滿足 `tradeTime ≥ H+1h` 且 `now - receivedAt ≤ 5000ms`。不符時，該幣種在帳戶 A 記為 `STALE_REFERENCE_PRICE` 並略過。 |
| D5 | **隔離既有 Kronos 流程**：既有 `handle_run`、`startRunJob`、`/api/research/*`、手動模擬倉（`paperStore` / `paper_accounts`）與 AI A/B（`ab_trading_batches`）完全不受影響；模型前向測試採用獨立表與 `/api/model-paper/*` 路由。 |
| D6 | **Chronos-2 輸入輸出一致性**：每個候選幣種取最近 256 根連續、已收盤 1h 收盤價（原始價格），`prediction_length = 4`，取最接近 `0.5` 的分位數，以第 4 步作為 `predictedClose4h`。 |
| D7 | **每小時單次推論共用快照**：每小時只跑一次 LightGBM + Chronos-2 推論，帳戶 A 與 B 共用同一份決策快照與候選池。 |
| D8 | **文字慣例**：使用者可見 UI 訊息、錯誤提示與狀態說明一律使用繁體中文。 |

---

## 1. 模組與檔案總覽

| 層級 | 位置 | 職責 |
|---|---|---|
| Core 純引擎 | `packages/core/src/modelPaper/types.ts` | 固定參數（`initialCash=10000`, `leverage=1`, `maxPositions=3`, `allocation=0.2`, `stopPct=0.02`, `thresholdPct=0.0025`, `feeRate=0.0005`, `slippageRate=0.0005`, `fillDelayMs=250`, `entryTimeoutMs=60000`, `staleMs=5000`, `retryMs=30000`, `deadlineMs=600000`, `strategyVersion='fwd-v1'`）與型別定義 |
| Core 訊號 | `packages/core/src/modelPaper/signals.ts` | `buildCandidatePool`、`buildSignals`、`sortSignals`（衝突排除、新鮮度、方向與嚴格 >0.25% 門檻） |
| Core 引擎 | `packages/core/src/modelPaper/engine.ts` | 純函式 `reconcile`、`fillSlots`、`applyFill`、`checkStop`、`applyFunding`、`valuate` |
| Core 指標 | `packages/core/src/modelPaper/metrics.ts` | `computeAccountMetrics`（報酬、MDD、勝率、PF、有效觀測時間、略過原因統計）、`evaluateComparability` |
| Python Ranker | `research/model_research/worker.py` | 新增 `forward_rank` action：合併基礎 parquet 與增量 CSV、驗證欄位與收盤時間、`live` 模式嚴格檢查、產出 `rank.json`（不寫入 `latest-run.json`） |
| Python Chronos | `research/model_research/chronos2_live.py` | 於 `.benchmark-envs/chronos` 執行：強制 CUDA、重驗 adapter/revision、組裝 256 根連續收盤價、產出 `chronos.json` |
| Collector 資料庫 | `apps/collector/src/storage/schema.sql` | `model_paper_{experiments,accounts,decisions,orders,fills,positions,funding,equity,gaps,control_requests,leases}` |
| Collector 服務 | `apps/collector/src/modelPaper/*` | `tradeBus.ts`、`store.ts`、`adapters.ts`、`marketCache.ts`、`forwardInference.ts`、`scheduler.ts`、`executor.ts`、`funding.ts`、`service.ts` |
| Collector 串接 | `apps/collector/src/{main,api/server,api/validation,research/modelResearchRunner}.ts` | 併入研究幣種 `aggTrade` 訂閱、轉發至 `TradeBus`、`runExclusive` / `invokeWorkerWith` 共用鎖、`/api/model-paper/*` 路由與驗證 |
| 前端 UI | `apps/web/src/components/ModelPaperPanel.{tsx,css}`、`modelPaperHelpers.ts`、`collectorClient.ts`、`Portfolio.tsx` | 於「虛擬資產帳戶」底部呈現前向測試控制、A/B 績效卡、雙線淨值圖、持倉／成交／決策／歷史紀錄與 CSV/JSON 匯出 |

---

## 2. 每小時流程與狀態機

- **實驗狀態**：`RUNNING` ↔ `PAUSED`、`RUNNING` → `AWAITING_RESUME`（程序重啟或行情/串流中斷恢復）→ `RUNNING`、`{RUNNING, PAUSED, AWAITING_RESUME}` → `STOPPING` → `STOPPED`。`bankrupt` 為帳戶層級旗標（淨值 `≤ 0` 僅該帳戶停新單，實驗維持 `RUNNING`）。
- **排程與去重**：啟動實驗時立即觸發 `H = floor(now/1h)*1h - 1h`；之後每 UTC 整點 +30 秒執行。透過 `model_paper_decisions` 唯一鍵 `(experiment_id, model_key, decision_hour)` 去重。
- **行情快取**：`MarketCacheUpdater` 從 `data/model-research/datasets/klines_1h.parquet` 與 `funding_rates.parquet` 之後增量補齊已收盤 K 線與資金費至 `data/model-paper/market-cache/{klines_1h,funding_rates}.csv`（只追加且以主鍵去重，絕不修改原始 parquet）。
- **失敗與期限**：`BUSY` 或 `DATA_NOT_READY` 標記 `PENDING_RETRY`；`CUDA_UNAVAILABLE`／雜湊不符／`replay` 誤返／timeout 標記 `FAILED`；於 `H + 1h + 10m` 前每 30 秒重試。超過期限則標記 `SKIPPED`（或保留 `FAILED`），且該小時不做任何訊號式開平倉。
- **反手補單**：既有持倉若訊號反轉，先送出 `REVERSED` 平倉單；平倉成交後於同一決策小時且未逾 `H + 1h + 10m` 時由 `onExitFilled` 重新呼叫 `fillSlots` 補單。

---

## 3. 成交、帳務、停損、資金費與中斷保護

- **成交延遲與滑價**：委託建立於 `t0`，僅接受同時滿足 `receivedAt ≥ t0 + 250ms` 且 `tradeTime ≥ t0 + 250ms` 的第一筆 Futures `aggTrade`；以 `(symbol, aggId)` 防重複成交。多開／空平乘 `1.0005`，空開／多平乘 `0.9995`；手續費為成交名目 `0.0005`。入場單逾 60 秒取消（`EXECUTION_FAILED`），出場單持續等待不逾時。
- **固定停損**：`LONG = entryPrice × 0.98`、`SHORT = entryPrice × 1.02`；同向續持不重設停損，觸發後記錄實際成交價格並走 ≥250ms 滑價出場，且該幣種同小時加入 `stoppedThisHour` 不再進場。
- **資金費結算**：每整點 +2 分鐘與每次平倉後查詢 `fetchAutoFundingHistory`，依 `entry.tradeTime < fundingTime` 且尚未平倉之持倉部位以 `settlement_id = positionId:fundingTime` 冪等入帳；中斷期間標記 `during_gap = true`；無法取得已跨過 8 小時結算點資料時設 `funding_pending = true`。
- **過期監控與重啟恢復**：每秒檢查持倉幣種是否逾 5 秒無新成交或 Futures 串流非 `connected`；每 15 秒更新 `model_paper_leases` 與心跳。重啟時保留 `EXIT` 單並取消未成交 `ENTRY` 單，寫入 `PROCESS_RESTART` gap 並轉為 `AWAITING_RESUME`。

---

## 4. 驗證指令

```powershell
npm run test:core
npm run test:collector
npm test
npm run lint
npm run build
.\.venv\Scripts\python.exe -m pytest research/tests/test_forward_infer.py
```
