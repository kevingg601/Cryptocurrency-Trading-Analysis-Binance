# Google Drive 上傳清單

請手動上傳以下兩個檔案至 `MyDrive/fadachi/inputs/v3-20261110-004810/`。資料包只含既有 v3 資料與 LightGBM 參考權重，沒有 Python 程式。

| 本機檔案 | Drive 檔名 | 大小 bytes | SHA256 |
|---|---|---:|---|
| `drive-upload/v3-20261110-004810/research-inputs.zip` | `research-inputs.zip` | 33764975 | `383a594c7dacfc0181e7654b451cf32107be78c6f86f5a80598f4a657235dd83` |
| `drive-upload/v3-20261110-004810/assets-manifest.json` | `assets-manifest.json` | 1385 | `438abeb4f78b55adc571593f27858f0c69b62de493b0efe81fc64442a73423f4` |

## ZIP 內來源清單

來源根目錄：`data-reruns/20261110-004810/model-research/`。原檔唯讀保留。

| 相對來源／ZIP 路徑 | 大小 bytes | SHA256 |
|---|---:|---|
| `datasets/dataset_manifest.json` | 21963 | `6c9523594bae6a288a020a162745e1fcb1436a75caaa538d9dad27cbcc503a82` |
| `datasets/research_panel.parquet` | 30752143 | `84126ece34e700da012c797064283c21a45bef127e4dfa196cb21d3b2936ce80` |
| `datasets/klines_1h.parquet` | 6184825 | `09f7474bc8866d3fe632617045573ec89002a4e1a541cc4b363932a05613c2a9` |
| `datasets/funding_rates.parquet` | 262720 | `7549b2c98a09d0257ab0dae2be328b12d6efb320740c8d8d2c49aa2037e9143d` |
| `models/lgbm_metadata.json` | 7166 | `631bf048589b20d3ebbf76004c0e76ecb7ca690fa0003216d8af093e20843b99` |
| `models/lgbm_long_ranker.txt` | 24483 | `53abb6628e8995cbe014040260a25d5860a127da0aea67c7c484e7d7cc710c3c` |
| `models/lgbm_short_ranker.txt` | 128111 | `742f4ddbd63942036beb93820c382c14ac4302c21b15716b376729a14eb8fd6f` |

環境與官方預訓練權重由程式按鎖定版本下載，不需把 node_modules、.venv 或快取傳到 Drive。既有 recovered-results 保留，不覆寫。

重新產生資料包：使用 Python 呼叫 `research.model_benchmark.github_colab.build_inputs(source, new_destination)`；若目的地已有交付檔案會停止，避免覆寫。
