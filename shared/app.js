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
// const PWA_PROXY_BASE = "https://flat-sky-fe8c.davidlin504.workers.dev";
const PWA_PROXY_BASE = "https://fapi.binance.com";

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

// beta 計算用的參數：
// - BENCHMARK_SYMBOL：拿誰當「大盤」。幣圈通常用 BTC 當基準（等同傳統金融拿大盤指數算股票 beta）。
// - BETA_LOOKBACK_DAYS：用多少天的日報酬率樣本去算 covariance/variance。
//   注意：這個數字不能跟 DAY_RANGES 的天數搞混——DAY_RANGES 只是「累積漲跌幅」的顯示天數，
//   beta 需要的是「報酬率的樣本點數」，樣本太少（例如只有 7 天 = 6 個報酬率）統計上幾乎沒意義。
//   30 天（29 個報酬率）是幣圈常見的下限，仍然不多，但比 6 個好非常多。想要更穩定可以拉到 60/90。
const BENCHMARK_SYMBOL = "BTCUSDT";
const BETA_LOOKBACK_DAYS = 30;

// 每個 symbol（包含 benchmark）只打一次 klines，抓「max(顯示天數, beta天數) + 1」根日K，
// 這份資料同時拿去算 %D 累積漲跌幅（原本的邏輯）跟 beta（新邏輯），不會因為兩個功能各打一次 API。
const KLINE_LIMIT = Math.max(MAX_DAY_RANGE, BETA_LOOKBACK_DAYS) + 1;

async function fetchKlines(symbol, limit = KLINE_LIMIT) {
  const url = `${KLINES_URL}?symbol=${symbol}&interval=1d&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`klines ${res.status}`);
  return res.json();
}

function closesFromKlines(klines) {
  // klines[i][4] 是收盤價字串，轉成 number 陣列（舊到新排序）。
  return Array.isArray(klines) ? klines.map((k) => Number(k[4])) : [];
}

function computeDayChanges(klines, currentPrice) {
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

// 把收盤價陣列轉成「日報酬率」陣列（簡單報酬率，不是log return）。
// [p0, p1, p2] -> [(p1-p0)/p0, (p2-p1)/p1]
function computeReturns(closes) {
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1];
    if (prev) returns.push((closes[i] - prev) / prev);
  }
  return returns;
}

// beta = Cov(資產報酬率, 基準報酬率) / Var(基準報酬率)
// 兩邊長度可能不同（例如某個 symbol 上市時間比 BTC 短），取尾端對齊的共同長度，
// 也就是「最近 n 天」兩邊都有資料的部分。
function computeBeta(assetReturns, benchmarkReturns) {
  const n = Math.min(assetReturns.length, benchmarkReturns.length);
  if (n < 2) return null;

  const a = assetReturns.slice(-n);
  const b = benchmarkReturns.slice(-n);
  const meanA = a.reduce((sum, v) => sum + v, 0) / n;
  const meanB = b.reduce((sum, v) => sum + v, 0) / n;

  let cov = 0;
  let varB = 0;
  for (let i = 0; i < n; i++) {
    cov += (a[i] - meanA) * (b[i] - meanB);
    varB += (b[i] - meanB) ** 2;
  }
  if (varB === 0) return null;
  return cov / varB;
}

async function attachDayChangesAndBeta(items) {
  // benchmark（BTC）的報酬率序列只抓一次，所有 token 共用同一份去算 covariance。
  let benchmarkReturns = [];
  try {
    const benchKlines = await fetchKlines(BENCHMARK_SYMBOL);
    benchmarkReturns = computeReturns(closesFromKlines(benchKlines));
  } catch (err) {
    console.warn("Benchmark (BTC) 資料取得失敗，beta 將顯示為 N/A", err);
  }

  const results = await Promise.all(
    items.map(async (item) => {
      try {
        const klines = await fetchKlines(item.symbol);
        const dayChanges = computeDayChanges(klines, item.lastPrice);
        const assetReturns = computeReturns(closesFromKlines(klines));
        const beta = benchmarkReturns.length
          ? computeBeta(assetReturns, benchmarkReturns)
          : null;
        return { ...item, dayChanges, beta };
      } catch (err) {
        console.warn(`K線/beta 取得失敗: ${item.symbol}`, err);
        const dayChanges = {};
        DAY_RANGES.forEach((days) => { dayChanges[days] = null; });
        return { ...item, dayChanges, beta: null };
      }
    })
  );
  return results;
}

// Binance API 本身不提供市值（market cap 需要流通量資料），所以市值 / 完全稀釋市值(FDV) /
// 24h量對市值比 這三項改用 CoinGecko 的公開 API 取得。
// CoinGecko 的公開端點瀏覽器可以直接 fetch，沒有 CORS 問題。
// 如果你有申請 Demo API Key（免費：https://www.coingecko.com/en/developers/dashboard），
// 填在下面可以拿到比較寬鬆的速率限制；留空一樣能用，只是限制比較嚴。
const COINGECKO_BASE = "https://api.coingecko.com/api/v3";
const COINGECKO_API_KEY = "CG-cTqoggqr4Pm4fhQ1njKCLUnq";

// 一次把 TOP_N 個 symbol 的市值資料一起抓回來（不是一個一個打），
// 用 /coins/markets 的 symbols 參數。
// 同一個 ticker 可能對應到多個幣（例如撞名的迷因幣），因為預設是
// order=market_cap_desc，所以每個 symbol 第一次出現時取到的就是市值最大的那個。
async function fetchMarketCaps(symbols) {
  if (symbols.length === 0) return {};
  const query = symbols.map((s) => s.toLowerCase()).join(",");
  const url = `${COINGECKO_BASE}/coins/markets?vs_currency=usd&symbols=${query}&order=market_cap_desc&per_page=250&page=1`;
  const headers = COINGECKO_API_KEY ? { "x-cg-demo-api-key": COINGECKO_API_KEY } : {};
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`CoinGecko API 回應錯誤 (${res.status})`);
  const data = await res.json();

  const map = {};
  data.forEach((coin) => {
    const sym = coin.symbol?.toUpperCase();
    if (sym && !(sym in map)) {
      map[sym] = {
        marketCap: coin.market_cap,
        fdv: coin.current_price * coin.max_supply,
        volume24h: coin.total_volume,
      };
    }
  });
  return map;
}

async function attachMarketCaps(items) {
  try {
    const symbols = items.map((item) => splitSymbol(item.symbol).base);
    const map = await fetchMarketCaps(symbols);
    return items.map((item) => ({
      ...item,
      marketCapInfo: map[splitSymbol(item.symbol).base] || null,
      quoteVolume: Number(item.quoteVolume),
    }));
  } catch (err) {
    console.warn("市值資料取得失敗", err);
    return items.map((item) => ({ ...item, marketCapInfo: null, quoteVolume: Number(item.quoteVolume) }) );
  }
}

function formatCompactUSD(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  const abs = Math.abs(n);
  if (abs >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
  return `$${n.toFixed(2)}`;
}

function renderMarketCapInfo(info, quoteVolume) {
  if (!info || typeof info.marketCap !== "number") {
    return `<div class="row__mcap row__mcap--na">市值資料暫無</div>`;
  }
  const mcap = formatCompactUSD(info.marketCap);
  const fdv = typeof info.fdv === "number" ? formatCompactUSD(info.fdv) : "—";
  const ratio =
    typeof quoteVolume === "number" && info.marketCap > 0
      ? `${((quoteVolume / info.marketCap) * 100).toFixed(2)}%`
      : "—";

  return `
    <div class="row__mcap">
      <div class="row__mcap-item"><span class="row__mcap-label">市值</span>${mcap}</div>
      <div class="row__mcap-item"><span class="row__mcap-label">FDV</span>${fdv}</div>
      <div class="row__mcap-item"><span class="row__mcap-label">Vol/MCap</span>${ratio}</div>
    </div>`;
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

function renderBeta(beta) {
  const has = typeof beta === "number" && !Number.isNaN(beta);
  if (!has) return `<span class="row__beta is-na">β —</span>`;
  const cls = beta >= 1 ? "is-hi" : "is-lo"; // >=1：波動比 BTC 大；<1：比 BTC 小
  return `<span class="row__beta ${cls}">β ${beta.toFixed(2)}</span>`;
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
    const quoteVolume = formatCompactUSD(Number(item.quoteVolume));
    const mcapHtml = renderMarketCapInfo(item.marketCapInfo, quoteVolume);
    const betaHtml = renderBeta(item.beta);

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
          <span class="row__quoteVolume">${quoteVolume}</span>
          ${betaHtml}
        </div>
        <div class="row__bars">${barsHtml}</div>
        ${mcapHtml}
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
    const withDayChanges = await attachDayChangesAndBeta(top);
    renderRows(withDayChanges);

    // 市值 / FDV / Vol-Mcap 比率來自 CoinGecko，跟上面的多日漲幅一樣採「先顯示、後補上」。
    const withMarketCaps = await attachMarketCaps(withDayChanges);
    renderRows(withMarketCaps);
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
