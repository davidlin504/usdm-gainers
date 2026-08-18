// Cloudflare Worker：轉發請求給 fapi.binance.com，並補上 CORS header。
// 部署方式（純網頁操作，不用 Mac、不用 CLI）：
// 1. 到 https://dash.cloudflare.com 免費註冊/登入
// 2. 左側選單 Workers & Pages -> Create -> Create Worker
// 3. 取個名字（例如 usdm-gainers-proxy），Deploy
// 4. 進到這個 Worker -> Edit code，把下面全部程式碼貼上覆蓋掉預設內容 -> Deploy
// 5. 複製它的網址（長得像 https://usdm-gainers-proxy.你的子網域.workers.dev）
// 6. 貼回 app.js 的 PROXY_BASE

const TARGET_ORIGIN = "https://fapi.binance.com";

// 只允許轉發這兩個公開的市場資料端點，避免這個中繼站被拿去打其他 API
const ALLOWED_PATHS = ["/fapi/v1/ticker/24hr", "/fapi/v1/klines"];

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }

    if (!ALLOWED_PATHS.includes(url.pathname)) {
      return new Response(JSON.stringify({ error: "path not allowed" }), {
        status: 403,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }

    const targetUrl = TARGET_ORIGIN + url.pathname + url.search;

    let upstreamRes;
    try {
      upstreamRes = await fetch(targetUrl, {
        method: "GET",
        headers: { Accept: "application/json" },
      });
    } catch (err) {
      return new Response(JSON.stringify({ error: "upstream fetch failed" }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders() },
      });
    }

    const body = await upstreamRes.arrayBuffer();
    const headers = new Headers();
    headers.set("Content-Type", upstreamRes.headers.get("Content-Type") || "application/json");
    headers.set("Cache-Control", "no-store");
    Object.entries(corsHeaders()).forEach(([k, v]) => headers.set(k, v));

    return new Response(body, { status: upstreamRes.status, headers });
  },
};
