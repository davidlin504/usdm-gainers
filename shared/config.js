// 集中管理「PWA 環境要不要透過 Cloudflare Worker 轉發」這個設定，app.js 跟
// position.html 都讀這裡，只要改一個地方就好（不用同時改兩個檔案裡各自的常數）。
// 擴充功能不受這個設定影響——它一律靠 manifest 的 host_permissions 直打 fapi.binance.com。
//
// 目前 fapi.binance.com 的公開行情端點跟 /fapi/v3/account 對瀏覽器直接呼叫都沒有
// CORS 問題，所以先直接打，不用啟用 worker/worker.js 這個轉發站。
// 如果之後 Binance 收回 CORS 權限、PWA 端開始被擋，把下面這行換成你部署好的
// Cloudflare Worker 網址（結尾不要加斜線）即可，不用改 app.js 或 position.html。
window.PWA_PROXY_BASE = "https://fapi.binance.com";

// app.js（漲幅榜倒數重新整理）跟 position.html（持倉頁倒數重新整理）共用同一個秒數，
// 改這裡就能同時調整兩邊的自動重新整理頻率。
window.REFRESH_SECONDS = 300;
