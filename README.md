# Antigravity Crypto

以 React、TypeScript、Vite 與 Electron 製作的加密貨幣行情與模擬交易桌面應用程式。資料來源為 Binance 公開 REST API 與 WebSocket，不需要設定 API 金鑰。

## 功能

- 現貨與永續合約即時行情
- K 線圖與技術指標
- 動能雷達與市場預警
- 模擬交易、持倉與資產組合管理
- Windows 桌面版封裝

## 技術

- React 19、TypeScript、Vite 8
- Electron 42、electron-builder
- Lightweight Charts、Binance 公開 API

## 開始使用

需要安裝 Node.js（建議 LTS 版本）。

```bash
npm ci
npm run dev
```

瀏覽器版預設開啟於 `http://localhost:5173`。Windows 使用者也可雙擊 `start-fadachi.cmd`，它會在首次執行時自動安裝依賴並啟動開發伺服器。

## 指令

```bash
# 程式碼檢查
npm run lint

# 建置前端
npm run build

# 執行已建置的 Electron 桌面版（先執行 npm run build）
npm run desktop:start

# 產生 Windows Portable 執行檔
npm run desktop:build
```

打包檔會輸出至 `dist-desktop/`；此資料夾與其他可重新產生的檔案均不納入版本控制。

## 專案結構

```text
src/
├── components/  # 介面與交易、圖表、預警元件
├── hooks/       # React hooks
├── services/    # Binance 串接與交易邏輯
└── assets/      # 應用程式資產
main.cjs         # Electron 主程序
architecture.md  # 詳細架構說明
```

## 注意事項

本專案的交易功能僅為模擬交易。市場資料來自公開端點，實際可用性取決於 Binance 在使用者所在地區的服務狀態。
