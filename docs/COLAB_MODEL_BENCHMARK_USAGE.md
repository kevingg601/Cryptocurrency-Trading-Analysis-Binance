# Colab 網頁操作指南

程式在本機維護並 push GitHub；Colab 從固定 commit 下載完整專案，資料和結果存 Google Drive。本頁取代 VS Code Colab server／混合程式 ZIP 操作；歷史交付文件見 archive/。

## 第一次準備

1. 將 `drive-upload/v3-20261110-004810/research-inputs.zip` 與 `assets-manifest.json` 手動上傳至 `MyDrive/fadachi/inputs/v3-20261110-004810/`。來源與 SHA256 見 [上傳清單](DRIVE_UPLOAD_MANIFEST.md)。不要重新選幣或更改期間。
2. 從交付的固定 commit「Open in Colab」連結開啟 Notebook。若私有庫，先在 https://colab.research.google.com/github 勾選 Include Private Repos、登入並授權。
3. 私有庫另至 GitHub Settings → Developer settings → Personal access tokens → Fine-grained tokens，建立僅此 repository、Contents: Read-only 且有期限的 token。在 Colab 左側 Secrets 新增 `FADACHI_GITHUB_TOKEN`，開啟此 Notebook 的存取權。不要把 token 貼進程式或傳給其他人。網頁登入不等於 runtime 的 git 已授權。
4. 第 1 格填交付的 40 位 CODE_COMMIT；Notebook 的固定 commit 連結與 CODE_COMMIT 必須相同。公開庫將 PRIVATE_REPO=False。
5. Colab 選「執行階段 → 變更執行階段類型 → GPU」，T4 即可，然後由上至下執行。切換 runtime 可能清掉 `/content`，不要在尚未備份結果時切換。
6. 第 2 格必須執行，完成 Drive 掛載授權；出現授權提示時點選帳號及允許。只開 Notebook 或插入掛載格都不等於已掛載。

## 訓練與推論

- `ACTION='train'`, `RUN_MODE='full'`：正式訓練，不另跑四模型 smoke。`RUN_MODE='smoke'` 僅明確選擇時做小型訓練，不等同全量完成。
- `MODEL_KEYS`：預設四個。只選部分模型時報告標示 `PARTIAL / SELECTED_MODELS_ONLY`，不冒充四模型全部完成。
- 每次第 5 格在 RESUME_RUN_ID=None 時建立新實驗；要續跑，必須填入該格已印出的 run ID。同 kernel 可續用現存資料；跨 runtime 再填先前輸出的 `RESUME_SESSION_ID`，從已提交快照恢復。CODE_COMMIT、資料、環境或模型身分不同時拒絕恢復。未完成的候選／模型階段可能重跑，不保證逐 optimizer step 恢復。
- `ACTION='infer'`：先將保存的模型 run ZIP 解壓到 `/content`，MODEL_RUN_PATH 指向含 `run_manifest.json` 的資料夾。只重新載入保存模型並對原固定共同 TEST 推論，沒有 train 路由。不是即時行情推論，也不是新增獨立測試。
- 只準備所選模型需要的環境與權重（rank協調環境共用）；初次準備依賴及官方權重可能需要時間；環境仍為固定的 Python 3.12.12 及三組鎖定依賴，kernel 不升級。CatBoost、XGBoost 使用 CPU；時序模型優先 CUDA，訓練 OOM 依原策略 CPU 新 attempt。
- 訓練仍保留必要的 VAL checkpoint 選模，不以省額度為由跳過評估。TEST 已查看，報告只作研究比較。

## 保存與恢復結果

第 5 格會印出 run 路徑與快照 session ID，階段快照及最終 ZIP 保存到 `MyDrive/fadachi/outputs/`；ZIP 另附 SHA256 檔。第 6 格可獨立匯出，沒有 `SNAPSHOTS` 變數也能執行。

若 kernel 重啟，直接編輯第 6 格的三行，例如：

```python
EXPORT_REPO_PATH = '/content/fadachi-github-<commit前12位>/repo'
EXPORT_PATH = '/content/fadachi-github-<commit前12位>/runs/<run-id>'
EXPORT_DRIVE_ROOT = '/content/drive/MyDrive/fadachi'
```

然後只執行第 6 格並完成必要的 Drive 授權；不需跑 GPU 預檢、安裝或訓練。整台 VM 已消失時 `/content` 不會保留，需使用 Drive 已保存 ZIP／已提交快照；不能靠 kernel 變數恢復遺失檔案。`PARTIAL`／`FAILED` 匯出仍保留原狀態，正在 RUNNING 的 run 不作最終匯出。

GitHub 與 Colab 不會自動雙向同步；修改統一在本機 commit／push。Colab 臨時修改若需要保留，下載後在本機審閱合併。GPU 資源由 Colab 分配，不保證 A100 或單次完成。關檔不等於刪除 runtime，確認備份後再中斷並刪除 runtime。

## 官方依據與驗證邊界

- [Colab 官方 GitHub 範例](https://github.com/googlecolab/colabtools/blob/main/notebooks/colab-github-demo.ipynb)
- [Colab FAQ：Drive、VM 與檔案保存](https://research.google.com/colaboratory/faq.html)
- [GitHub token 官方文件](https://docs.github.com/en/authentication/keeping-your-account-and-data-secure/managing-your-personal-access-tokens)
- [Colab Secrets 官方實作](https://github.com/googlecolab/colabtools/blob/main/google/colab/userdata.py)

本機只做必要非 GPU 檢查；真實 Colab 網頁登入、私有庫授權及 GPU 執行尚待手動確認。依使用者要求，未進行瀏覽器、畫面與互動驗證。既有結果仍為 PARTIAL，LightGBM 基準需另行補跑；這次僅修正新流程的 MPLBACKEND=Agg，不重訓或改寫原結果。
