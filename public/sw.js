const CACHE = 'lpos-shell-v2';
const SHELL_URLS = ['/', '/projects', '/media', '/slate', '/dashboard'];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL_URLS))
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Push notifications ────────────────────────────────────────────────────────

self.addEventListener('push', (e) => {
  const data = e.data ? e.data.json() : {};
  e.waitUntil(
    self.registration.showNotification(data.title ?? 'LPOS', {
      body: data.body ?? '',
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      data: { taskId: data.taskId },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const taskId = e.notification.data?.taskId;
  const url = taskId ? `/dashboard?task=${taskId}` : '/dashboard';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          client.navigate(url);
          return client.focus();
        }
      }
      return clients.openWindow(url);
    })
  );
});

// ── Fetch cache ───────────────────────────────────────────────────────────────

self.addEventListener('fetch', (e) => {
  // Only handle same-origin GET requests; skip API routes entirely
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) return;

  // Never serve cached HTML for navigation requests — Next.js rebuilds produce
  // new content-hashed CSS/JS filenames, so a stale cached HTML document will
  // reference assets that no longer exist, causing an unstyled page.
  if (e.request.mode === 'navigate') return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      const network = fetch(e.request).then((res) => {
        // Update cache with fresh response for shell URLs
        if (SHELL_URLS.includes(url.pathname)) {
          caches.open(CACHE).then((cache) => cache.put(e.request, res.clone()));
        }
        return res;
      });
      // Return cached immediately if available, otherwise wait for network
      return cached || network;
    })
  );
});
