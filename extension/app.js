// 環境偵測：這份 app.js 同時給 PWA 跟 Chrome 擴充功能用。
// - 在擴充功能裡（popup.html），chrome.runtime.id 一定存在，manifest.json 的
//   host_permissions 讓它可以直接打 fapi.binance.com，不會被 CORS 擋。
// - 在一般網頁/PWA 裡，沒有 chrome.runtime（Safari 甚至連 window.chrome 都沒有），
//   必須繞道 Cloudflare Worker 中繼站才能避開 CORS。
// `typeof chrome !== "undefined"` 是安全的寫法：對「根本沒宣告過的變數」用
// typeof 不會丟 ReferenceError，直接用 chrome?.xxx 才會（這正是我們之前修的那個 bug）。
const IS_EXTENSION = typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;

// PWA_PROXY_BASE 現在集中定義在 config.js（HTML 裡要排在 app.js 之前載入），
// 這樣同一個設定 app.js 跟 position.html 可以共用，不用兩邊各自維護一份常數。
const API_BASE = IS_EXTENSION ? "https://fapi.binance.com" : window.PWA_PROXY_BASE;

const API_URL = `${API_BASE}/fapi/v1/ticker/24hr`;
// REFRESH_SECONDS 也集中定義在 config.js，跟 PWA_PROXY_BASE 一樣，讓 position.html
// 的倒數自動重新整理可以套用同一個秒數，不用兩邊各自維護一份常數。
const REFRESH_SECONDS = window.REFRESH_SECONDS;
const TOP_N = 5;

// 跑馬燈模式的參數：捲動速度固定用「像素/秒」表示，而不是固定秒數。
// 這樣不管 TOP_N 是 5 個還是 20 個，捲動的視覺速度都一樣，只是內容長走完一圈的時間自然變長，
// 不會發生「項目一多，反而跑更快」的情況。
const TICKER_SPEED_PX_PER_SEC = 40;

// 市值區塊是否展開，現在是「全部一起開／全部一起關」的單一全域狀態
//（不再逐個 symbol 記憶，改由 index.html 裡的一個 toggle 統一控制，見 initMcapToggle()）。
let mcapExpanded = false;

// 記住最近一次 renderRows() 用的資料，這樣切換到跑馬燈模式時可以直接拿現有資料渲染，
// 不需要重新打 API。
let lastRenderedItems = [];

const $content = document.getElementById("content");
const $skeleton = document.getElementById("skeleton");
const $errorBox = document.getElementById("errorBox");
const $errorText = document.getElementById("errorText");
const $updatedAt = document.getElementById("updatedAt");
const $countdown = document.getElementById("countdown");
const $refreshBtn = document.getElementById("refreshBtn");
const $retryBtn = document.getElementById("retryBtn");
const $liveDot = document.getElementById("liveDot");

// 跑馬燈相關的 DOM 節點是動態建立的（見 initTicker()），先宣告成可重新賦值的變數。
let $tickerBar = null;
let $tickerTrack = null;

// 跑馬燈改成用 rAF 手動驅動 transform（不再用 CSS @keyframes），
// 這樣才能在滑鼠停留時暫停、拖曳時手動控制位移，離開後再從目前位置接續自動捲動。
// tickerPosition 的單位是 px，對應 translateX(-tickerPosition)。
let tickerPosition = 0;
let tickerHalfWidth = 0; // 內容重複兩份，其中一份的寬度，用來做無限捲動的 wrap
let tickerHovered = false;
let tickerDragging = false;
let tickerDragStartX = 0;
let tickerDragStartPosition = 0;
let tickerRafId = null;
let tickerLastTs = null;

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
        fdv: coin.max_supply
          ? coin.current_price * coin.max_supply
          : coin.current_price * coin.total_supply,
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

// Vol/MCap 比率 (百分比數值，如 12.34 代表 12.34%) 轉換成 bar 寬度 (0~100，單位%)。
// 對應範圍 0~300%，等比例對應 0~100% 寬度；超過 300% 一律畫滿 50%（顏色改成黃色警示）。
function ratioToBarWidth(ratioPercent) {
  const clamped = Math.min(Math.max(ratioPercent, 0), 300);
  return (clamped / 300) * 50;
}

function renderRatioBar(ratioPercent) {
  if (typeof ratioPercent !== "number" || Number.isNaN(ratioPercent)) return "";
  const colorClass = ratioPercent > 300 ? "bar-yellow" : "bar-green";
  const width = ratioToBarWidth(ratioPercent).toFixed(1);
  return `
    <div class="row__bar-fill ${colorClass}" style="width:${width}%"></div>
  `;
}

// Vol/MCap 比率同時被「mc」bar（永遠顯示在 row__bars）跟收合區塊裡的文字
// (row__mcap-item) 用到，抽出來共用同一個算法。
function computeVolMcapRatio(marketCap, quoteVolume) {
  return typeof marketCap === "number" && marketCap > 0 && typeof quoteVolume === "number"
    ? (quoteVolume / marketCap) * 100
    : null;
}

// mc（Vol/MCap）bar：原本跟市值/FDV文字一起放在可收合的 row__mcap-collapse 裡，
// 現在移到 row__bars，跟 3D/7D bar 並排、永遠顯示，不受 mcap 收合開關影響。
function renderMcapRatioBar(info, quoteVolume) {
  const ratioValue = info ? computeVolMcapRatio(info.marketCap, quoteVolume) : null;
  const ratioBarHtml = ratioValue !== null ? renderRatioBar(ratioValue) : "";
  return `
    <div class="row__bar-item">
      <span class="row__bar-item-label">mc</span>
      <div class="row__bar-track">
        <span class="row__bar-mid"></span>
        ${ratioBarHtml}
      </div>
    </div>`;
}

function renderMarketCapInfo(info, quoteVolume) {
  const innerHtml =
    !info || typeof info.marketCap !== "number"
      ? `<div class="row__mcap row__mcap--na">市值資料暫無</div>`
      : (() => {
          const mcap = formatCompactUSD(info.marketCap);
          const fdv = typeof info.fdv === "number" ? formatCompactUSD(info.fdv) : "—";
          const ratioValue = computeVolMcapRatio(info.marketCap, quoteVolume);
          const ratio = ratioValue !== null ? `${ratioValue.toFixed(2)}%` : "—";
          return `
              <div class="row__mcap">
                <div class="row__mcap-item"><span class="row__mcap-label">市值</span>${mcap}</div>
                <div class="row__mcap-item"><span class="row__mcap-label">FDV</span>${fdv}</div>
                <div class="row__mcap-item"><span class="row__mcap-label">Vol/MCap</span>${ratio}</div>
              </div>`;
      })();

  // 收闔用 grid-template-rows 0fr↔1fr 的技巧（搭配 overflow:hidden），
  // 不用 JS 去量 px 高度、也不用 max-height 隨便猜一個夠大的值：
  // 內容高度不管長怎樣，展開/收闔都是平滑過渡，不會有畫面瞬間跳一下的抖動感。
  return `
    <div class="row__mcap-collapse${mcapExpanded ? " is-open" : ""}">
      <div class="row__mcap-collapse-inner">${innerHtml}</div>
    </div>`;
}

function buildBinanceUrl(symbol) {
  return `https://www.binance.com/zh-TC/futures/${symbol}?_from=markets`;
}

function buildSmartMoneyUrl(symbol) {
  return `https://www.binance.com/zh-TC/smart-money/signal/${symbol}`;
}

// 聰明錢 long/short 持倉比 stats API：跟 fapi.binance.com 不同網域，
// 但這個端點本身回 access-control-allow-origin: *，所以不用走 host_permissions
// 或 PWA_PROXY_BASE，兩邊環境都能直接 fetch。
const SMART_MONEY_STATS_URL = "https://www.binance.com/bapi/futures/v1/public/future/smart-money/signal/details/stats";

async function fetchSmartMoneyStats(symbol, timeRange = "1h") {
  const url = `${SMART_MONEY_STATS_URL}?symbol=${symbol}&timeRange=${timeRange}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`smart-money stats ${res.status}`);
  const json = await res.json();
  return json?.data || null;
}

// long/short 持倉比：用美元計價的 longPositions / shortPositions（不是人數），
// 反映的是「誰的倉位大」而不是「誰的人數多」。
function computeLongShortRatio(stats) {
  if (!stats || typeof stats.longPositions !== "number" || typeof stats.shortPositions !== "number") return null;
  if (stats.shortPositions <= 0) return null;
  return stats.longPositions / stats.shortPositions;
}

// 目前選擇的聰明錢時間區間，預設 1h；由 initSmartMoneyRangeToggle() 的按鈕切換。
const SMART_MONEY_TIME_RANGES = ["30m", "1h"];
let smartMoneyTimeRange = "1h";

async function attachSmartMoneyRatios(items) {
  const results = await Promise.all(
    items.map(async (item) => {
      try {
        const stats = await fetchSmartMoneyStats(item.symbol, smartMoneyTimeRange);
        return { ...item, smartMoney: stats, longShortRatio: computeLongShortRatio(stats) };
      } catch (err) {
        console.warn(`聰明錢 long/short 比取得失敗: ${item.symbol}`, err);
        return { ...item, smartMoney: null, longShortRatio: null };
      }
    })
  );
  return results;
}

// 切換 30m/1h 只需要重打聰明錢這一支 API，不用整個 loadData() 重來一次
// （價格/多日漲幅/市值都跟時間區間無關，沿用 lastRenderedItems 現有資料就好）。
async function refreshSmartMoney() {
  if (lastRenderedItems.length === 0) return;
  const updated = await attachSmartMoneyRatios(lastRenderedItems);
  renderRows(updated);
}

async function onSmartMoneyRangeClick(e) {
  const btn = e.target.closest(".range-toggle__btn");
  if (!btn || btn.dataset.range === smartMoneyTimeRange) return;
  smartMoneyTimeRange = btn.dataset.range;
  document.querySelectorAll("#smartMoneyRangeToggle .range-toggle__btn").forEach((b) => {
    b.classList.toggle("is-active", b.dataset.range === smartMoneyTimeRange);
  });
  await refreshSmartMoney();
}

// 動態建立 30m/1h 切換按鈕，插進 subbar（label 跟 updatedAt 之間），
// 不用改 pwa/index.html 跟 extension/popup.html 兩份 HTML，維持「只改 shared/」的原則。
function initSmartMoneyRangeToggle() {
  const $subbar = document.querySelector(".subbar");
  if (!$subbar) return;
  const container = document.createElement("div");
  container.className = "range-toggle";
  container.id = "smartMoneyRangeToggle";
  container.innerHTML = SMART_MONEY_TIME_RANGES.map(
    (range) =>
      `<button type="button" class="range-toggle__btn${range === smartMoneyTimeRange ? " is-active" : ""}" data-range="${range}">${range}</button>`
  ).join("");
  $subbar.insertBefore(container, $updatedAt);
  container.addEventListener("click", onSmartMoneyRangeClick);
}

// 合約頁 icon：簡單的漸升折線圖示。
const FUTURES_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 17 9 11 13 15 21 7"></polyline><polyline points="14 7 21 7 21 14"></polyline></svg>`;

// 聰明錢訊號頁 icon：雷達（同心圓 + 中心點 + 掃描線）。
const RADAR_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><circle cx="12" cy="12" r="5.5" stroke-opacity="0.6"></circle><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"></circle><path d="M12 12L19 6"></path></svg>`;

// 開闔聰明錢明細用的 chevron icon：按 aria-expanded 用 CSS 轉向，不用切換兩份 SVG。
const CHEVRON_ICON_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"></polyline></svg>`;

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

function renderLongShortRatio(ratio) {
  const has = typeof ratio === "number" && !Number.isNaN(ratio);
  if (!has) return `<span class="row__ls-ratio is-na">L/S —</span>`;
  const cls = ratio >= 1 ? "is-long" : "is-short"; // >=1：聰明錢多方倉位比空方大
  return `<span class="row__ls-ratio ${cls}">L/S ${ratio.toFixed(2)}</span>`;
}

// 聰明錢 long/short 明細：把 API 回來的四個原始數字（不是算出來的比率）
// 分別呈現，跟市值區塊一樣的 item/label 排版。
// 外面包一層 row__smart-money-collapse，讓每個 row 自己的 toggle 按鈕
// （見 renderRows 裡的 .row__smart-money-toggle）可以獨立開闔這塊，
// 跟 mcap 那個全域共用開關互不影響。預設不加 is-open，一開始是闔上的。
function renderSmartMoneyDetails(stats) {
  const innerHtml =
    !stats || typeof stats.longPositions !== "number"
      ? `<div class="row__smart-money row__smart-money--na">聰明錢資料暫無</div>`
      : (() => {
          const longPositions = formatCompactUSD(stats.longPositions);
          const shortPositions = formatCompactUSD(stats.shortPositions);
          const longTraders = typeof stats.longTraders === "number" ? stats.longTraders.toLocaleString("en-US") : "—";
          const shortTraders = typeof stats.shortTraders === "number" ? stats.shortTraders.toLocaleString("en-US") : "—";
          return `
            <div class="row__smart-money">
              <div class="row__smart-money-group is-long">
                <div class="row__smart-money-item is-long"><span class="row__smart-money-label">Long 倉位</span>${longPositions}</div>
                <div class="row__smart-money-item is-long"><span class="row__smart-money-label">Long 人數</span>${longTraders}</div>
              </div>
              <div class="row__smart-money-group is-short">
                <div class="row__smart-money-item is-short"><span class="row__smart-money-label">Short 倉位</span>${shortPositions}</div>
                <div class="row__smart-money-item is-short"><span class="row__smart-money-label">Short 人數</span>${shortTraders}</div>
              </div>
            </div>`;
        })();

  return `
    <div class="row__smart-money-collapse">
      <div class="row__smart-money-collapse-inner">${innerHtml}</div>
    </div>`;
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

function renderQuoteVolumeRatio(info, quoteVolume) {
  if (!info || typeof info.marketCap !== "number") {
    return `<div class="row__mcap row__mcap--na">市值資料暫無</div>`;
  }
  const ratio =
  typeof quoteVolume === "number" && info.marketCap > 0
    ? `${((quoteVolume / info.marketCap) * 100).toFixed(2)}%`
    : "—";
  return `
    <span class="row__ratio">${ratio}</span>
  `;
}

// 跑馬燈模式下一個 token 的內容：rank symbol price change，四段資訊都在同一行、同一個字級（>=16px）。
function buildTickerItemHtml(item, idx) {
  const { base, quote } = splitSymbol(item.symbol);
  const pct = Number(item.priceChangePercent);
  const has = !Number.isNaN(pct);
  const cls = has ? (pct >= 0 ? "is-up" : "is-down") : "is-na";
  const text = has ? `${pct >= 0 ? "+" : ""}${pct.toFixed(2)}%` : "—";

  return `
    <span class="ticker__item">
      <span class="ticker__rank">${idx + 1}</span>
      <span class="ticker__symbol">${base}/${quote}</span>
      <span class="ticker__price">${formatPrice(item.lastPrice)}</span>
      <span class="ticker__change ${cls}">${text}</span>
      <a class="row__icon-btn" href="${buildBinanceUrl(item.symbol)}" target="_blank" rel="noopener noreferrer" title="在幣安開啟 ${base}/${quote} 合約頁">${FUTURES_ICON_SVG}</a>
      <a class="row__icon-btn" href="${buildSmartMoneyUrl(item.symbol)}" target="_blank" rel="noopener noreferrer" title="在幣安開啟 ${base}/${quote} 聰明錢訊號頁">${RADAR_ICON_SVG}</a>
    </span>`;
}

// 把 top_n 渲染成一條跑馬燈。做法是把內容重複兩份接在一起，
// 用 tickerPosition 從 0 累加到 halfWidth 再 wrap 回 0：因為兩份內容完全一樣，
// wrap 的瞬間視覺上完全無縫，看起來像無限向左捲動。
function renderTicker(items) {
  if (!$tickerTrack) return;
  if (!items || items.length === 0) {
    $tickerTrack.innerHTML = "";
    tickerHalfWidth = 0;
    return;
  }

  const singleHtml = items.map((item, idx) => buildTickerItemHtml(item, idx)).join("");
  $tickerTrack.innerHTML = singleHtml + singleHtml;

  // 寬度要等 DOM 真的量得到之後才能算，所以放進 rAF。
  // 內容變動後 wrap 長度也會變，用 modulo 對齊到新的 halfWidth，避免畫面跳一下。
  requestAnimationFrame(() => {
    const halfWidth = $tickerTrack.scrollWidth / 2; // 兩份內容，取其中一份的寬度
    tickerHalfWidth = halfWidth;
    if (halfWidth > 0) tickerPosition %= halfWidth;
    applyTickerTransform();
  });
}

function applyTickerTransform() {
  if (!$tickerTrack) return;
  $tickerTrack.style.transform = `translateX(${-tickerPosition}px)`;
}

// 每一幀依照經過的時間往前捲動，除非滑鼠停留（tickerHovered）或正在被拖曳（tickerDragging）。
function tickerTick(ts) {
  if (tickerLastTs === null) tickerLastTs = ts;
  const dt = (ts - tickerLastTs) / 1000;
  tickerLastTs = ts;

  if (tickerHalfWidth > 0 && !tickerHovered && !tickerDragging) {
    tickerPosition = (tickerPosition + TICKER_SPEED_PX_PER_SEC * dt) % tickerHalfWidth;
  }
  applyTickerTransform();
  tickerRafId = requestAnimationFrame(tickerTick);
}

function startTickerLoop() {
  if (tickerRafId !== null) return;
  tickerLastTs = null;
  tickerRafId = requestAnimationFrame(tickerTick);
}

function stopTickerLoop() {
  if (tickerRafId !== null) cancelAnimationFrame(tickerRafId);
  tickerRafId = null;
  tickerLastTs = null;
}

// 把某個位移值 wrap 進 [0, tickerHalfWidth) 範圍內，讓拖曳可以左右無限循環，不會拖到底就卡住。
function wrapTickerPosition(pos) {
  if (tickerHalfWidth <= 0) return 0;
  return ((pos % tickerHalfWidth) + tickerHalfWidth) % tickerHalfWidth;
}

function onTickerPointerDown(e) {
  if (tickerHalfWidth <= 0) return;
  tickerDragging = true;
  tickerDragStartX = e.clientX;
  tickerDragStartPosition = tickerPosition;
  $tickerBar?.classList.add("is-dragging");
}

function onTickerPointerMove(e) {
  if (!tickerDragging) return;
  const dx = e.clientX - tickerDragStartX;
  // 手指/滑鼠往右拖 -> 內容跟著往右移（position 變小）；往左拖則反過來。
  tickerPosition = wrapTickerPosition(tickerDragStartPosition - dx);
  applyTickerTransform();
}

function onTickerPointerUp() {
  if (!tickerDragging) return;
  tickerDragging = false;
  $tickerBar?.classList.remove("is-dragging");
}

// 拖曳用 window 層級的 move/up 監聽（而不是綁在 ticker 本身），
// 這樣手指/滑鼠拖出跑馬燈範圍外時還是能正確收到後續事件，不會卡在拖曳中的狀態。
window.addEventListener("pointermove", onTickerPointerMove);
window.addEventListener("pointerup", onTickerPointerUp);
window.addEventListener("pointercancel", onTickerPointerUp);

// 切換「只剩一行、跑馬燈」模式跟「原本樣式」，靠 body 上的 class driving CSS 顯示/隱藏，
// JS 本身不用管哪些區塊要藏——樣式全部交給 style.css 的 .is-ticker-mode 規則。
// rAF 迴圈只在跑馬燈模式開啟時跑，避免隱藏時還在背景做無意義的運算。
function setTickerMode(enabled) {
  document.body.classList.toggle("is-ticker-mode", enabled);
  if (enabled) {
    renderTicker(lastRenderedItems);
    startTickerLoop();
  } else {
    stopTickerLoop();
  }
}

// toggle 開關現在直接寫在 index.html 的 header 裡（不是 JS 動態生成），
// 這裡只需要抓到它、綁上事件即可。
// 註：故意放在 header 而不是 footer——因為跑馬燈模式會把整個 footer 藏起來，
// 如果 toggle 放在 footer，切成跑馬燈之後就再也點不到它、切不回來了。
function initTickerToggle() {
  const $tickerToggle = document.getElementById("tickerToggle");
  if (!$tickerToggle) return;
  $tickerToggle.addEventListener("change", (e) => {
    setTickerMode(e.target.checked);
  });
}

// 建立跑馬燈的容器，插在 $content 前面（兩者都是 .app 底下的直接子元素）。
// 注意：不能插在 $skeleton 前面——$skeleton 是 $content 的子元素，不是它的 sibling，
// 對 $content.parentElement 呼叫 insertBefore(..., $skeleton) 會直接噴錯。
function initTicker() {
  const tickerBar = document.createElement("div");
  tickerBar.className = "ticker";
  tickerBar.id = "tickerBar";

  const tickerTrack = document.createElement("div");
  tickerTrack.className = "ticker__track";
  tickerTrack.id = "tickerTrack";

  tickerBar.appendChild(tickerTrack);
  $content.parentElement.insertBefore(tickerBar, $content);

  $tickerBar = tickerBar;
  $tickerTrack = tickerTrack;

  // 滑鼠/手指停留在跑馬燈上就暫停自動捲動；離開時恢復（若正在拖曳，順便結束拖曳）。
  $tickerBar.addEventListener("pointerenter", () => { tickerHovered = true; });
  $tickerBar.addEventListener("pointerleave", () => {
    tickerHovered = false;
    onTickerPointerUp();
  });
  $tickerTrack.addEventListener("pointerdown", onTickerPointerDown);
}

function renderRows(items) {
  lastRenderedItems = items;
  if (document.body.classList.contains("is-ticker-mode")) {
    renderTicker(items);
  }

  $content.innerHTML = "";

  items.forEach((item, idx) => {
    const { base, quote } = splitSymbol(item.symbol);
    const pct = Number(item.priceChangePercent);
    const barsHtml = renderDayBars(item.dayChanges);
    const mcapBarHtml = renderMcapRatioBar(item.marketCapInfo, Number(item.quoteVolume));
    const changeDaysHtml = renderDayChangeTexts(item.dayChanges);
    const quoteVolumeDisplay = formatCompactUSD(Number(item.quoteVolume));
    const mcapHtml = renderMarketCapInfo(item.marketCapInfo, Number(item.quoteVolume));
    const betaHtml = renderBeta(item.beta);
    const lsRatioHtml = renderLongShortRatio(item.longShortRatio);
    const smartMoneyHtml = renderSmartMoneyDetails(item.smartMoney);

    // row 本身不再是單一外部連結：合約頁／聰明錢訊號頁各自用獨立的 icon <a>
    // 合約頁／聰明錢訊號頁的兩個外部連結，各自用獨立的 icon <a> 呈現在
    // row__symbol 裡（水平排列），讓使用者自己選擇要去哪一個；quote 用
    // margin-left: auto 推到 row__symbol 最右邊。
    // <span class="row__quote">/${quote}</span>
    const row = document.createElement("div");
    row.className = "row";

    const rankClass = idx < 3 ? ` row__rank--${idx + 1}` : "";

    row.innerHTML = `
      <div class="row__rank${rankClass}">${idx + 1}</div>
      <div class="row__main">
        <div class="row__symbol">
          <span class="row__base">${base}</span>
        </div>
        <div class="row__symbol">
          ${betaHtml}
          ${lsRatioHtml}
        </div>
        <div class="row__bars">${barsHtml}${mcapBarHtml}</div>
        ${mcapHtml}
        ${smartMoneyHtml}
      </div>
      <div class="row__stats">
        <div class="row__price">${formatPrice(item.lastPrice)}</div>
        <div class="row_actions">
          <a class="row__icon-btn" href="${buildBinanceUrl(item.symbol)}" target="_blank" rel="noopener noreferrer" title="在幣安開啟 ${base}/${quote} 合約頁">${FUTURES_ICON_SVG}</a>
          <a class="row__icon-btn" href="${buildSmartMoneyUrl(item.symbol)}" target="_blank" rel="noopener noreferrer" title="在幣安開啟 ${base}/${quote} 聰明錢訊號頁">${RADAR_ICON_SVG}</a>
          <button class="row__icon-btn row__smart-money-toggle" type="button" aria-expanded="false" title="展開聰明錢明細">${CHEVRON_ICON_SVG}</button>
        </div>
        <div class="row__quoteVolume">${quoteVolumeDisplay}</div>
        <div class="row__change">+${pct.toFixed(2)}%</div>
        <div class="row__change-days">${changeDaysHtml}</div>
      </div>
    `;

    const smToggleBtn = row.querySelector(".row__smart-money-toggle");
    const smCollapse = row.querySelector(".row__smart-money-collapse");
    const smCollapseInner = row.querySelector(".row__smart-money-collapse-inner");
    if (smToggleBtn && smCollapse && smCollapseInner) {
      smToggleBtn.addEventListener("click", () => {
        const nowOpen = !smCollapse.classList.contains("is-open");
        smCollapse.classList.toggle("is-open", nowOpen);
        // 用量出來的 scrollHeight 動畫 max-height，不用 CSS grid 0fr/1fr 那招，
        // 因為 Safari 對 flex-wrap 內容的 intrinsic size 算不準（見 style.css 註解）。
        smCollapse.style.maxHeight = nowOpen ? `${smCollapseInner.scrollHeight}px` : "0px";
        smToggleBtn.setAttribute("aria-expanded", String(nowOpen));
        smToggleBtn.title = nowOpen ? "收合聰明錢明細" : "展開聰明錢明細";
      });
    }

    $content.appendChild(row);
  });
}

// 市值區塊現在是全部一起開/關，由 index.html 裡的 #mcapToggle 統一控制。
// 切換時直接改目前畫面上所有 .row__mcap-collapse 的 class，不用整個重新 renderRows()，
// 這樣是瞬間對所有 row 同時生效，而且沿用原本的 grid-template-rows 平滑過渡動畫。
function setMcapExpanded(expanded) {
  mcapExpanded = expanded;
  document.querySelectorAll(".row__mcap-collapse").forEach((el) => {
    el.classList.toggle("is-open", expanded);
  });
}

// header 選單：漢堡按鈕開闔一個面板，面板本身固定寫在 index.html/popup.html 裡
// （不是 JS 動態生成的），這裡只負責綁定開闔行為——點漢堡切換、點面板以外的地方
// 或按 Escape 收起來。面板裡的 Lite/mcap 開關維持原本各自的 change 事件，跟這裡
// 的開闔邏輯互不影響。
function initHeaderMenu() {
  const $menuToggleBtn = document.getElementById("menuToggleBtn");
  const $menuPanel = document.getElementById("headerMenuPanel");
  if (!$menuToggleBtn || !$menuPanel) return;

  const setMenuOpen = (open) => {
    $menuPanel.hidden = !open;
    $menuToggleBtn.setAttribute("aria-expanded", String(open));
  };

  $menuToggleBtn.addEventListener("click", () => {
    setMenuOpen($menuPanel.hidden);
  });

  document.addEventListener("click", (e) => {
    if ($menuPanel.hidden) return;
    if ($menuToggleBtn.contains(e.target) || $menuPanel.contains(e.target)) return;
    setMenuOpen(false);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !$menuPanel.hidden) setMenuOpen(false);
  });
}

// 綁定 index.html 裡固定寫好的 #mcapToggle（不是 JS 動態生成的）。
function initMcapToggle() {
  const $mcapToggle = document.getElementById("mcapToggle");
  if (!$mcapToggle) return;
  $mcapToggle.checked = mcapExpanded;
  $mcapToggle.addEventListener("change", (e) => {
    setMcapExpanded(e.target.checked);
  });
}

function showError(message) {
  $content.hidden = true;
  $errorBox.hidden = false;
  $errorText.textContent = message;
  // 用 body class 標記「目前顯示錯誤」，讓跑馬燈模式底下也能正確蓋掉跑馬燈，
  // 顯示這一行連線錯誤訊息＋重試按鈕（見 style.css 的 .has-error 規則）。
  document.body.classList.add("has-error");
}

function hideError() {
  $errorBox.hidden = true;
  $content.hidden = false;
  document.body.classList.remove("has-error");
}

async function fetchTopGainers() {
  if (!navigator.onLine) {
    throw new Error("目前沒有網路連線，請確認連線後按重試");
  }

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

    // 聰明錢 long/short 持倉比同樣是額外一支 API，採「先顯示、後補上」。
    const withSmartMoney = await attachSmartMoneyRatios(withMarketCaps);
    renderRows(withSmartMoney);
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

// 瀏覽器原生的斷線/恢復連線事件：斷線時立刻顯示錯誤訊息（不用等到下一次排程 fetch 才發現），
// 恢復連線時自動重新載入一次，成功的話 hideError() 會自動把 error 狀態收掉。
window.addEventListener("offline", () => {
  showError("網路連線中斷，請確認連線後按重試");
  $liveDot.style.background = "var(--down)";
});
window.addEventListener("online", () => {
  loadData();
});

initTicker();
initTickerToggle();
initMcapToggle();
initSmartMoneyRangeToggle();
initHeaderMenu();

buildSkeleton();
loadData();
startTimers();
