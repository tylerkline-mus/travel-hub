// Travel Hub service worker — lets the app open with no signal.
// Pages: network first, fall back to the saved copy.
// Icons, fonts, map library: saved copy first.
// Map tiles: every tile you look at is kept, so maps you've viewed work offline later.
const CACHE = 'travelhub-v19';
const TILES = 'travelhub-tiles';
const MAX_TILES = 6000;            // roughly 100–150 MB at most; oldest are dropped first
const SHELL = ['./', './index.html', './manifest.webmanifest', './icon-180.png', './icon-192.png', './icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== TILES && k !== 'travelhub-ground').map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});

let trimming = false;
async function trimTiles() {
  if (trimming) return; trimming = true;
  try {
    const c = await caches.open(TILES);
    const keys = await c.keys();
    if (keys.length > MAX_TILES) await Promise.all(keys.slice(0, keys.length - MAX_TILES + 500).map(k => c.delete(k)));
  } finally { trimming = false; }
}

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // Never cache calls to your Apps Script — data always comes from the Sheet.
  if (url.hostname.endsWith('script.google.com') || url.hostname.endsWith('googleusercontent.com')) return;

  // Map tiles: saved copy first, otherwise fetch and keep.
  if (url.hostname === 'tile.openstreetmap.org') {
    e.respondWith(caches.open(TILES).then(c => c.match(req).then(hit => hit || fetch(req).then(res => {
      if (res.ok || res.type === 'opaque') { c.put(req, res.clone()); if (Math.random() < 0.02) trimTiles(); }
      return res;
    }))));
    return;
  }

  // The app page itself: try the network so updates arrive, fall back offline.
  if (req.mode === 'navigate' || (url.origin === location.origin && url.pathname.endsWith('.html'))) {
    e.respondWith(
      fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put('./index.html', copy));
        return res;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  // Icons, manifest, Google Fonts, the map library: cache first.
  if (url.origin === location.origin || url.hostname.includes('fonts.g') || url.hostname === 'cdnjs.cloudflare.com') {
    e.respondWith(
      caches.match(req).then(hit => hit || fetch(req).then(res => {
        const copy = res.clone();
        caches.open(CACHE).then(c => c.put(req, copy));
        return res;
      }))
    );
  }
});
