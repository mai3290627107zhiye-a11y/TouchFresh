/* 一碰知鲜 · 离线缓存（仅在 http/https 下注册）
 *
 * 策略：网络优先、离线回落缓存。
 * 上一版是缓存优先，导致改完前端后，老访客一直拿到缓存里的旧 app.js
 * ——页面看起来「没更新」。改成网络优先后，只要部署了新文件就立刻生效，
 * 断网时仍然走缓存，离线可用性不受影响。
 */
var CACHE = "touchfresh-v5";
var ASSETS = [
  "./",
  "index.html",
  "app.css",
  "app.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/apple-touch-icon.png"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return Promise.all(ASSETS.map(function (u) {
        return c.add(new Request(u, { cache: "reload" })).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  if (req.url.indexOf("chrome-extension") >= 0) return;

  e.respondWith(
    fetch(req).then(function (res) {
      if (res && res.status === 200 && res.type === "basic") {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(req).then(function (hit) {
        return hit || caches.match("index.html");
      });
    })
  );
});
