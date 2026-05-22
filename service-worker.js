/**
 * CurrentRun — Service Worker
 *
 * Stratégie de cache:
 * - App shell (HTML/CSS/JS/icônes) → Cache-first
 *   L'app s'ouvre instantanément depuis le cache, même offline
 * - Données API (CEHQ, Open-Meteo, IWLS, Manisoft) → Network-first
 *   On essaie d'abord le réseau pour avoir les données fraîches
 *   Si pas de réseau, on retourne le cache pour ne pas planter
 *
 * Incrémente CACHE_VERSION quand tu modifies l'app pour forcer
 * un re-téléchargement chez tous les utilisateurs.
 */

const CACHE_VERSION = 'v7';
const APP_CACHE = `currentrun-app-${CACHE_VERSION}`;
const DATA_CACHE = `currentrun-data-${CACHE_VERSION}`;

// Fichiers essentiels de l'app (à mettre en cache à l'installation)
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

// Domaines d'API à cacher (data, pas app shell)
const API_DOMAINS = [
  'geoegl.msp.gouv.qc.ca',
  'api.open-meteo.com',
  'api-iwls.dfo-mpo.gc.ca',
  'pav.manisoft.ca',
  'pavnew.manisoft.ca',
  'pavnewtest.manisoft.ca',
  'api.allorigins.win'
];

// ─── INSTALL : préchargement de l'app shell ─────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(APP_CACHE)
      .then(cache => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

// ─── ACTIVATE : nettoyer les vieux caches ───────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== APP_CACHE && k !== DATA_CACHE)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ─── FETCH : routage selon le type de requête ───────────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Ne pas intercepter les requêtes non-GET
  if (req.method !== 'GET') return;

  // Stratégie pour les APIs : Network-first avec fallback cache
  if (API_DOMAINS.some(d => url.hostname.includes(d))) {
    event.respondWith(networkFirst(req));
    return;
  }

  // Stratégie pour Google Fonts : Cache-first
  if (url.hostname.includes('fonts.googleapis.com') ||
      url.hostname.includes('fonts.gstatic.com')) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Stratégie pour l'app shell (même origine) : Cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(req));
    return;
  }

  // Tout le reste : passer au réseau normalement
});

// ─── Stratégies ─────────────────────────────────────────────────────────────

async function cacheFirst(req) {
  const cached = await caches.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    // Mettre en cache si la réponse est valide
    if (res.ok) {
      const cache = await caches.open(APP_CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch (e) {
    // Pas de cache et pas de réseau — retourner une réponse vide
    return new Response('', { status: 503, statusText: 'Hors ligne' });
  }
}

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    // Cacher la réponse pour fallback offline (max 24h utile pour ces données)
    if (res.ok) {
      const cache = await caches.open(DATA_CACHE);
      cache.put(req, res.clone());
    }
    return res;
  } catch (e) {
    // Pas de réseau — retourner le dernier cache si disponible
    const cached = await caches.match(req);
    if (cached) return cached;
    return new Response('{"error":"offline"}', {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
