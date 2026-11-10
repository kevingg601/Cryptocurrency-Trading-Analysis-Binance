# 第二輪審查與修正：資金費率 Z-Score 與 4h／24h 趨勢

審查日期：2026-11-09。工作目錄：`D:\PYTHON\fadachi`。

## 結論與範圍

發現並修正兩類實質缺陷：資金費去重順序破壞歷史因果性，以及資金費缺失處理未符合 NaN 推論契約。4h／24h 趨勢公式及 optional TypeScript 欄位未發現需修改的缺陷。

程式修改僅涉及 `features_and_labels.py`、`lightgbm_ranker.py`、`research/tests/test_model_research.py`，另新增本報告。保留 30 個特徵及原欄位順序，不調整模型超參數、標籤、資料切分及前端介面。

未啟動代理、AI CLI、瀏覽器、下載、部署或正式資料訓練；未寫入 `reviews/` 或 `data/model-research/`。測試暫存及指令紀錄位於 `research/model_research/.round2-tmp/`。依契約執行既有 npm build，更新其預設建置產物。

## 缺陷與精準修正

### P1：同分鐘未來紀錄會改變較早決策的資金費特徵

- 位置：`features_and_labels.py` 的 `_prepare_funding_lookup`、`_compute_causal_funding_features_for_symbol`。
- 觸發：同時存在 `funding_time = decision_time` 與 `funding_time = decision_time + 1ms`，且兩者被歸於同一結算分鐘。
- 原行為：整份資料先依分鐘保留最後紀錄，使已知結算先被未來紀錄刪除；之後雖嚴格排除未來時間，仍無法還原已知紀錄。只有六筆歷史時會降為不足六筆，其他情況則可能改變均值、標準差及 Z-Score。未來費率本身未直接進入該決策，但未來紀錄的存在已影響歷史特徵。
- 修正：lookup 保留不同毫秒的紀錄，先取 `[decision_time - 7d, decision_time]`，再於該窗口內依原有分鐘規則保留最新紀錄。六筆門檻於去重後檢查，避免重複結算灌大筆數。非有限時間戳／費率在 lookup 中排除。
- 證據：修正前新增測試可重現歷史 `funding_rate_latest` 由 `0.001` 變為 NaN；修正後整份資料、增加未來紀錄的資料，以及決策截止資料的歷史特徵一致。

### P1：資金費缺失時排除整列，無法交由 LightGBM 處理 NaN

- 位置：`features_and_labels.py` 的 funding helper、`compute_features`；`lightgbm_ranker.py` 的 `rank_at_cutoff` 序列化。
- 觸發：某幣在七天窗口少於六筆或沒有資金費；整份 funding 輸入為 None／空表時也有不一致行為。
- 原行為：部分缺失會讓 `features_valid=False`，排除價格資料完整的標的，並可能使群組不足十幣。整份輸入缺失卻補零，將未知值誤示為正常費率；既有輸出也未處理 NaN 的嚴格 JSON 相容性。
- 修正：資金費缺失一致保留 NaN；`features_valid` 以必要價格特徵判定，保留缺資金費標的參與價格截面排名與模型推論。資金費截面排名本身仍為 NaN。對外省略非有限的 `fundingRateLatest`、`fundingRateZScore7d`，符合既有 optional number 型別，避免輸出 JSON NaN 或捏造零值。同步修正不足資料原因文字。
- 邊界：資金費「特徵」可缺失；計算淨報酬所需的未來持倉期間結算費仍須完整，原 `funding_missing` 與標籤排除規則保持有效。
- 證據：修正前 None、空表、一筆、五筆共四種新增案例失敗；修正後通過。既有合成資料測試實際訓練、保存及重新載入多空 LightGBM，新增缺費率推論仍回傳 OK、合格標的數不減、分數有限，且整份結果可通過 `json.dumps(..., allow_nan=False)`。

## 其他審查結果

- 決策時間維持 `open_time + 1h`；`searchsorted(..., side="right")` 包含決策時間本身、排除晚一毫秒。七天窗口左端包含等於邊界的紀錄，排除左端之前一毫秒。
- 4h SMA6 以當下已收盤小時與向前 4／8／12／16／20 小時的收盤價計算；斜率比較四小時前的同公式。
- 24h SMA4 以當下與向前 24／48／72 小時收盤價計算；斜率比較 24 小時前的同公式，因此要求 97 根連續小時線。這是隨決策小時移動的取樣，並非固定 UTC 日線／4h K 線重採樣。
- 新增測試直接核對上述均線距離、斜率、24h 區間位置及振幅；修改未收盤及未來 K 線不影響截止時點結果。原缺口排除測試持續通過。
- `ResearchRankingEntry` 的 `fundingRateLatest`、`fundingRateZScore7d`、兩個趨勢欄位均為 optional number。前端 Z-Score 使用 `Number.isFinite` 檢查，百分比函式處理 undefined／null／非有限值；缺失時顯示 `--`，此次無需修改 TypeScript／前端。
- `MIN_BOOST_ROUNDS=10` 的選模仍僅依 validation 分數；本輪未改動訓練選模流程。此門檻約束所選迭代，不保證無可用分裂時一定能長出十棵有效樹。

## 實際驗證

所有 Python 指令均使用工作區 `.venv\Scripts\python.exe`。TEMP／TMP 均指向專案內 `.round2-tmp`，pytest 停用 cacheprovider 並使用專案內 basetemp。

| 指令 | 結果 |
| --- | --- |
| `.\.venv\Scripts\python.exe -m pytest research/tests/test_model_research.py -p no:cacheprovider --basetemp=research/model_research/.round2-tmp/final-verified` | 23 passed，21.03 秒，exit 0；無 warnings 區段 |
| `npm.cmd test` | 301 passed、0 failed、0 skipped，exit 0；查閱測試入口後確認未啟動瀏覽器，AI provider 為 mock |
| `npm.cmd run lint` | exit 0，無錯誤或警告輸出 |
| `npm.cmd run build` | core、collector、web 建置通過，exit 0；Vite 提示主 chunk 大於 500 kB |

新增案例覆蓋：None／空表／一筆／五筆／六筆、同分鐘未來更新、七天左邊界、非有限 funding 輸入、4h／24h 公式與未收盤小時、真實 LightGBM 合成訓練後的缺值推論與嚴格 JSON。既有測試亦持續檢查資料切分、結算成本、worker 錯誤與回歸。

指令紀錄：`.round2-tmp/pytest-final.log`、`npm-test.log`、`npm-lint.log`、`npm-build.log`。

## 未驗證事項與交接

- 本輪驗證是程式、合成資料模型與非瀏覽器測試；未重建正式 research panel、重訓正式模型、重算離線報告或產生新的正式推論 run。因此既有模型／報告／推論結果保留，不宣稱其已反映本輪修正，亦不宣稱方向命中率提高。
- 若需量化正式資料上的影響，交由 Antigravity 在取得相應決策後以新輸出位置重建 panel、訓練及重新評估，保留既有模型與結果；本輪不覆寫。
- 依使用者要求，未進行瀏覽器、畫面與互動驗證。build 通過僅代表型別與建置成功。可人工確認多空表格在有資金費及缺資金費時，分別顯示數值與 `--`。
