/* PUSHD's service worker: the installed app's offline page, and alerts with PUSHD closed (web push for holders).
 *
 * What it keeps: the /offline page and the files it needs, the app icons, and the site's own built files
 * (/_next/static/, named by their content, so a kept copy never goes stale). What it never keeps: any page (pages can
 * hold a holder's live feed), anything under /api/, /avatar/, /media/, and anything answered with no-store. Pages
 * always come from the network; only when the network fails does the offline page stand in.
 */
const CACHE = "pushd-shell-v1";
const SHELL = ["/offline", "/icons/192", "/icons/512"];
const LOCAL = self.location.hostname === "localhost" || self.location.hostname === "127.0.0.1";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE);
      await cache.addAll(SHELL);
      // the offline page's own CSS, scripts and fonts, so it draws in the site's look with no network
      try {
        const html = await (await fetch("/offline", { cache: "no-store" })).text();
        const files = [...new Set([...html.matchAll(/(?:href|src)="(\/_next\/static\/[^"]+)"/g)].map((m) => m[1]))];
        await cache.addAll(files);
      } catch {
        /* the page still shows, in plain type */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key !== CACHE && key.startsWith("pushd-")) await caches.delete(key);
      await self.clients.claim();
    })(),
  );
});

const never = (url) => /^\/(api|avatar|media|token\/launch)(\/|$)/.test(url.pathname);

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || never(url)) return;

  // a page: always the network; the offline page only when there is none
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(async () => (await caches.match("/offline")) || new Response("Offline", { status: 503, headers: { "content-type": "text/plain; charset=utf-8" } })),
    );
    return;
  }

  // the site's built files: from the cache when there (they never change under one name), kept on first fetch.
  // Locally (the dev server reuses names) the network goes first.
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(CACHE);
        if (!LOCAL) {
          const hit = await cache.match(req);
          if (hit) return hit;
        }
        try {
          const res = await fetch(req);
          if (res.ok && !/no-store/i.test(res.headers.get("cache-control") || "")) await cache.put(req, res.clone());
          return res;
        } catch (e) {
          const hit = await cache.match(req);
          if (hit) return hit;
          throw e;
        }
      })(),
    );
  }
});

// ---- alerts with PUSHD closed (engine: src/push.ts sends { id, title, body, url, tag }) ----

self.addEventListener("push", (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {
    d = { title: "PUSHD", body: event.data ? event.data.text() : "" };
  }
  const url = typeof d.url === "string" && d.url.startsWith("/") ? d.url : "/feed";
  event.waitUntil(
    self.registration.showNotification(d.title || "PUSHD", {
      body: d.body || "",
      icon: "/icons/192",
      badge: "/icons/192",
      tag: d.tag || undefined,
      data: { url },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/feed", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const w of wins) {
        if (new URL(w.url).origin === self.location.origin && "focus" in w) {
          await w.focus();
          if ("navigate" in w) await w.navigate(url).catch(() => undefined);
          return;
        }
      }
      await self.clients.openWindow(url);
    })(),
  );
});
