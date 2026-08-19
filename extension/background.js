let popupWindowId = null;

const WINDOW_WIDTH = 400;
const WINDOW_HEIGHT = 640;

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
