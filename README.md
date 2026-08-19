# USDⓈ-M 合約漲幅榜

同一份核心邏輯，同時部署成 PWA（iPhone 加主畫面）跟 Chrome 擴充功能。

## 資料夾結構

```
shared/            <- 唯一要編輯的地方
  app.js           資料抓取、渲染邏輯（環境自動偵測，PWA/擴充功能通用）
  style.css        UI 樣式

pwa/               <- PWA 專屬殼
  index.html       PWA 進入點（含 iOS 加主畫面用的 meta tags）
  manifest.webmanifest
  sw.js            離線快取用的 service worker
  icons/
  app.js           <- 由 shared/ 同步過來，不要手動改
  style.css        <- 由 shared/ 同步過來，不要手動改

extension/         <- Chrome 擴充功能專屬殼
  manifest.json    擴充功能設定（host_permissions 讓它能直接打 API，不用走 Worker）
  background.js    控制 popup 視窗開關
  popup.html       擴充功能進入點
  icons/
  app.js           <- 由 shared/ 同步過來，不要手動改
  style.css        <- 由 shared/ 同步過來，不要手動改

worker/
  worker.js        PWA 版本專用的 CORS 中繼站（Cloudflare Worker）

sync.sh            把 shared/ 同步到 pwa/ 與 extension/
```

## 日常修改流程

1. 只改 `shared/app.js` 或 `shared/style.css`
2. 在專案根目錄執行 `./sync.sh`
3. 重新部署兩邊：
   - **PWA**：把 `pwa/` 底下有變動的檔案重新上傳到 GitHub（GitHub Pages 會自動重新部署）
   - **擴充功能**：把整個 `extension/` 資料夾拖進 `chrome://extensions` 的「載入未封裝項目」重新載入，或打包上傳 Chrome 線上應用程式商店

`pwa/` 和 `extension/` 底下的 `app.js`、`style.css` 是**產物**，不要直接手動改——改了下次 `./sync.sh` 會被覆蓋掉。

## 兩邊唯一不同的地方

`shared/app.js` 開頭用 `IS_EXTENSION` 自動判斷目前是在哪個環境執行：

- **擴充功能**：`chrome.runtime.id` 存在 → 直接打 `fapi.binance.com`（靠 manifest 的 `host_permissions` 繞過 CORS）
- **PWA / 一般網頁**：沒有 `chrome.runtime` → 改打 `PWA_PROXY_BASE`（你的 Cloudflare Worker 網址，需要先部署 `worker/worker.js` 並把網址填進 `shared/app.js`）

其他所有邏輯（抓漲幅榜、算 3D/7D 漲跌幅、渲染列表、點擊開幣安頁）完全共用，不需要為了哪個平台寫兩份。
