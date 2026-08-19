const CACHE_NAME = "gainers-shell-v2";
const SHELL_FILES = [
  "./index.html",
  "./style.css",
  "./app.js",
  "./manifest.webmanifest",
  "./icons/icon192.png",
  "./icons/icon512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_FILES))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // 只處理「同網域」的靜態檔案；幣安/Worker API 一律直接打網路，不經過這裡。
  if (url.origin !== self.location.origin) {
    return;
  }

  // network-first：有網路就永遠拿最新版本，同時把它存進快取；
  // 只有離線抓不到網路時，才退回上次存的快取，避免完全空白。
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        const resClone = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, resClone));
        return res;
      })
      .catch(() => caches.match(event.request))
  );
});
