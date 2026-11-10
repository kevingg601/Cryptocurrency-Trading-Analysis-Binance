# AI 分析與 A/B 對照獨立審查

日期：2026-10-30（Asia/Taipei）

## 結論

**尚未通過完整計畫驗收。** 既有 260 項測試、lint 與正式建置均通過，但正式 CLI 仍無可啟用的 adapter，桌面 ZIP 不含目前的 Collector／共用核心，且新增邊界重播找到下列功能缺陷。

審查依據為專案根目錄 `AI_ANALYSIS_AB_IMPLEMENTATION_PLAN.md` 與當前 workspace 原始碼，不以先前修正報告或建置成功取代功能驗收。本次未修改受審程式、測試或設定，只新增本審查文件。依執行環境要求未使用 Git；比對以實際內容及檔案雜湊為準。

## 具體問題

### F01 / P1：缺口或不合法 OHLC 仍通過必要資料檢查

- 位置：[aiSnapshot.ts:154](/D:/PYTHON/fadachi/packages/core/src/ai/aiSnapshot.ts:154)。
- 觸發：保留足夠筆數，但必要指標視窗內 K 線不連續；或 open／high 等欄位不是有限有效價格。目前只檢查每根 close、volume 及總筆數。
- 證據：獨立 reviewer 離線重播「29 根前一天資料＋1 根新資料」，實際 aggregator 仍回傳 `essentialDataValid=true`；NaN open／high 也未被拒絕。
- 影響：過去資料缺口可被最新一根 K 線掩蓋，AI 篩選可能使用不完整的技術指標，違反必要資料缺漏時拒絕的要求。
- 修正：驗證必要視窗的時間連續、排序、重複、收盤狀態及完整 OHLC／量能合法性；缺口須標為必要資料不完整，加入 aggregator 到 gate 的回歸測試。

### F02 / P1：第二個頁面的恢復流程可中斷仍在執行的批次

- 位置：[useAutoTrading.ts:154](/D:/PYTHON/fadachi/apps/web/src/hooks/useAutoTrading.ts:154)、[server.ts:653](/D:/PYTHON/fadachi/apps/collector/src/api/server.ts:653)。
- 觸發：同一 Collector 被第二個頁面開啟。載入歷史時，任何活動批次都立即 `restoreInterrupted` 並寫回，未先確認原 writer 是否仍活著；API 只檢查 revision 遞增，沒有 writer 身分或 fencing。
- 證據：主代理用 Fastify `inject`、記憶體 DuckDB 與真實協調器重播。原 writer 保存 RUNNING 回 200；第二個 client 讀取後恢復為 INTERRUPTED，保存也回 200；原 writer 仍 RUNNING，但下一次保存回 409，`currentRevision=4`。
- 影響：單純開第二頁就會污染活動狀態，原頁面的保存錯誤處理再中斷整對評估；現有 revision 測試不等於單一寫入者保護。
- 修正：新增 writer ownership／有效租約與 generation fencing。只有確定 owner 已失效時才恢復為中斷；第二頁預設唯讀，不能以較高 revision 接管活動批次。加入雙 client／存活 owner／失效 owner 測試。

### F03 / P1：逐幣排程與每日額度不相容

- 位置：[aiScheduler.ts:63](/D:/PYTHON/fadachi/apps/collector/src/ai/aiScheduler.ts:63)。
- 觸發：十個幣種均有有效資料，排程每十五分鐘對每個幣分別 `runAnalysis`，並非計畫要求的一次合併分析。
- 證據：reviewer 假 provider 重播十幣，產生十次呼叫。理想快速回覆且無其他事件時，啟動後約 3.5 小時即觸及 144 次每日上限，而非可涵蓋一天的 96 次定時工作。
- 影響：後續分析停更、B 陸續因過期而不再進場；此結果會混入評估，不能只解釋成 AI 篩選能力。
- 修正：一次快照集合、一次 CLI 請求、一次額度計數，輸出覆蓋固定追蹤清單；測試十幣一次更新只計一次呼叫。

### F04 / P2：分析清單、市場與模型未採用批次設定

- 位置：[main.ts:74](/D:/PYTHON/fadachi/apps/collector/src/main.ts:74)、[aiScheduler.ts:68](/D:/PYTHON/fadachi/apps/collector/src/ai/aiScheduler.ts:68)、[server.ts:526](/D:/PYTHON/fadachi/apps/collector/src/api/server.ts:526)。
- 觸發：使用者選非 universe 前十的關注幣、選現貨，或選非 `gemini-2.5-flash` 模型。排程固定 futures、universe 前十及固定模型；狀態 API 又只回 universe 前十的最新分析。
- 影響：即使未來啟用 provider，使用者選定清單與模型仍可能沒有自動分析，B 因無結果／版本錯配被擋，不是有效的模型比較。
- 修正：以批次鎖定設定作為排程與狀態 API 的共同來源，明確涵蓋市場、清單、模型、提示版本；補測現貨、非前十關注幣及另一個模型。

### F05 / P2：重啟可重置每日額度與事件限制

- 位置：[cliRunner.ts:36](/D:/PYTHON/fadachi/apps/collector/src/ai/cliRunner.ts:36)。
- 觸發：重建 runner 或重啟 Collector。呼叫數、重置時間、事件紀錄與冷卻只有記憶體狀態。
- 證據：reviewer 在同一資料 client 用滿 144 次後重建 runner，使用量歸零，第 145 次假 provider 呼叫成功。
- 影響：無法遵守跨重啟的每日上限與滾動事件限制。
- 修正：持久化呼叫帳本，定義計數日界線並在啟動時重建滾動時間窗；失敗與逾時呼叫的計數規則也需一致。補重啟與併發測試。

### F06 / P2：過期快取及空鏈上指標被當成來源可用

- 位置：[rssNews.ts:114](/D:/PYTHON/fadachi/apps/collector/src/ai/sources/rssNews.ts:114)、[coinMetrics.ts:40](/D:/PYTHON/fadachi/apps/collector/src/ai/sources/coinMetrics.ts:40)、[aiSnapshot.ts:175](/D:/PYTHON/fadachi/packages/core/src/ai/aiSnapshot.ts:175)。
- 觸發：來源更新失敗卻仍有舊快取，或鏈上回傳物件但所需指標皆為 null。
- 證據：reviewer 以假時鐘重播 72 小時來源斷線，news／onChain 仍可標成 true；空指標物件也未揭露缺漏。
- 影響：UI 與 AI 快照把「存在舊資料」誤當「來源健康且有覆蓋」，分析降級狀態不可信。
- 修正：保存來源最後成功／嘗試時間、錯誤、資料事件時間及指標覆蓋；依資料本身頻率判定 stale／missing，不能只看陣列或物件非空。

### F07 / P2：錯誤的模型輸出被補值成有效方向分析

- 位置：[aiOutputValidator.ts:89](/D:/PYTHON/fadachi/packages/core/src/ai/aiOutputValidator.ts:89)。
- 觸發：方向是 LONG／SHORT，但信心無效、證據／risks 型別錯誤、理由缺失。目前分別補信心 60、空陣列與「無詳細說明」。
- 證據：reviewer 重播 object 證據、數字 risks 的 LONG 回覆，仍成功轉成有效分析。
- 影響：Schema 不合格結果可成為 B 的方向許可，缺乏可追溯證據；「使用 JSON」並不等於完成結構驗證。
- 修正：對必要欄位、型別、範圍與字串長度執行嚴格驗證；錯誤回覆標成 INVALID，不得保存為有效方向分析。合法的空證據情境與觀望輸出另定明確規則。

### F08 / P2：RSS 五分鐘更新及新聞事件沒有正式排程

- 位置：[rssNews.ts:75](/D:/PYTHON/fadachi/apps/collector/src/ai/sources/rssNews.ts:75)、[aiDataAggregator.ts:97](/D:/PYTHON/fadachi/apps/collector/src/ai/aiDataAggregator.ts:97)。
- 觸發：沒有手動更新或行情事件。五分鐘只是一個快取 TTL，實際取用是在十五分鐘分析工作中。
- 影響：不能達成規格中的每五分鐘新聞更新，也沒有以新重大新聞去重觸發分析的獨立入口。
- 修正：新增受控新聞更新工作，來源成功／失敗皆更新健康紀錄；新事件經重要性規則、去重、冷卻與共同額度後觸發分析。

### F09 / P2：清算快取沒有公開串流入口

- 位置：[binanceDerivatives.ts:56](/D:/PYTHON/fadachi/apps/collector/src/ai/sources/binanceDerivatives.ts:56)、[main.ts:82](/D:/PYTHON/fadachi/apps/collector/src/main.ts:82)。
- 觸發：`allForceOrders` REST 請求失敗，程式回退到 observed buffer；但目前正式訂閱與訊息處理沒有 `forceOrder`，`recordLiquidation` 沒有對應串流接線。
- 影響：現有程式不能宣稱已接入計畫要求的公開觀測清算串流；REST 失敗後空 buffer 也不能解釋為市場沒有清算。
- 修正：接入公開清算串流，維護連線健康、事件時間與觀測限制，區分「沒有觀測到事件」與「來源不可用」。本次未測真實端點，因此不以網路結果推論其當下可用性。

### F10 / P2：短暫斷線期間恢復，協調器與帳戶狀態分裂

- 位置：[abCoordinator.ts:156](/D:/PYTHON/fadachi/packages/core/src/auto/abCoordinator.ts:156)。
- 觸發：先 pause，再在尚未達五秒中斷的 unhealthy 期間 resume。協調器先設 RUNNING，但兩個子引擎因不健康拒絕 resume。
- 證據：主代理直接重播 pause → unhealthy → resume → healthy → tick，結果為 `pair=RUNNING, A=PAUSED, B=PAUSED`。UI 的 ready 每 250ms 更新，不能取代核心的原子狀態保護。
- 影響：顯示執行中卻不再接單，恢復連線後也不會自動修正子引擎狀態。
- 修正：恢復前檢查共同健康，或在兩個子引擎確實恢復後才更新成對狀態；加入上述時序及狀態一致性測試。

### F11 / P2：被 B 擋掉訊號在 A 的部分止盈結果會算錯正負

- 位置：[abCoordinator.ts:481](/D:/PYTHON/fadachi/packages/core/src/auto/abCoordinator.ts:481)。
- 觸發：A 已部分止盈但仍有剩餘持倉。`blockedSignalsInA` 只算剩餘浮動損益減全部入場費，漏掉部分已實現損益、退出費及資金費。
- 證據：主代理以真實引擎重播 106 進場 → 116.5 部分止盈 → 100 估值。回傳 `tradeNetPnlInA=-21.3718608835, tradeWinInA=false`，但含已實現損益及已發生成本的標記結果是 `+14.4647446511`；部分已實現毛損益 `36.03857375`、退出費 `0.201968215375`。
- 影響：核心比較結果把實際標記為正的訊號報成負，可能誤判 AI 是否擋掉虧損機會。此欄位目前由 hook 計算但 UI 未直接採用；不能將它誇大成整體 A 帳戶淨值已被改錯。
- 修正：共用每筆持倉的已實現＋未實現－全部已發生成本計算，並區分持倉估值與已完成勝負；加入 TP1、資金費與退出費測試。

### F12 / P2：A/B 成本未完整時仍無條件標示扣成本淨報酬

- 位置：[AutoTrading.tsx:1586](/D:/PYTHON/fadachi/apps/web/src/components/AutoTrading.tsx:1586)。
- 觸發：A 或 B 的 `fundingStatus` 為 PENDING／ERROR，或仍有不完整持倉。單帳戶已有成本與不完整警示，但 A/B 區塊沒有套用對應狀態，仍顯示「扣成本淨報酬率」與策略差異。
- 影響：使用者可能把尚未核對完整的成本當成最終績效，與計畫要求的完整成本比較不符。
- 修正：A/B 分別顯示資金費及不完整狀態；任一側未完整時，整對差異標成暫估，CSV 同時保存成本核對狀態與共同截止時間。此項為原始碼確認，未做畫面驗證。

## 交付阻擋項（不是要求降低安全保護）

### B01：正式 CLI provider 尚無實作

[cliRunner.ts:292](/D:/PYTHON/fadachi/apps/collector/src/ai/cliRunner.ts:292) 的隔離驗證只對 `mockProvider` 回 true；正式啟動不注入 mock，因此 `/api/ai/trigger` 回 503，A/B 啟動被鎖住。這是正確的 fail-closed 保護，但代表核心 AI 功能尚未交付，不能宣稱 CLI 已串接完成。模型清單亦為程式內固定值，不是已登入帳號的實際可用清單。

需完成可驗證工具拒絕與設定隔離的正式 adapter、模型探查及真實非瀏覽器 smoke test。不能把 `verifyIsolation` 改成固定 true，也不能加入自動核准所有工具，來讓測試或 UI 變綠。

### B02：桌面 ZIP 仍是舊入口，沒有 Collector／共用核心

- 檔案：`D:\PYTHON\fadachi\dist-desktop\AntigravityCrypto-20261030-ai-ab.zip`。
- 主代理直接讀取實際 ASAR 索引：16 個 entries，沒有 Collector、共用 core、目前 `apps/web` 路徑；內部 `main.cjs` 不含 `startCollector`，仍載入舊的 `dist/index.html`。
- ZIP 內的 `resources/app.asar` 與本機對應封裝 ASAR 雜湊相同，排除只是 staging 文件過舊：`698D5455D5D9D6459FED125432F6C7BB1B31ED02E22635C54E5F17F26C372603`。
- 根目錄 [封裝腳本:27](/D:/PYTHON/fadachi/scripts/package-auto-trading.ps1:27) 仍採 root dist／main／package.json 的舊 staging 流程。workspace build 成功不表示這個 ZIP 包含最新功能。
- 修正：以目前 workspace 桌面入口封裝 Collector、共用核心、前端及執行依賴；驗證 ASAR 內容與最新 build，另產生新版檔名並保留現有 ZIP。本次未啟動執行檔。

## 實際驗證結果

| 檢查 | 本次結果 | 限制 |
| --- | --- | --- |
| `npm.cmd test` | 260 通過，0 失敗，0 略過 | 首次受限執行遭本機 socket EACCES；取得非瀏覽器測試權限後重跑通過 |
| `npm.cmd run lint` | 退出碼 0 | 不代表功能完整 |
| `npm.cmd run build` | 退出碼 0 | core、collector、web 通過；主 bundle 578.09 kB 警告仍在 |
| 主代理額外重播 | F02、F10、F11 重現 | inline Node、Fastify inject、記憶體 DuckDB；無瀏覽器，未新增測試檔 |
| reviewer 額外重播 | K 線缺口、Schema 補值、來源過期、逐幣排程與重啟額度問題重現 | 固定樣本、假時鐘／fetch／provider，不是真實 CLI 或市場能力驗證 |
| 封裝檢查 | B02 確認 | 只讀 ASAR、ZIP 與內容雜湊；未開啟桌面 UI |
| 審查期間寫入偵測 | 主代理抽查八個核心檔案前後雜湊一致；reviewer 另查十四個檔案一致 | 未觀察到受審程式持續修改 |

本次新增的邊界重播不包含在既有 260 項測試數內，不應將它們混算成已通過的回歸測試。真實 CLI 登入、模型延遲、外部來源可用性及長期獲利均未驗證。

**依使用者要求，未進行瀏覽器、畫面與互動驗證。** 本次未自動修復以上問題；交回實作者補齊後，再按修正範圍複查及補跑相關回歸。
