# 第二輪審查與修正報告

日期：2026-10-29。工作目錄：`D:\PYTHON\fadachi`。

依本次「Codex Review & Fix」授權直接審查與修正，未啟動 planner、Boost、子代理、Skill、其他 AI CLI 或外部 AI。依執行環境指示不使用 Git，比對依據為修改前讀取的來源與新增回歸測試；下方 diff 是關鍵片段，不是 Git 完整差異。

## 1. 具體發現與處理

| 編號 | 嚴重度 | 模組與觸發條件 | 影響及修正 |
| --- | --- | --- | --- |
| F01 | Critical | Parquet COPY 與 DELETE 之間寫入較早時間的 REST 成交 | 原本依同一時間門檻刪除，可能刪到尚未匯出的新資料。改為固定暫存表快照，僅刪除已匯出的主鍵；完成 COPY 後才發布封存檔。已測試在 COPY 後插入較早成交仍保留於熱庫。 |
| F02 | Major | 同一分區多次封存、REST 重疊或 COPY 後中斷重試 | 原本固定預設檔名與 `OVERWRITE_OR_IGNORE` 不適合累積封存，且熱冷 `UNION ALL` 重複計數。改為 UUID 檔名追加、同一 Client 封存依序執行，讀取依 `(market,symbol,agg_id)` 去重。已測試多次封存與 API 成交／重播／統計／覆蓋率一致。 |
| F03 | Major | Writer 正在 flush 時收到 stop 或另一個 flush | 原本直接回傳 0，關閉流程可能提早關閉 DB；成功成交批次也可能因後續 K 線失敗而整批重新排隊。改為等待進行中的 flush 並排空後續佇列；已成功成交不再重新排隊，成交統計計算實際新增筆數。 |
| F04 | Major | DuckDB 關閉後立即重開檔案，或查過 Parquet 後刪除測試目錄 | 原本只關 Database，未關 Connection；安裝的 `duckdb@1.4.4` 原生 `FinishTask::DoWork()` 又未實作 statement reset，`finalize()` 成功不代表釋放檔案鎖。初版回歸測試實際發生檔案鎖與 EPERM。保留既有非同步 Client 操作介面，將原生執行隔離至 Worker，等待 connection/database close 及 Worker 結束。修正後立即重開與清理測試通過。未修改第三方套件。 |
| F05 | Major | Electron `utilityProcess` 啟動及關閉 Collector | Collector 原本僅使用 `process.send`／`process.on('message')`，與 utilityProcess 的 `process.parentPort` 不符。新增雙 IPC 介面；關閉等待背景工作、HTTP、Writer、封存、Session、DB 完成。失敗不再一律回報成功；Desktop 提早退出會立即 reject，重複 quit 仍攔截，等待子行程退出後才結束。 |
| F06 | Major | 重複 start、停止後舊 socket 回呼、靜默分片、慢速 live client | 原本可能留下多個 watchdog、讓舊 close 回呼刪掉新 socket，或使慢客戶端累積 send buffer。補 start 防重、socket 身分檢查、靜默分片回收、計時器清理；LiveHub 對超過 1 MiB 緩衝的 client 斷線，關閉時 terminate 並清空參照。新連線也取得最近的市場串流狀態。 |
| F07 | Major | 舊／重複 Trade ID、同時初始化、重啟時熱庫已封存、缺口寫入失敗 | 原本游標會倒退、初始化錯誤被吞掉，且只讀熱庫。改為逐交易對依序檢查、只向前推進、缺口成功落庫後才移動游標；初始化讀熱冷資料並恢復 open gaps。已測試重啟、舊 ID、初始化競爭及落庫失敗。 |
| F08 | Major | 缺口超過 1,000 筆、REST 短頁／429、資料仍在寫入佇列 | 原本只抓一頁便標記 backfilled，且暫時失敗直接標 unrecoverable。改為逐頁驗證連續 ID／K 線時間、寫入 flush 完成才標記成功；部分或暫時失敗維持 open，並合併同一缺口的重複工作。實際回歸案例補齊 1,504 筆，使用兩個 REST fixture 分頁。 |
| F09 | Major | DuckDB BIGINT 綁定、API JSON、數值型交易計算 | 原本 bigint 參數直接轉 Number，server 另全域修改 BigInt.prototype，可能悄悄捨入。改為參數以十進位字串綁定；結果在安全範圍內轉數字，超出範圍保留字串。交易 timestamp／lastTradeId 超出安全範圍時明確拒絕運算。已測試 `9007199254740993` 完整保留，且不改全域 prototype。 |
| F10 | Major | 無效 market／interval／時間／limit／寫入 body，或非信任網頁 Origin | 原本欠缺 schema，無效 interval 靜默變成 1h，任意 Origin 被允許。補 Fastify schema、時間順序檢查與 localhost Origin 限制；HTTP 使用 Bearer，query token 僅供 WebSocket upgrade。原有缺少／錯誤 Token 攔截正常，回歸仍通過。允許 Unicode 交易對，避免誤拒合法幣種。 |
| F11 | Major | `/live` WebSocket upgrade | 實際回歸測試發現 500：路由建立早於 websocket plugin 的 onRoute hook。改於後續 Fastify plugin 註冊路由。以 Node WebSocket client 驗證授權握手與服務關閉，未使用瀏覽器。 |
| F12 | Major | Stores 收到異常成功回應、Collector 斷線，或舊請求晚到 | DataCenter 可把非陣列與 null 列寫入 state，引發 render crash；錯誤多只寫 console，過期請求也可能覆蓋新選擇。補回應檢查、各操作錯誤狀態與畫面提示、請求版本及重播重設；Market Store 有 fallback。 |
| F13 | Major | 切換紙上帳戶市場、離線載入、快速連續儲存 | 原本可能把前一市場的帳戶當作已載入，儲存失敗全被吞掉，HTTP 寫入亦可能亂序。加入市場／載入狀態隔離、過期回應保護與儲存錯誤，Client 依市場依序儲存。此保護限同一 Client；未加入跨視窗版本鎖。 |
| F14 | Major | 主畫面切換市場／交易對後開啟 DataCenter | DataCenter 原本讀取尚未同步的獨立 Market Store 預設值，可能仍查 futures/BTCUSDT。改由 App 傳入目前 marketType／selectedSymbol。 |
| F15 | Minor | 缺口已成功回補後再 replay | 原本仍把所有 gaps 傳入重播而略過已補齊範圍。改為只傳入未 backfilled 的缺口，並明確轉換時間型別。 |

F01–F15 已有對應修正。並非所有項目都有完整外部環境測試，驗證界線見第 4 節。

## 2. 主要程式差異與檔案

### 寫入與封存

修改：`src/storage/writer.ts`、`src/storage/parquetFlush.ts`。

```diff
- if (this.isFlushing) return { tradesWritten: 0, klinesWritten: 0 };
+ if (this.activeFlush) return this.activeFlush.then(() => this.flush());
+ // stop 等待完成並持續排空佇列

- ON CONFLICT DO NOTHING;
+ ON CONFLICT DO NOTHING RETURNING agg_id;

- COPY (SELECT ... FROM agg_trades WHERE trade_time < cutoff)
- ... OVERWRITE_OR_IGNORE;
- DELETE FROM agg_trades WHERE trade_time < cutoff;
+ CREATE TEMP TABLE snapshot AS SELECT ... WHERE trade_time < cutoff;
+ COPY (SELECT ... FROM snapshot) TO staging (... APPEND, FILENAME_PATTERN 'part_{uuid}');
+ // 封閉檔案後移入可讀分區
+ DELETE FROM agg_trades USING snapshot WHERE 主鍵一致;
```

K 線 upsert 另防止非 final 舊更新覆蓋已 final 的累積資料。`tradeSource()` 統一處理 Windows 斜線、SQL 單引號與熱冷主鍵去重；原始封存內容不做破壞性重寫。

### DuckDB 資源及整數

修改：`src/storage/duckdb.ts`。新增：`src/storage/duckdbNative.ts`、`src/storage/duckdbWorker.ts`。

```diff
- params.map(p => typeof p === 'bigint' ? Number(p) : p)
- db.close(callback)
+ params.map(p => typeof p === 'bigint' ? p.toString() : p)
+ // 查詢回應：安全整數為 number，超界為十進位 string
+ conn.close(... db.close(...))
+ // Client.close() 最後等待 worker.terminate()
```

移除 server 的 `BigInt.prototype.toJSON` 全域補丁。原生 db／conn 不再暴露給主執行緒；搜尋確認目前 Collector 呼叫端未使用這兩個原生欄位。Worker 對完整操作排隊，錯誤會回傳且可繼續查詢，關閉開始後拒絕新查詢。

### 缺口及回補

修改：`src/gaps/gapDetector.ts`、`src/gaps/restBackfill.ts`、`src/binance/rest.ts`。

```diff
- this.lastTradePerSymbol.set(symbol, { agg_id: aggId, trade_time: tradeTime });
+ if (last && aggId <= last.agg_id) return null;
+ // 同一 symbol 依序檢查；持久化成功才更新游標

- fetchHistoricalAggTrades(..., Math.min(1000, gapLength));
- await detector.markResolved(gap.id, 'backfilled');
- // 失敗一律標成 unrecoverable
+ while (next <= end) { /* 驗證連續頁面並 await writer.flush() */ }
+ await detector.markResolved(gap.id, 'backfilled');
+ // 部分結果、HTTP 錯誤或中止：維持 open，允許重試
```

REST 支援 AbortSignal 與超時；API 與 Collector 關閉會中止回補。不同市場的手動回補使用各自 GapDetector。

### Collector、WebSocket、Desktop

修改：`src/main.ts`、`src/binance/streams.ts`、`src/live/hub.ts`、`../desktop/main.cjs`。新增：`src/ipc.ts`。

```diff
- if (process.send) process.send({ type: 'ready', ... });
+ // utilityProcess: parentPort.postMessage；child_process: process.send
+ ipc.send({ type: 'ready', port: actualPort });

- await writer.stop(); await parquetFlush(); await db.close();
- // 即使出錯也 flushed / exit(0)
+ // 停來源 → 關 HTTP/WS → 等背景工作 → drain Writer → 封存 → 關 Session/DB
+ // 所有清理仍會嘗試；失敗回覆 shutdown-error 並 exit(1)

- if (isQuitting || !collectorProcess) return;
+ if (!collectorProcess) return;
+ e.preventDefault();
+ if (isQuitting) return;
```

Desktop 啟動 timeout 為 30 秒；shutdown timeout 亦為 30 秒，超時會明確記錄未確認 flush，終止子行程並以非零狀態退出。這是有界等待，並非保證任意大小資料在 30 秒內完成。

### HTTP API

修改：`src/api/server.ts`。新增：`src/api/validation.ts`。

```diff
- app.register(cors, { origin: true });
- const bucketMs = intervalMsMap[interval] || 3600000;
+ // localhost Origin / token 邊界與各路由 schema
+ // 無效 interval、market、limit、body 或 from > to 回 400

- app.register(websocket);
- app.get('/live', { websocket: true }, handler);
+ app.register(websocket);
+ app.register(async routes => { routes.get('/live', { websocket: true }, handler); });

- SELECT ... FROM hot UNION ALL SELECT ... FROM parquet;
+ SELECT ... FROM tradeSource(dataDir); // 每個 aggregate ID 一筆
```

### Stores、Client 與 DataCenter

修改：`../web/src/api/collectorClient.ts`、`../web/src/stores/dataCenterStore.ts`、`../web/src/stores/marketStore.ts`、`../web/src/stores/paperStore.ts`、`../web/src/features/data/DataCenter.tsx`、`../web/src/App.tsx`。

```diff
- set({ summary }); // 直接接受任何回應
- catch { set({ isLoading: false }); }
+ // 驗證 shape 與顯示欄位，只有最新請求可發布 state
+ // 失敗保留可讀錯誤，DataCenter 以 role="alert" 提示

- catch { set({ loaded: true }); } // 可能沿用前一市場
+ // 換市場先隔離資料；載入失敗不宣告帳戶已就緒

- collectorClient.savePaperAccount(...).catch(() => {});
+ // 同一 Client 每個市場依序儲存，失敗進入 error state

- <DataCenter />
+ <DataCenter marketType={marketType} selectedSymbol={selectedSymbol} />
```

Client HTTP 預設 15 秒超時；WebSocket 重連會重新訂閱目前交易對，忽略過時 socket 回呼。Collector 連線建立本身先標 connecting，交易所健康狀態由伺服端訊息決定。

`alertStore.ts` 僅有同步且有上限的 state 操作，未發現需要修改的網路生命週期問題，零修改。`packages/core/**` 本輪零修改。

### 測試及命令

新增：`test/reviewRegression.test.ts`、`test/lifecycle.test.ts`、`../web/test/stores.test.ts`、`../desktop/test/lifecycle.test.cjs`。根目錄 `package.json` 僅擴充 `npm test`，納入 Web Store／Client 與 Desktop 的原生 Node 測試；沒有安裝依賴或更改 lockfile。

## 3. 驗證指令與證據

| 指令 | 最終結果 | 證據 |
| --- | --- | --- |
| `cmd /c npm test` | Exit 0；240 tests、240 pass、0 fail、0 skipped；3976.0606 ms | [npm-test.txt](review-evidence/npm-test.txt) |
| `cmd /c npm run lint` | Exit 0；沒有 lint 診斷 | [npm-lint.txt](review-evidence/npm-lint.txt) |
| `cmd /c npm run build` | Exit 0；Core／Collector 型別檢查及 Web 型別檢查／Vite build 通過 | [npm-build.txt](review-evidence/npm-build.txt) |
| `cmd /c npm run test:collector` | 最後一次 30 tests、30 pass、0 fail | 完整整合執行亦包含這 30 項，見 npm-test.txt |
| `cmd /c node --experimental-strip-types --test apps/web/test/*.test.ts` | 8 tests、8 pass、0 fail | 完整整合執行亦包含這 8 項 |
| `cmd /c node --check apps/desktop/main.cjs` | Exit 0 | Desktop VM 測試另外讀取與解析同一主程式 |

基線為 207 項（Core 199、Collector 8）；最終為 Core 199、Collector 30、Web 8、Desktop 3，共新增 33 項。`npm test` 可自然退出，未使用 `--test-force-exit`。

Vite 仍有單一 chunk 超過 500 kB 的非致命警告，主 chunk 約 557.74 kB；未進行無關拆包重構。測試中的 429 警告為預期失敗 fixture，用來驗證缺口維持 open。

完整行程測試只啟動 Node Collector，REST 使用空 spot universe fixture，無 Binance 外連及交易所 WebSocket；本機 HTTP 與 Node WebSocket 測試不啟動瀏覽器。Desktop 測試使用 VM 與 Electron API 替身，未開啟 Electron 視窗。

## 4. 略過、限制與交接差異

- **依使用者要求，未進行瀏覽器、畫面與互動驗證。** 未使用 CUA、DOM、截圖、Playwright、CDP 或其他 UI 自動化。建置通過不代表畫面驗收通過。
- 未啟動實際 Electron UI，也未驗證 portable 安裝包、Electron 內的原生 addon／Worker 相容性與真實 utilityProcess 往返；IPC adapter、Desktop 流程及 Node Collector 行程已有非 UI 測試。
- 未對 Binance 進行長時間連線、真實限流／斷線／分片壓力測試，未執行數小時高頻收集、TB 級 Parquet 查詢、磁碟耗盡、作業系統強制斷電或跨視窗同時寫帳戶測試。Worker 隔離的長期吞吐與記憶體表現亦未做負載基準。
- 封存採完整檔案發布及主鍵刪除，重複封存由讀取端去重；未宣稱具備斷電級 fsync／跨檔案系統交易保證。Worker 關閉可釋放原生鎖，不代表已證明第三方 binding 在長時間運行中完全無記憶體成長。
- **交接描述與實碼差異（待後續範圍確認）：** App 仍保留多數行情、紙上帳戶 state 與既有 hooks；Market／Paper／Alert Stores 尚未全面接入主流程。DataCenter 已接 Store，本輪修正其選擇來源。依「不推翻架構／不進行無依據重寫」限制，本輪未把此工作擴大為完整前端遷移；不能宣稱全站已改由 Collector／Zustand 驅動。
- 未修改 `.git/**`、`.gitignore`、`artifacts/**` 或工作區以外檔案，未修改規範檔。建置產物位於允許範圍的 `apps/web/dist/**`。
- 自動核准審查兩次阻擋清理下列早期失敗測試目錄，工具只回報 `blocked by policy`，故未繞過，目錄仍保留於 `apps/collector/test/`：`.review-lock-4Q2Q1J`、`.review-lock-a1cxnt`、`.review-quote'-4FT49a`、`.review-quote'-Aw1Gqp`、`.review-quote'-L8wDd1`、`.review-quote'-qlyNE9`、`.review-quote'-xeWcSC`、`.review-quote'-yU15U1`。最終回歸測試建立的臨時資料可正常清理。
