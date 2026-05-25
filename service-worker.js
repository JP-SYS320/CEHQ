/**
 * CurrentRun — Service Worker v9
 *
 * v9 (bump CACHE_VERSION → v12) :
 * - Force le redéploiement complet du cache pour livrer index.html v1.16-outlier-fix
 * - Aucun changement de logique, juste le bump de version
 *
 * Corrections v8 :
 * - Bypass du cache HTTP Safari iOS via {cache: 'reload'} sur les fetchs
 *   du HTML (sinon Safari iOS sert sa propre copie cachée pendant des heures)
 * - Comparaison fonctionne même au premier fetch (pas seulement quand cached existe)
 * - Cache-buster sur le HTML pour forcer un téléchargement frais
 *
 * Stratégie:
 * - HTML / racine → Stale-while-revalidate avec fetch forcé réseau
 * - Autres app shell (icons, manifest) → Cache-first
 * - APIs externes → Network-first
 * - Google Fonts → Cache-first
 */

const CACHE_VERSION = 'v12';
const APP_CACHE = `currentrun-app-${CACHE_VERSION}`;
const DATA_CACHE = `currentrun-data-${CACHE_VERSION}`;

const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-180.png',
  './icons/icon-167.png',
  './icons/icon-152.png',
  './icons/icon-120.png',
  './icons/favicon-32.png'
];

const API_DOMAINS = [
  'geoegl.msp.gouv.qc.ca',
  'api.open-meteo.com',
  'api-iwls.dfo-mpo.gc.ca',
  'pav.manisoft.ca',
  'pavnew.manisoft.ca',
  'pavnewtest.manisoft.ca',
  'api.allorigins.win'
];

// Détecte si une requête est pour le HTML principal
function isHtmlRequest(req) {
  const url = new URL(req.url);
  return url.pathname.endsWith('/') ||
         url.pathname.endsWith('/index.html') ||
         req.mode === 'navigate' ||
         req.destination === 'document';
}

// ─── INSTALL ────────────────────────────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then(async cache => {
        // Pour le HTML, on force {cache: 'reload'} pour bypasser le cache HTTP
        // Pour les autres, fetch normal suffit
        const htmlRequests = ['./', './index.html'];
        await Promise.all([
          // HTML : fetch forcé réseau
          ...htmlRequests.map(url =>
            fetch(url, { cache: 'reload' })
              .then(res => res.ok && cache.put(url, res))
              .catch(() => {})
          ),
          // Reste : addAll standard
          cache.addAll(APP_SHELL.filter(url => !htmlRequests.includes(url)))
        ]);
      })
      .then(() => self.skipWaiting())
  );
});

// ─── ACTIVATE ───────────────────────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(k => k !== APP_CACHE && k !== DATA_CACHE)
          .map(k => caches.delete(k))
      );
      await self.clients.claim();
      const clients = await self.clients.matchAll({ type: 'window' });
      clients.forEach(client => {
        client.postMessage({ type: 'SW_UPDATED', version: CACHE_VERSION });
      });
    })()
  );
});

// ─── FETCH : routage ────────────────────────────────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  if (req.method !== 'GET') return;

  // Bypass total pour les requêtes de vérification (cache-buster _swcheck)
  // Sinon on aurait une boucle vicieuse : le SW intercepterait sa propre requête
  if (url.searchParams.has('_swcheck')) return;

  // APIs : network-first
  if (API_DOMAINS.some(d => url.hostname.includes(d))) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Google Fonts : cache-first
  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Même origine
  if (url.origin === self.location.origin) {
    // HTML : stale-while-revalidate avec bypass cache HTTP
    if (isHtmlRequest(req)) {
      event.respondWith(staleWhileRevalidateHtml(req));
      return;
    }
    // Autres ressources (icons, manifest) : cache-first
    event.respondWith(cacheFirst(req));
    return;
  }
});

// ─── Stratégies ─────────────────────────────────────────────────────────────

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(APP_CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch (e) {
    return new Response('', { status: 503, statusText: 'Hors ligne' });
  }
}

// Stale-while-revalidate spécial HTML :
// - Sert le cache instantanément
// - Lance un fetch RÉSEAU FORCÉ (bypass cache HTTP Safari iOS) en parallèle
// - Compare et notifie le client si différent
async function staleWhileRevalidateHtml(req) {
  const cache = await caches.open(APP_CACHE);
  const cached = await cache.match(req) || await cache.match('./index.html') || await cache.match('./');

  // IMPORTANT : {cache: 'reload'} force Safari à bypasser son cache HTTP
  // Sans ça, Safari iOS sert sa propre copie cachée et ne télécharge jamais
  // la nouvelle version.
  const networkUpdate = fetch(req.url, { cache: 'reload', credentials: 'same-origin' })
    .then(async res => {
      if (!res.ok) return res;
      const newText = await res.clone().text();

      // Comparer avec le cache si on en a un
      if (cached) {
        try {
          const oldText = await cached.clone().text();
          if (newText !== oldText) {
            // Le HTML a changé — mettre en cache et notifier
            await cache.put(req, res.clone());
            const clients = await self.clients.matchAll({ type: 'window' });
            clients.forEach(client => {
              client.postMessage({ type: 'APP_UPDATED' });
            });
            return res;
          }
        } catch(e) {}
      }
      // Pas de changement ou premier fetch : juste mettre en cache
      await cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);

  return cached || networkUpdate || new Response('', { status: 503 });
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    if (res.ok) {
      const cache = await caches.open(DATA_CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch (e) {
    const cached = await caches.match(req);
    if (cached) return cached;
    return new Response('{"error":"offline"}', {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

// ─── Vérification périodique des updates ────────────────────────────────────
self.addEventListener('message', event => {
  if (event.data?.type === 'CHECK_UPDATE') {
    // Répondre directement au client qui a envoyé le message
    // (plus fiable que matchAll qui peut retourner 0 si SW redémarré)
    const source = event.source;
    if (source) {
      source.postMessage({ type: 'SW_LOG', msg: 'CHECK_UPDATE reçu (direct)', color: '#7a9ab0' });
    }
    checkForUpdate(source);
  }
});

async function checkForUpdate(source) {
  // Helper : log vers la source si dispo, sinon vers tous les clients
  const log = async (msg, color) => {
    try {
      if (source) {
        source.postMessage({ type: 'SW_LOG', msg, color });
      } else {
        const clients = await self.clients.matchAll({ type: 'window' });
        clients.forEach(c => c.postMessage({ type: 'SW_LOG', msg, color }));
      }
    } catch(e) {}
  };

  try {
    await log('checkForUpdate: début');
    const cache = await caches.open(APP_CACHE);
    const cached = await cache.match('./') || await cache.match('./index.html');
    if (!cached) {
      await log('checkForUpdate: pas de cache, abandon', '#f06260');
      return;
    }
    await log('checkForUpdate: cache trouvé, fetch réseau...');
    const bustUrl = `./index.html?_swcheck=${Date.now()}`;
    const res = await fetch(bustUrl, { cache: 'reload', credentials: 'same-origin' });
    await log(`checkForUpdate: fetch status=${res.status}`);
    if (!res.ok) {
      await log(`checkForUpdate: fetch pas OK, abandon`, '#f06260');
      return;
    }
    const newText = await res.clone().text();
    const oldText = await cached.clone().text();
    await log(`checkForUpdate: tailles new=${newText.length} old=${oldText.length}`);
    if (newText !== oldText) {
      await log(`checkForUpdate: HTML différent! Notification...`, '#4ade9a');
      const newRes = new Response(newText, {
        headers: res.headers,
        status: res.status,
        statusText: res.statusText
      });
      await cache.put('./', newRes.clone());
      await cache.put('./index.html', newRes.clone());
      const clients = await self.clients.matchAll({ type: 'window' });
      await log(`checkForUpdate: envoi APP_UPDATED à ${clients.length} clients`);
      clients.forEach(client => {
        client.postMessage({ type: 'APP_UPDATED' });
      });
      // Aussi notifier le source directement (au cas où matchAll retourne 0)
      if (source) source.postMessage({ type: 'APP_UPDATED' });
    } else {
      await log('checkForUpdate: HTML identique, rien à faire');
    }
  } catch(e) {
    await log(`checkForUpdate ERREUR: ${e.message}`, '#f06260');
  }
}
