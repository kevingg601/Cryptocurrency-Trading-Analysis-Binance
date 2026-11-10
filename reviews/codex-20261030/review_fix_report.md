第二輪審查與修正完成。**測試、lint、建置皆通過，但原計畫尚不能全面驗收通過。**

| 嚴重度 | 觸發條件與影響 | 修正結果與位置 |
|---|---|---|
| P1 | 批次寫入後決策寫入失敗，留下不一致資料；並發請求可覆寫相同 revision | 加入共用連線交易、完整回滾、交易內 revision 檢查及決策不可變保護。[server.ts](/D:/PYTHON/fadachi/apps/collector/src/api/server.ts:650)、[abStorage.ts](/D:/PYTHON/fadachi/apps/collector/src/ai/abStorage.ts:10) |
| P1 | CLI 說明文字包含參數，就被誤認為隔離成功 | 移除這項判定；沒有可驗證隔離實作時強制停用正式 Provider，不啟動 CLI。[cliRunner.ts](/D:/PYTHON/fadachi/apps/collector/src/ai/cliRunner.ts:292) |
| P1 | 亂序成交先消耗決策；晚到分析或不同模型／版本可能取得許可 | 加入時序、取得時間、模型版本及必要資料檢查，保留每次確認只判斷一次。[abCoordinator.ts](/D:/PYTHON/fadachi/packages/core/src/auto/abCoordinator.ts:270) |
| P1 | 成交、持倉與淨值變更未提升協調器 revision，可能漏存 | 同步兩個子引擎 revision，並修正批次及帳戶識別碰撞。[abCoordinator.ts](/D:/PYTHON/fadachi/packages/core/src/auto/abCoordinator.ts:389) |
| P1 | 未收盤或過舊資料進入分析；雜湊未涵蓋完整證據 | 限用已收盤 K 線、檢查必要資料新鮮度與有限值、完整內容雜湊及深複製；保存失敗停止分析。[aiDataAggregator.ts](/D:/PYTHON/fadachi/apps/collector/src/ai/aiDataAggregator.ts:147)、[aiSnapshot.ts](/D:/PYTHON/fadachi/packages/core/src/ai/aiSnapshot.ts:151) |
| P2 | 切換幣種／市場後顯示舊分析，來源健康固定顯示正常 | 加入市場與幣種綁定，健康狀態改讀實際快照；同步鎖定批次設定顯示。[AIAnalysisCenter.tsx](/D:/PYTHON/fadachi/apps/web/src/components/AIAnalysisCenter.tsx:113) |

另修正 AI 覆蓋率誤用許可率、平盤 RSI 回傳 100，以及 CSV 負數被轉成文字的問題；保留公式注入防護。Infinity 往返、相同成交序列、晚到不補進場及退出追蹤均有測試覆蓋。

仍有以下計畫缺口：

- [排程器](/D:/PYTHON/fadachi/apps/collector/src/ai/aiScheduler.ts:60)仍逐幣呼叫固定模型，未完成整份清單合併分析與批次選定清單／模型串接；每日額度目前也未跨重啟保存。
- 第一輪桌面 ASAR **不含 Collector 與共用核心**，使用[舊入口](/D:/PYTHON/fadachi/dist-desktop/20261030-ai-ab/app-staging/main.cjs:17)。封裝腳本與根目錄入口不在本輪可修改範圍，未改動舊 ZIP。
- 真實 CLI 登入、模型清單與外部資料來源未驗證；正式 Provider 維持停用。

最終依序驗證：

- `npm.cmd test`：**260 通過、0 失敗**。
- `npm.cmd run lint`：退出碼 **0**。
- `npm.cmd run build`：退出碼 **0**；僅有 bundle 大小警告。
- [前端建置輸出](/D:/PYTHON/fadachi/apps/web/dist/index.html)已更新，靜態引用的資產均存在。

**依使用者要求，未進行瀏覽器、畫面與互動驗證。**