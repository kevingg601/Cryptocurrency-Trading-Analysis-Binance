第二輪審查完成，已修正兩項實質缺陷：

- **P1 因果性**：同分鐘的未來資金費紀錄會移除較早已知結算。改為先依決策時間篩選，再去重，嚴格排除 `decision_time + 1ms`。
- **P1 缺值處理**：資金費缺失原本補零或排除整列。改為保留 NaN 供 LightGBM 推論，輸出時省略缺失的 optional 欄位，確保 JSON 合法。

4h／24h 趨勢的收盤邊界與公式測試通過；前端 optional 型別及缺值顯示無需修改。

驗證：**Python 23 passed、Node 301 passed、lint／build 通過**。建置僅有 Vite chunk 大小警告。

完整問題位置、修正與指令紀錄見[繁體中文審查報告](D:/PYTHON/fadachi/research/model_research/ROUND2_FEATURE_REVIEW_20261109.md)。

未覆寫正式模型或結果，未重新訓練及更新正式推論，因此不宣稱命中率改善。依使用者要求，未進行瀏覽器、畫面與互動驗證。