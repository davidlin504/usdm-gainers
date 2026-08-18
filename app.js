const API_URL = "https://fapi.binance.com/fapi/v1/ticker/24hr";
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

const KLINES_URL = "https://fapi.binance.com/fapi/v1/klines";

async function fetchThreeDayChange(symbol, currentPrice) {
  // limit=4 -> [t-3, t-2, t-1, today(in progress)]; use the close of the
  // oldest candle as the "3 days ago" reference price.
  const url = `${KLINES_URL}?symbol=${symbol}&interval=1d&limit=4`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`klines ${res.status}`);
  const klines = await res.json();
  if (!Array.isArray(klines) || klines.length === 0) return null;

  const basePrice = Number(klines[0][4]); // close price
  if (!basePrice) return null;

  const current = Number(currentPrice);
  return ((current - basePrice) / basePrice) * 100;
}

async function attachThreeDayChanges(items) {
  const results = await Promise.all(
    items.map(async (item) => {
      try {
        const change3d = await fetchThreeDayChange(item.symbol, item.lastPrice);
        return { ...item, change3d };
      } catch (err) {
        console.warn(`3日漲幅取得失敗: ${item.symbol}`, err);
        return { ...item, change3d: null };
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

// change3d (百分比數值，如 12.34 代表 12.34%) 轉換成 bar 長度（0~50，單位%）。
// 起點固定在 50%（change3d = 0）；正數往右延伸（綠色）、負數往左延伸（紅色）。
// change3d 對應範圍：0~200% 或 0~-200%，等比例對應 0~50% 長度。
function change3dToBarLength(change3d) {
  const ratio = change3d / 100; // 12.34 -> 0.1234
  const magnitude = Math.min(Math.abs(ratio), 2); // clamp到 2 (=200%)
  return (magnitude / 2) * 50; // 0 ~ 50
}

function renderRows(items) {
  $content.innerHTML = "";

  items.forEach((item, idx) => {
    const { base, quote } = splitSymbol(item.symbol);
    const pct = Number(item.priceChangePercent);
    const has3d = typeof item.change3d === "number" && !Number.isNaN(item.change3d);
    const change3dClass = has3d ? (item.change3d >= 0 ? "is-up" : "is-down") : "is-na";
    const change3dText = has3d
      ? `${item.change3d >= 0 ? "+" : ""}${item.change3d.toFixed(2)}%`
      : "—";

    let barHtml = "";
    if (has3d) {
      const lengthPct = change3dToBarLength(item.change3d);
      const isPositive = item.change3d >= 0;
      const colorClass = isPositive ? "bar-green" : "bar-red";
      barHtml = `
        <div class="row__bar-track">
          <span class="row__bar-mid"></span>
          <div class="row__bar-fill ${colorClass}" style="width:${lengthPct.toFixed(1)}%"></div>
        </div>`;
    }

    const row = document.createElement("div");
    row.className = "row";
    row.title = `在幣安開啟 ${base}/${quote} 交易頁`;
    row.addEventListener("click", () => {
      const url = buildBinanceUrl(item.symbol);
      if (chrome?.tabs?.create) {
        chrome.tabs.create({ url });
      } else {
        window.open(url, "_blank", "noopener,noreferrer");
      }
    });

    const rankClass = idx < 3 ? ` row__rank--${idx + 1}` : "";

    row.innerHTML = `
      <div class="row__rank${rankClass}">${idx + 1}</div>
      <div class="row__main">
        <div class="row__symbol">
          <span class="row__base">${base}</span>
          <span class="row__quote">/${quote}</span>
        </div>
        ${barHtml}
      </div>
      <div class="row__stats">
        <div class="row__price">${formatPrice(item.lastPrice)}</div>
        <div class="row__change">+${pct.toFixed(2)}%</div>
        <div class="row__change3d ${change3dClass}">
          <span class="row__change3d-label">3D</span>${change3dText}
        </div>
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

    // 3日累積漲跌幅需要額外呼叫 klines API，先顯示基本資料，完成後再補上。
    const withChange3d = await attachThreeDayChanges(top);
    renderRows(withChange3d);
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
