// 環境偵測跟 shared/app.js 一樣的寫法：擴充功能靠 manifest 的 host_permissions
// 直接打 fapi.binance.com（不受 CORS 限制，也不需要額外處理自訂 header 的 preflight）；
// PWA/一般網頁沒有這個特權，簽名端點幾乎必定被 CORS 擋下，要走 worker/worker.js 轉發。
const IS_EXTENSION = typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;
// 兩邊的進入點檔名不一樣（PWA 是 index.html，擴充功能是 popup.html），
// 所以「返回」連結不能寫死，要靠 IS_EXTENSION 決定目標。
document.getElementById("backLink").href = IS_EXTENSION ? "./popup.html" : "./index.html";

// PWA_PROXY_BASE 定義在 config.js（跟 shared/app.js 共用同一個設定），
// 要切換成 worker/worker.js 轉發時只要改 config.js 那一個地方就好。
const API_BASE = IS_EXTENSION ? "https://fapi.binance.com" : window.PWA_PROXY_BASE;
const ACCOUNT_URL = `${API_BASE}/fapi/v3/account`;

const STORAGE_KEY_API = "usdmGainers.apiKey";
const STORAGE_KEY_SECRET = "usdmGainers.apiSecret";

const $apiKeyInput = document.getElementById("apiKeyInput");
const $apiSecretInput = document.getElementById("apiSecretInput");
const $credToggleBtn = document.getElementById("credToggleBtn");
const $credentialsBody = document.getElementById("credentialsBody");
const $credentialsCollapsedHint = document.getElementById("credentialsCollapsedHint");
const $saveBtn = document.getElementById("saveBtn");
const $clearBtn = document.getElementById("clearBtn");
const $refreshBtn = document.getElementById("refreshBtn");
const $retryBtn = document.getElementById("retryBtn");
const $errorBox = document.getElementById("errorBox");
const $errorText = document.getElementById("errorText");
const $summaryCard = document.getElementById("summaryCard");
const $summaryGrid = document.getElementById("summaryGrid");
const $summaryHeadLeft = document.getElementById("summaryHeadLeft");
const $summaryToggleBtn = document.getElementById("summaryToggleBtn");
const $visibilityToggleBtn = document.getElementById("visibilityToggleBtn");
const $countdown = document.getElementById("countdown");
const $positionsHeader = document.getElementById("positionsHeader");
const $positionsList = document.getElementById("positionsList");
const $sideFilterSelect = document.getElementById("sideFilterSelect");
const $sortSelect = document.getElementById("sortSelect");
const $viewToggle = document.getElementById("viewToggle");
const $updatedAt = document.getElementById("updatedAt");

// 記住最近一次成功查詢到的持倉，切換排序/篩選/顯示方式時直接重新處理/渲染，不用重打 API。
let lastPositions = [];
let lastAccount = null;
let sortMode = "roi-desc";
let sideFilter = "all";
let viewMode = "list"; // "card" | "list"
let accountHidden = false;

// 倒數自動重新整理：秒數跟 shared/app.js 共用同一個 window.REFRESH_SECONDS（見 config.js），
// 只在成功打過一次 API（也就是金鑰有效）之後才開始跑，避免金鑰還沒填就一直重試。
let countdownTimer = null;
let secondsLeft = window.REFRESH_SECONDS;

function updateCountdownText() {
  $countdown.textContent = `${secondsLeft}s`;
}
function resetCountdown() {
  secondsLeft = window.REFRESH_SECONDS;
  updateCountdownText();
}
function startCountdown() {
  $countdown.hidden = false;
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    secondsLeft -= 1;
    if (secondsLeft <= 0) {
      loadAccount(); // 成功/失敗都會在 finally 裡呼叫 resetCountdown()，接著這個 interval 重新算下一輪
    } else {
      updateCountdownText();
    }
  }, 1000);
}

// 帳戶總覽的眼睛圖示：切換是否把餘額/盈虧數字換成星號，方便在別人看得到螢幕時遮一下。
function setAccountHidden(hidden) {
  accountHidden = hidden;
  updateSummaryValues();
  $visibilityToggleBtn.innerHTML = accountHidden ? EYE_OFF_ICON_SVG : EYE_ICON_SVG;
  $visibilityToggleBtn.title = accountHidden ? "顯示帳戶資訊" : "隱藏帳戶資訊";
}
$visibilityToggleBtn.addEventListener("click", () => setAccountHidden(!accountHidden));

// 帳戶總覽卡片收合：跟 API 金鑰區域用同一套「頭部按鈕切換、本體隱藏」的收合行為——
// .pos-card__head（標題、眼睛圖示、收合按鈕）永遠顯示，只收合下面的數字本體。
function setSummaryCollapsed(collapsed) {
  $summaryGrid.hidden = collapsed;
  $summaryToggleBtn.textContent = collapsed ? "▸" : "▾";
}
$summaryToggleBtn.addEventListener("click", () => {
  setSummaryCollapsed($summaryGrid.hidden === false);
});

// API 金鑰卡片收合：查詢成功後自動收起來，減少畫面佔用；查詢失敗或按「清除金鑰」
// 時自動展開，方便直接修正輸入。
function setCredentialsCollapsed(collapsed) {
  $credentialsBody.hidden = collapsed;
  $credentialsCollapsedHint.hidden = !collapsed;
  $credToggleBtn.textContent = collapsed ? "▸" : "▾";
}
$credToggleBtn.addEventListener("click", () => {
  setCredentialsCollapsed($credentialsBody.hidden === false);
});

function loadStoredCredentials() {
  $apiKeyInput.value = localStorage.getItem(STORAGE_KEY_API) || "";
  $apiSecretInput.value = localStorage.getItem(STORAGE_KEY_SECRET) || "";
}

function saveCredentials() {
  localStorage.setItem(STORAGE_KEY_API, $apiKeyInput.value.trim());
  localStorage.setItem(STORAGE_KEY_SECRET, $apiSecretInput.value.trim());
}

function clearCredentials() {
  localStorage.removeItem(STORAGE_KEY_API);
  localStorage.removeItem(STORAGE_KEY_SECRET);
  $apiKeyInput.value = "";
  $apiSecretInput.value = "";
  setCredentialsCollapsed(false);
  lastAccount = null;
  $summaryCard.hidden = true;
  $positionsHeader.hidden = true;
  $positionsList.className = "";
  $positionsList.innerHTML = "";
  document.body.classList.remove("has-positions");
  hideError();
  $updatedAt.textContent = "尚未查詢";
  clearInterval(countdownTimer);
  $countdown.hidden = true;
}

// Binance 簽名規則：query string 用 HMAC-SHA256、secret key 當金鑰簽名，
// 結果轉成 16 進位字串接在 query string 後面當 signature 參數。
async function hmacSha256Hex(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sigBuf = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return Array.from(new Uint8Array(sigBuf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fetchAccount(apiKey, apiSecret) {
  const query = `timestamp=${Date.now()}&recvWindow=5000`;
  const signature = await hmacSha256Hex(apiSecret, query);
  const url = `${ACCOUNT_URL}?${query}&signature=${signature}`;
  const res = await fetch(url, { headers: { "X-MBX-APIKEY": apiKey } });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Binance API 回應錯誤 (${res.status})${body ? `：${body}` : ""}`);
  }
  return res.json();
}

// 24 小時制，「更新於」/ 日期 / 時間固定各佔一行（用 <br> 強制換行，不靠 flex-wrap 動態判斷）。
function setUpdatedAt(date) {
  $updatedAt.replaceChildren(
    "更新於",
    document.createElement("br"),
    date.toLocaleDateString("zh-TW"),
    document.createElement("br"),
    date.toLocaleTimeString("zh-TW", { hour12: false })
  );
}

function formatUSD(n) {
  const num = Number(n);
  if (Number.isNaN(num)) return "—";
  return num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const ACCOUNT_HIDDEN_MASK = "********";

// 隱藏帳戶資訊時直接把文字換成星號（不用 blur），這樣即使截圖也不會留下可辨識的殘影。
function updateSummaryValues() {
  if (!lastAccount) return;
  const $wallet = document.getElementById("sumWalletBalance");
  const $pnl = document.getElementById("sumUnrealizedProfit");
  const $margin = document.getElementById("sumMarginBalance");
  const $available = document.getElementById("sumAvailableBalance");
  if (accountHidden) {
    $wallet.textContent = ACCOUNT_HIDDEN_MASK;
    $pnl.textContent = ACCOUNT_HIDDEN_MASK;
    $pnl.classList.remove("is-up", "is-down");
    $margin.textContent = ACCOUNT_HIDDEN_MASK;
    $available.textContent = ACCOUNT_HIDDEN_MASK;
    return;
  }
  $wallet.textContent = formatUSD(lastAccount.totalWalletBalance);
  const pnl = Number(lastAccount.totalUnrealizedProfit);
  $pnl.textContent = formatUSD(pnl);
  $pnl.classList.toggle("is-up", pnl >= 0);
  $pnl.classList.toggle("is-down", pnl < 0);
  $margin.textContent = formatUSD(lastAccount.totalMarginBalance);
  $available.textContent = formatUSD(lastAccount.availableBalance);
}

function renderSummary(account) {
  lastAccount = account;
  updateSummaryValues();
  $summaryCard.hidden = false;
}

// 跟 shared/app.js 用的是同一套連結/icon，這裡是獨立頁面所以直接複製一份，
// 不特別為了共用兩三行常數去拆共用檔案。
function buildBinanceUrl(symbol) {
  return `https://www.binance.com/zh-TC/futures/${symbol}?_from=markets`;
}
function buildSmartMoneyUrl(symbol) {
  return `https://www.binance.com/zh-TC/smart-money/signal/${symbol}`;
}
const FUTURES_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 7"></polyline><polyline points="14 7 21 7 21 14"></polyline></svg>`;
const RADAR_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="5.5" stroke-opacity="0.6"></circle><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"></circle><path d="M12 12L19 6"></path></svg>`;
const EYE_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path><circle cx="12" cy="12" r="3"></circle></svg>`;
const EYE_OFF_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.94 10.94 0 0112 20c-7 0-11-8-11-8a18.6 18.6 0 015.06-5.94"></path><path d="M9.9 4.24A10.94 10.94 0 0112 4c7 0 11 8 11 8a18.6 18.6 0 01-2.16 3.19"></path><path d="M14.12 14.12a3 3 0 11-4.24-4.24"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>`;
setAccountHidden(false);

function positionSideLabel(position) {
  const amt = Number(position.positionAmt);
  if (position.positionSide && position.positionSide !== "BOTH") {
    return position.positionSide === "LONG" ? "多" : "空";
  }
  return amt >= 0 ? "多" : "空";
}

// /fapi/v3/account 的 positions[] 欄位只有 symbol/positionSide/positionAmt/
// unrealizedProfit/isolatedMargin/notional/isolatedWallet/initialMargin/maintMargin/
// updateTime——沒有 entryPrice、markPrice、leverage、liquidationPrice、marginType。
// 但 notional = positionAmt * markPrice、unrealizedProfit = positionAmt * (markPrice - entryPrice)，
// 兩條式子聯立就能反推出 markPrice 跟 entryPrice，不用多打一支 API。
function formatPrice(n) {
  const num = Number(n);
  if (!Number.isFinite(num)) return "—";
  const abs = Math.abs(num);
  if (abs >= 1000) return num.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (abs >= 1) return num.toFixed(4);
  if (abs >= 0.01) return num.toFixed(5);
  return num.toFixed(8);
}

// 把一筆原始 position 轉成畫面/排序都會用到的衍生數值，跟渲染邏輯分開，
// 這樣切換排序方式時可以先排序這些數值，再決定渲染順序。
function computePositionView(p) {
  const amt = Number(p.positionAmt);
  const isLong = positionSideLabel(p) === "多";
  const pnl = Number(p.unrealizedProfit);
  const notionalSigned = Number(p.notional);
  const notional = Math.abs(notionalSigned);
  const markPrice = notionalSigned / amt;
  const entryPrice = (notionalSigned - pnl) / amt;

  // ROI 固定假設 1 倍槓桿：以「全額名義價值」當作本金，而不是帳戶實際設定的槓桿倉位保證金。
  const roi = notional > 0 ? (pnl / notional) * 100 : null;

  // v3 沒有回傳 marginType，用 isolatedWallet 有沒有分配資金當代理判斷。
  const isIsolated = Number(p.isolatedWallet) !== 0 || Number(p.isolatedMargin) !== 0;
  const marginAmount = isIsolated ? Number(p.isolatedMargin) : Number(p.initialMargin);

  return { p, amt, isLong, pnl, notional, markPrice, entryPrice, roi, isIsolated, marginAmount };
}

function sortPositionViews(views, mode) {
  if (mode === "roi-desc") {
    return [...views].sort((a, b) => (b.roi ?? -Infinity) - (a.roi ?? -Infinity));
  }
  if (mode === "roi-asc") {
    return [...views].sort((a, b) => (a.roi ?? Infinity) - (b.roi ?? Infinity));
  }
  return views; // "none" -> 維持 API 回傳的原始順序
}

function filterPositionViews(views, filter) {
  if (filter === "long") return views.filter((v) => v.isLong);
  if (filter === "short") return views.filter((v) => !v.isLong);
  return views;
}

function renderPositionRow(v) {
  const { p, amt, isLong, pnl, notional, markPrice, entryPrice, roi, isIsolated, marginAmount } = v;
  return `
    <div class="pos-row">
      <div class="pos-row__head">
        <span class="pos-row__symbol">${p.symbol}</span>
        <div class="pos-row__head-links">
          <a class="row__icon-btn" href="${buildBinanceUrl(p.symbol)}" target="_blank" rel="noopener noreferrer" title="在幣安開啟 ${p.symbol} 合約頁">${FUTURES_ICON_SVG}</a>
          <a class="row__icon-btn" href="${buildSmartMoneyUrl(p.symbol)}" target="_blank" rel="noopener noreferrer" title="在幣安開啟 ${p.symbol} 聰明錢訊號頁">${RADAR_ICON_SVG}</a>
          <span class="pos-row__side ${isLong ? "is-long" : "is-short"}">${isLong ? "多" : "空"}</span>
        </div>
      </div>
      <div class="pos-row__grid">
        <div class="pos-row__grid-item">
          <span class="pos-row__grid-label">倉位數量</span>
          <span>${amt}</span>
        </div>
        <div class="pos-row__grid-item">
          <span class="pos-row__grid-label">名義價值</span>
          <span>${formatUSD(notional)}</span>
        </div>
        <div class="pos-row__grid-item">
          <span class="pos-row__grid-label">開倉均價</span>
          <span>${formatPrice(entryPrice)}</span>
        </div>
        <div class="pos-row__grid-item">
          <span class="pos-row__grid-label">標記價格</span>
          <span>${formatPrice(markPrice)}</span>
        </div>
        <div class="pos-row__grid-item">
          <span class="pos-row__grid-label">未實現盈虧</span>
          <span class="${pnl >= 0 ? "is-up" : "is-down"}">${pnl >= 0 ? "+" : ""}${formatUSD(pnl)}</span>
        </div>
        <div class="pos-row__grid-item">
          <span class="pos-row__grid-label">ROI（假設 1x 槓桿）</span>
          <span class="${roi !== null && roi >= 0 ? "is-up" : "is-down"}">${roi !== null ? `${roi >= 0 ? "+" : ""}${roi.toFixed(2)}%` : "—"}</span>
        </div>
        <div class="pos-row__grid-item">
          <span class="pos-row__grid-label">保證金模式</span>
          <span>${isIsolated ? "逐倉" : "全倉"}</span>
        </div>
        <div class="pos-row__grid-item">
          <span class="pos-row__grid-label">保證金</span>
          <span>${formatUSD(marginAmount)}</span>
        </div>
      </div>
    </div>`;
}

// 列表顯示：只留 symbol / icon-btn / side / roi 一行，給只想快速掃一眼盈虧狀況的情境用。
function renderPositionListRow(v) {
  const { p, isLong, roi } = v;
  return `
    <div class="pos-list-row">
      <span class="pos-list-row__symbol">${p.symbol}</span>
      <span class="pos-row__side ${isLong ? "is-long" : "is-short"}">${isLong ? "多" : "空"}</span>
      <span class="pos-list-row__roi ${roi !== null && roi >= 0 ? "is-up" : "is-down"}">${roi !== null ? `${roi >= 0 ? "+" : ""}${roi.toFixed(2)}%` : "—"}</span>
      <div class="pos-list-row__icons">
        <a class="row__icon-btn" href="${buildBinanceUrl(p.symbol)}" target="_blank" rel="noopener noreferrer" title="在幣安開啟 ${p.symbol} 合約頁">${FUTURES_ICON_SVG}</a>
        <a class="row__icon-btn" href="${buildSmartMoneyUrl(p.symbol)}" target="_blank" rel="noopener noreferrer" title="在幣安開啟 ${p.symbol} 聰明錢訊號頁">${RADAR_ICON_SVG}</a>
      </div>
    </div>`;
}

function renderPositions(positions) {
  lastPositions = positions;
  const open = positions.filter((p) => Number(p.positionAmt) !== 0);

  // 頁面寬度限制只在真的有倉位資料時才放寬，設定金鑰階段維持手機版寬度。
  document.body.classList.toggle("has-positions", open.length > 0);

  if (open.length === 0) {
    $positionsHeader.hidden = true;
    $positionsList.className = "";
    $positionsList.innerHTML = `<div class="pos-empty">目前沒有持倉中的合約倉位</div>`;
    return;
  }

  $positionsHeader.hidden = false;
  const allViews = open.map(computePositionView);
  const filtered = filterPositionViews(allViews, sideFilter);
  const sorted = sortPositionViews(filtered, sortMode);

  if (sorted.length === 0) {
    $positionsList.className = "";
    $positionsList.innerHTML = `<div class="pos-empty">目前篩選條件下沒有符合的倉位</div>`;
    return;
  }

  if (viewMode === "list") {
    $positionsList.className = "is-list";
    $positionsList.innerHTML = sorted.map(renderPositionListRow).join("");
  } else {
    $positionsList.className = "is-grid";
    $positionsList.innerHTML = sorted.map(renderPositionRow).join("");
  }
}

function showError(message) {
  $errorBox.hidden = false;
  $errorText.textContent = message;
}

function hideError() {
  $errorBox.hidden = true;
}

function setLoading(isLoading) {
  $refreshBtn.disabled = isLoading;
  $refreshBtn.textContent = isLoading ? "⟲ 查詢中…" : "⟲ 重新整理";
}

async function loadAccount() {
  const apiKey = $apiKeyInput.value.trim();
  const apiSecret = $apiSecretInput.value.trim();
  if (!apiKey || !apiSecret) {
    showError("請先輸入 API Key 與 Secret Key");
    return;
  }

  setLoading(true);
  try {
    const account = await fetchAccount(apiKey, apiSecret);
    hideError();
    renderSummary(account);
    renderPositions(account.positions || []);
    setUpdatedAt(new Date());
    setCredentialsCollapsed(true);
  } catch (err) {
    console.error(err);
    showError(err.message || "查詢失敗，請確認金鑰與網路連線");
    setCredentialsCollapsed(false);
  } finally {
    setLoading(false);
    resetCountdown();
    startCountdown();
  }
}

$saveBtn.addEventListener("click", () => {
  saveCredentials();
  loadAccount();
});
$clearBtn.addEventListener("click", clearCredentials);
$refreshBtn.addEventListener("click", loadAccount);
$retryBtn.addEventListener("click", loadAccount);
$sortSelect.addEventListener("change", (e) => {
  sortMode = e.target.value;
  renderPositions(lastPositions);
});
$sideFilterSelect.addEventListener("change", (e) => {
  sideFilter = e.target.value;
  renderPositions(lastPositions);
});
$viewToggle.addEventListener("change", (e) => {
  viewMode = e.target.checked ? "list" : "card";
  renderPositions(lastPositions);
});

loadStoredCredentials();
if ($apiKeyInput.value && $apiSecretInput.value) loadAccount();
