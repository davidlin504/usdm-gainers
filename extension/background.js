let popupWindowId = null;

const WINDOW_WIDTH = 400;
const WINDOW_HEIGHT = 640;

const RANKINGS_URL = "https://www.binance.com/zh-TC/markets/trading_data/rankings";
const RANKINGS_MENU_ID = "open-binance-rankings";
const SMART_MONEY_MENU_ID = "open-binance-smart-money";

// 從幣安合約頁網址（例如 https://www.binance.com/zh-TC/futures/MAGICUSDT）
// 解析出 locale 與交易對，組出對應的 Smart Money 訊號頁網址。
function buildSmartMoneyUrl(pageUrl) {
  let url;
  try {
    url = new URL(pageUrl);
  } catch (e) {
    return null;
  }
  const match = url.pathname.match(/^\/([^/]+)\/futures\/([^/?]+)/);
  if (!match) {
    return null;
  }
  const [, locale, symbol] = match;
  return `https://www.binance.com/${locale}/smart-money/signal/${symbol}?timeRange=30m&side=BOTH&sortBy=TIME&sortOrder=DESC&page=1`;
}

// 右鍵點擴充功能圖示時，在選單裡加一個項目（會出現在「管理擴充功能」等預設項目上方）。
chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: RANKINGS_MENU_ID,
    title: "開啟幣安漲幅榜網頁",
    contexts: ["action"],
  });

  // 在幣安合約頁上右鍵，加一個直達該幣種 Smart Money 訊號頁的選單項目。
  chrome.contextMenus.create({
    id: SMART_MONEY_MENU_ID,
    title: "開啟此幣種的 Smart Money 訊號頁",
    contexts: ["page"],
    documentUrlPatterns: ["https://www.binance.com/*/futures/*"],
  });
});

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === RANKINGS_MENU_ID) {
    chrome.tabs.create({ url: RANKINGS_URL });
    return;
  }

  if (info.menuItemId === SMART_MONEY_MENU_ID) {
    const targetUrl = buildSmartMoneyUrl(info.pageUrl);
    if (targetUrl) {
      chrome.tabs.create({ url: targetUrl });
    }
    return;
  }
});

chrome.action.onClicked.addListener(async () => {
  // 若視窗已開啟 -> 這次點擊視為「關閉」
  if (popupWindowId !== null) {
    try {
      await chrome.windows.remove(popupWindowId);
    } catch (e) {
      // 視窗可能已被使用者手動關閉，忽略錯誤即可
    }
    popupWindowId = null;
    return;
  }

  // 視窗尚未開啟 -> 這次點擊視為「開啟」
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL("popup.html"),
    type: "popup",
    width: WINDOW_WIDTH,
    height: WINDOW_HEIGHT,
    focused: true,
  });
  popupWindowId = win.id;
});

// 使用者用視窗本身的關閉鈕關掉時，同步重置狀態
chrome.windows.onRemoved.addListener((closedId) => {
  if (closedId === popupWindowId) {
    popupWindowId = null;
  }
});
