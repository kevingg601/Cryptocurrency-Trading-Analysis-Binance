# GitHub／Colab 網頁整理交付紀錄

## 本次完成

- 沿用現有完整專案及遠端，不改 repository 可見性、不變更前端／交易功能。
- 主要操作指南與架構移至 docs/；7 份歷史計畫／交付文件保留在 docs/archive/，相關相對連結同步調整。
- 新 Notebook 及生成器改為指定 GitHub commit 下載完整專案，私有庫下載使用 Secrets＋暫時 credential helper；token 僅存在子程序環境，helper 不含 token，完成即移除，不寫 Git config。
- 資料only ZIP 約 33.8 MB，僅7個既有來源檔；手動上傳位置與hash見 [清單](DRIVE_UPLOAD_MANIFEST.md)。資料、權重、結果、環境及快取排除提交。
- 明確 train／infer／export；infer 只重載模型，無訓練回退；export 可獨立由路徑恢復，寫入新ZIP並核對Drive SHA256。
- CUDA預檢上限45秒，nvidia-smi上限15秒；正式模式不預跑smoke。新程序統一 MPLBACKEND=Agg。
- 續跑使用既有完整stage快照及相同程式／資料／環境身分；跨runtime需session＋run ID；不承諾逐optimizer step恢復。

## 已執行的最小本機驗證

- 10個離線針對性回歸檢查通過（1.03秒）：資料包往返及白名單、原資料保留、惡意ZIP拒絕、PARTIAL結果匯出與hash、活動run拒絕最終匯出、推論沒有train路徑、僅選排序模型不下載時序權重、JSONL停止後排空。
- Python AST、Notebook基本結構／空輸出／code cells AST、生成器輸出一致性通過。現有環境未安裝nbformat，因此沒有宣稱通過nbformat套件schema驗證；未新增安裝依賴。
- Credential helper以離線假值實際呼叫通過；假值沒有寫入helper，暫存helper已移除。不等同真實GitHub私有庫授權通過。
- 既有Git歷史未發現大於50 MiB的blob；目前及歷史內容的常見GitHub／OpenAI token前綴掃描未發現命中，非完整秘密稽核。
- 既有四模型結果、來源資料及權重沒有重訓或覆寫；原manifest仍為PARTIAL，LightGBM基準未在本次補跑。

## 驗證限制

不下載大型權重、不啟動模型訓練、不重跑整套測試。原有實作子代理角色無法啟動，因此由主代理直接實作及針對性檢查，沒有宣稱獨立reviewer通過。

依使用者要求，未進行瀏覽器、畫面與互動驗證。真實Colab登入、Secrets授權、Drive掛載及T4模型執行，仍需使用者按操作指南手動確認；本機mock或CPU檢查不作為這些驗收的替代。

已確認原遠端由GitHub重新導向同一儲存庫的新名稱：`kevingg601/Cryptocurrency-Trading-Analysis-Binance`。入口與本機origin改用該正式網址，未建立新庫或改變可見性。乾淨的Git暫存內容匯出目錄已成功載入研究模組；待提交檔案未含資料、權重或訓練結果。


## Drive下載快取更新

新增drive_cache.py，保存固定Python安裝包、完整wheel集合及官方模型權重；安裝好的venv留在/content。快取由鎖定檔＋平台識別，與程式commit分離。先完成ZIP與SHA256核對再發布索引；不備份未完成下載，不覆寫資料或模型成果。完整wheels以離線方式安裝，已核對官方權重不再呼叫下載。

本次僅跑4個小型離線快取測試（0.90秒）：保存／還原、未變內容不重複上傳、不含venv／未完成檔、損壞hash拒絕、wheel命中不啟動網路、版本key隔離；另完成變更程式與Notebook語法／生成一致性檢查。沒有實際下載套件／權重、訓練或使用Colab GPU，真實Drive與Linux離線安裝仍待執行確認。
