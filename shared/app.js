// 環境偵測：這份 app.js 同時給 PWA 跟 Chrome 擴充功能用。
// - 在擴充功能裡（popup.html），chrome.runtime.id 一定存在，manifest.json 的
//   host_permissions 讓它可以直接打 fapi.binance.com，不會被 CORS 擋。
// - 在一般網頁/PWA 裡，沒有 chrome.runtime（Safari 甚至連 window.chrome 都沒有），
//   必須繞道 Cloudflare Worker 中繼站才能避開 CORS。
// `typeof chrome !== "undefined"` 是安全的寫法：對「根本沒宣告過的變數」用
// typeof 不會丟 ReferenceError，直接用 chrome?.xxx 才會（這正是我們之前修的那個 bug）。
const IS_EXTENSION = typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;

// PWA 版本要換成你自己的 workers.dev 網址（結尾不要加斜線）；
// 擴充功能版本不會用到這個常數，因為 IS_EXTENSION 會是 true。
const PWA_PROXY_BASE = "https://flat-sky-fe8c.davidlin504.workers.dev";

const API_BASE = IS_EXTENSION ? "https://fapi.binance.com" : PWA_PROXY_BASE;

const API_URL = `${API_BASE}/fapi/v1/ticker/24hr`;
const REFRESH_SECONDS = 300;
const TOP_N = 5;

const $content = document.getElementById("content");
const $skeleton = document.getElementById("skeleton");
const $errorBox = document.getElementById("errorBox");
const $errorText = document.getElementById("errorText");
const $updatedAt = document.getElementById("updatedAt");
const $countdown = document.getElementById("countdown");
const $refreshBtn = document.getElementById("refreshBtn");
const $retryBtn = document.getElementById("retryBtn");
const $liveDot = document.getElementById("liveDot");

let countdownTimer = null;
let refreshTimer = null;
let secondsLeft = REFRESH_SECONDS;

function buildSkeleton() {
  $skeleton.innerHTML = "";
  for (let i = 0; i < TOP_N; i++) {
    const div = document.createElement("div");
    div.className = "skeleton-row";
    $skeleton.appendChild(div);
  }
}

function formatPrice(p) {
  const num = Number(p);
  if (num >= 1000) return num.toLocaleString("en-US", { maximumFractionDigits: 2 });
  if (num >= 1) return num.toFixed(4);
  if (num >= 0.01) return num.toFixed(5);
  return num.toFixed(8);
}

const KLINES_URL = `${API_BASE}/fapi/v1/klines`;

// 想顯示哪些天數的累積漲跌幅，之後要加 14D、30D...只要在這裡加一個數字即可，
// 不需要再改任何抓資料或渲染邏輯。
const DAY_RANGES = [3, 7];
const MAX_DAY_RANGE = Math.max(...DAY_RANGES);

// fapi.binance.com 對呼叫頻率比較嚴格，所以每個 symbol 只打一次 klines：
// 抓「最大天數 + 1」根日K，之後每個天數要用的基準價都從這一份資料裡切出來，
// 不會因為 DAY_RANGES 有幾個天數就打幾次 API。
// klines 沒有能一次查多個 symbol 的版本，所以 TOP_N 個代幣仍然是各打一次
// （這已經是能做到的最少呼叫次數）。
async function fetchDayChanges(symbol, currentPrice) {
  const url = `${KLINES_URL}?symbol=${symbol}&interval=1d&limit=${MAX_DAY_RANGE + 1}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`klines ${res.status}`);
  const klines = await res.json();

  const changes = {};
  if (!Array.isArray(klines) || klines.length === 0) {
    DAY_RANGES.forEach((days) => { changes[days] = null; });
    return changes;
  }

  const current = Number(currentPrice);
  DAY_RANGES.forEach((days) => {
    // klines 是舊到新排序，最後一根是「今天」(還在走的K棒，0天前)。
    // 所以「N 天前」收盤價的位置是 length - 1 - N。
    const idx = klines.length - 1 - days;
    if (idx < 0) {
      changes[days] = null;
      return;
    }
    const basePrice = Number(klines[idx][4]); // close price
    changes[days] = basePrice ? ((current - basePrice) / basePrice) * 100 : null;
  });

  return changes;
}

async function attachDayChanges(items) {
  const results = await Promise.all(
    items.map(async (item) => {
      try {
        const dayChanges = await fetchDayChanges(item.symbol, item.lastPrice);
        return { ...item, dayChanges };
      } catch (err) {
        console.warn(`多日漲幅取得失敗: ${item.symbol}`, err);
        const dayChanges = {};
        DAY_RANGES.forEach((days) => { dayChanges[days] = null; });
        return { ...item, dayChanges };
      }
    })
  );
  return results;
}

function buildBinanceUrl(symbol) {
  return `https://www.binance.com/zh-TC/futures/${symbol}?_from=markets`;
}

function splitSymbol(symbol) {
  const quotes = ["USDT", "USDC", "BUSD"];
  for (const q of quotes) {
    if (symbol.endsWith(q)) {
      return { base: symbol.slice(0, -q.length), quote: q };
    }
  }
  return { base: symbol, quote: "" };
}

// change (百分比數值，如 12.34 代表 12.34%) 轉換成 bar 長度（0~50，單位%）。
// 起點固定在 50%（change = 0）；正數往右延伸（綠色）、負數往左延伸（紅色）。
// change 對應範圍：0~200% 或 0~-200%，等比例對應 0~50% 長度。
function dayChangeToBarLength(change) {
  const ratio = change / 100; // 12.34 -> 0.1234
  const magnitude = Math.min(Math.abs(ratio), 2); // clamp到 2 (=200%)
  return (magnitude / 2) * 50; // 0 ~ 50
}

function renderDayBars(dayChanges) {
  return DAY_RANGES.map((days) => {
    const value = dayChanges?.[days];
    const has = typeof value === "number" && !Number.isNaN(value);
    const colorClass = has ? (value >= 0 ? "bar-green" : "bar-red") : "";
    const fillHtml = has
      ? `<div class="row__bar-fill ${colorClass}" style="width:${dayChangeToBarLength(value).toFixed(1)}%"></div>`
      : "";

    return `
      <div class="row__bar-item">
        <span class="row__bar-item-label">${days}D</span>
        <div class="row__bar-track">
          <span class="row__bar-mid"></span>
          ${fillHtml}
        </div>
      </div>`;
  }).join("");
}

function renderDayChangeTexts(dayChanges) {
  return DAY_RANGES.map((days) => {
    const value = dayChanges?.[days];
    const has = typeof value === "number" && !Number.isNaN(value);
    const cls = has ? (value >= 0 ? "is-up" : "is-down") : "is-na";
    const text = has ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%` : "—";
    return `
      <div class="row__change-day ${cls}">
        <span class="row__change-day-label">${days}D</span>${text}
      </div>`;
  }).join("");
}

function renderRows(items) {
  $content.innerHTML = "";

  items.forEach((item, idx) => {
    const { base, quote } = splitSymbol(item.symbol);
    const pct = Number(item.priceChangePercent);
    const barsHtml = renderDayBars(item.dayChanges);
    const changeDaysHtml = renderDayChangeTexts(item.dayChanges);

    const row = document.createElement("a");
    row.className = "row";
    row.href = buildBinanceUrl(item.symbol);
    row.target = "_blank";
    row.rel = "noopener noreferrer";
    row.title = `在幣安開啟 ${base}/${quote} 交易頁`;

    const rankClass = idx < 3 ? ` row__rank--${idx + 1}` : "";

    row.innerHTML = `
      <div class="row__rank${rankClass}">${idx + 1}</div>
      <div class="row__main">
        <div class="row__symbol">
          <span class="row__base">${base}</span>
          <span class="row__quote">/${quote}</span>
        </div>
        <div class="row__bars">${barsHtml}</div>
      </div>
      <div class="row__stats">
        <div class="row__price">${formatPrice(item.lastPrice)}</div>
        <div class="row__change">+${pct.toFixed(2)}%</div>
        <div class="row__change-days">${changeDaysHtml}</div>
      </div>
    `;
    $content.appendChild(row);
  });
}

function showError(message) {
  $content.hidden = true;
  $errorBox.hidden = false;
  $errorText.textContent = message;
}

function hideError() {
  $errorBox.hidden = true;
  $content.hidden = false;
}

async function fetchTopGainers() {
  const res = await fetch(API_URL);
  if (!res.ok) {
    throw new Error(`Binance API 回應錯誤 (${res.status})`);
  }
  const data = await res.json();

  const filtered = data
    .filter((d) => d.symbol.endsWith("USDT") || d.symbol.endsWith("USDC"))
    .filter((d) => Number(d.lastPrice) > 0 && Number(d.quoteVolume) > 0)
    .map((d) => ({
      symbol: d.symbol,
      lastPrice: d.lastPrice,
      priceChangePercent: d.priceChangePercent,
      quoteVolume: d.quoteVolume,
    }))
    .sort((a, b) => Number(b.priceChangePercent) - Number(a.priceChangePercent))
    .slice(0, TOP_N);

  return filtered;
}

function setLoading(isLoading) {
  $refreshBtn.classList.toggle("spinning", isLoading);
}

async function loadData() {
  setLoading(true);
  try {
    const top = await fetchTopGainers();
    hideError();
    buildSkeleton();
    renderRows(top);
    const now = new Date();
    $updatedAt.textContent = `更新於 ${now.toLocaleTimeString("zh-TW", { hour12: false })}`;
    $liveDot.style.background = "var(--up)";

    // 多日累積漲跌幅需要額外呼叫 klines API，先顯示基本資料，完成後再補上。
    const withDayChanges = await attachDayChanges(top);
    renderRows(withDayChanges);
  } catch (err) {
    console.error(err);
    showError(err.message || "網路連線失敗，請確認裝置已連上網際網路");
    $liveDot.style.background = "var(--down)";
  } finally {
    setLoading(false);
    resetCountdown();
  }
}

function resetCountdown() {
  secondsLeft = REFRESH_SECONDS;
  $countdown.textContent = `${secondsLeft}s`;
}

function startTimers() {
  clearInterval(countdownTimer);
  clearInterval(refreshTimer);

  countdownTimer = setInterval(() => {
    secondsLeft -= 1;
    if (secondsLeft <= 0) secondsLeft = REFRESH_SECONDS;
    $countdown.textContent = `${secondsLeft}s`;
  }, 1000);

  refreshTimer = setInterval(loadData, REFRESH_SECONDS * 1000);
}

$refreshBtn.addEventListener("click", loadData);
$retryBtn.addEventListener("click", loadData);

buildSkeleton();
loadData();
startTimers();
