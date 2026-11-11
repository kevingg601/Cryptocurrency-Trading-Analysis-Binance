# Chronos-2 微調模型接入

在「模型選幣研究」選擇「Chronos-2 微調版」，按「手動執行推論」。沿用 LightGBM 多空排名，只對多空各 Top 3 去重後最多六個幣種進行預測。既有 Kronos-small/base 仍可選。

輸入是截止時間以前連續 256 根已收盤 1h 收盤價，輸出為未來四個小時的收盤價中位數。圖表顯示收盤價路徑，不生成預測 OHLC 或信賴區間；不送出交易訂單。

## 已部署版本

- 訓練 run：`colab-2ac72155a17a4a91-full`
- 基礎模型：`amazon/chronos-2`
- revision：`29ec3766d36d6f73f0696f85560a422f50e8498c`
- adapter SHA256：`d6109703d67a1f56b6ab1d31e648d25f9caea123ba42862966804b4bb3e5d3a3`
- 部署位置：`data/model-research/models/chronos2/`
- 基礎權重：`.benchmark-cache/models/chronos2/`
- 獨立推論環境：`.benchmark-envs/chronos/`

主 worker 繼續使用 `.venv`，Chronos 透過獨立子程序執行，以免改動既有 Kronos 環境。CUDA 可用時使用 GPU，否則使用 CPU；不因 OOM 自動更換模型。推論離線載入本機權重，不安裝、不下載、不訓練。狀態檢查會核對 adapter 和基礎模型的 SHA256；套件實際載入錯誤由推論工作回報。

## 新電腦／更新權重

GitHub 只保存程式，不含本機環境、權重與 Colab 結果。需先按既有 benchmark 流程準備 Chronos 環境與鎖定基礎模型，再匯入成功的全量訓練 ZIP：

```powershell
.\.venv\Scripts\python.exe -m research.model_research.chronos_runner import <結果ZIP路徑> data
```

匯入會驗證訓練基礎模型版本、adapter 檔案雜湊與 LoRA rank，並保留來源 run ID 和 ZIP SHA256。已存在的部署目錄拒絕覆寫；更新前先將既有部署移到明確備份位置。

## 驗證紀錄與限制

2026-11-11 實際呼叫 Python research worker，使用本機保存資料的截止時間 `1794182400000`，產生 `run-chronos2-integration-1794371663`，狀態 SUCCESS。KOMAUSDT、ONEUSDT、JCTUSDT、HOTUSDT、ICNTUSDT、NEARUSDT 各有四個有效預測收盤價。這是本機 GPU 載入與資料串接驗證，不是新增行情或獨立績效測試。

手動推論（未指定 cutoffTime）會先從 Binance 公開 API 更新固定研究標的最近 320 根已收盤 1h 行情及最近 8 天資金費率，再計算特徵、排名與模型預測。輸入另存 data/model-research/live-inputs/<run-id>/，含資料檔雜湊；不修改訓練／測試資料。任何標的最新收盤資料不足、256 根窗口有缺口或網路下載失敗時明確報錯，不退回舊資料。明確指定 cutoffTime 時仍使用歷史研究資料，以供重現。

「結果已過期」表示該次結果的資料時間已超過下一小時截止點，不代表模型權重失效。請重新按手動推論更新行情；有效期不因按下按鈕而被人為延長。

更新流程已實際連線驗證：`run-chronos2-live-1794387338` 成功下載最新行情並完成六個幣種預測，cutoffTime=`1794384000000`、expiresAt=`1794387600000`。此次新增最新小時、窗口缺口、網路失敗及原始資料保留測試；Python 研究／部署／即時輸入測試共 39 項通過（66.23 秒），前端建置與 ESLint 通過。尚未進行畫面互動驗證。

API/runner 與介面狀態的非瀏覽器測試 5 項通過；Python 研究流程與部署完整性測試共 35 項通過（66.21 秒）。變更檔案 ESLint、Python 語法檢查、TypeScript 與 Vite 建置均通過；建置仍有大型 chunk 提示。Collector 實際狀態回傳 configured=true、pythonAvailable=true、chronos2.installed=true。未進行瀏覽器、畫面與互動驗證；尚未更新桌面封裝或推送 GitHub。
