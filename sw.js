// Minimal service worker — its only job is to make the site installable as a PWA.
// Deliberately network-only with NO caching, so the dashboard is never served stale.
// It only intercepts top-level navigations; API calls, streaming, fonts, and all
// cross-origin requests pass straight through untouched.
self.addEventListener('install', function () {
  self.skipWaiting();
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', function (event) {
  if (event.request.mode === 'navigate') {
    event.respondWith(fetch(event.request));
  }
});
