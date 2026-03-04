/**
 * Service Worker - 血圧記録アプリ
 * 目的: オフライン時にもアプリシェル（HTML/CSS/JS）を表示できるようにする
 */

// キャッシュ名（バージョン管理用・用途別分離）
const CACHE_VERSION = 'v6';
const STATIC_CACHE = `bp-static-${CACHE_VERSION}`;
const IMAGE_CACHE = `bp-images-${CACHE_VERSION}`;
const API_CACHE = `bp-api-${CACHE_VERSION}`;
const CACHE_NAME = STATIC_CACHE;

// プリキャッシュ対象（アプリシェル: 最小限）
const PRECACHE_URLS = [
    './',
    './index.html',
    './css/style.css',
    './js/constants.js',
    './js/settings.js?v=2',
    './js/notifications.js?v=2',
    './js/reminder.js?v=2',
    './js/image-preprocess.js',
    './js/seven-segment.js',
    './js/ocr.js?v=2',
    './js/app.js?v=3',
    './js/sheets-api.js?v=3',
    './manifest.json',
    './icons/icon-192.png',
    './icons/icon-512.png',
    './icons/apple-touch-icon.png'
];

// 外部API（キャッシュ対象外）
const EXTERNAL_API_PATTERNS = [
    'script.google.com',
    'script.googleusercontent.com'
];

// CDN（オフライン時は読み込めないが、アプリは継続動作）
const CDN_PATTERNS = [
    'cdn.jsdelivr.net'
];

/* =========================================
   install: プリキャッシュの登録
   ========================================= */
self.addEventListener('install', (event) => {
    console.log('[SW] Install event');
    
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                console.log('[SW] プリキャッシュを登録中...');
                // addAll は1つでも404があると失敗するため、最小限から開始
                return cache.addAll(PRECACHE_URLS);
            })
            .then(() => {
                console.log('[SW] プリキャッシュ完了');
                return self.skipWaiting();
            })
            .catch((error) => {
                console.error('[SW] プリキャッシュ失敗:', error);
                // プリキャッシュ失敗は致命的だが、既に登録済みのSWは動作継続
            })
    );
});

/* =========================================
   activate: 古いキャッシュの削除
   ========================================= */
self.addEventListener('activate', (event) => {
    console.log('[SW] Activate event');
    
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                const currentCaches = [STATIC_CACHE, IMAGE_CACHE, API_CACHE];
                return Promise.all(
                    cacheNames.map((cacheName) => {
                        if (!currentCaches.includes(cacheName)) {
                            console.log('[SW] 古いキャッシュを削除:', cacheName);
                            return caches.delete(cacheName);
                        }
                    })
                );
            })
            .then(() => {
                console.log('[SW] キャッシュクリーンアップ完了');
                return self.clients.claim();
            })
    );
});

// API Network First タイムアウト（ミリ秒）
const API_TIMEOUT_MS = 5000;
const IMAGE_CACHE_MAX_ENTRIES = 50;

/* =========================================
   fetch: リクエストのキャッシュ戦略
   ========================================= */
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);
    
    // POSTはキャッシュ対象外（同期キューで担保）
    if (request.method !== 'GET') {
        return;
    }
    
    if (!request.url.startsWith('http')) {
        return;
    }
    
    if (isExternalAPI(url)) {
        event.respondWith(fetch(request));
        return;
    }
    
    if (isCDN(url)) {
        event.respondWith(networkFirstWithTimeout(request, API_CACHE, API_TIMEOUT_MS));
        return;
    }
    
    if (request.destination === 'image') {
        event.respondWith(cacheFirstStrategy(request, IMAGE_CACHE));
        return;
    }
    
    event.respondWith(cacheFirstStrategy(request, STATIC_CACHE));
});

/* =========================================
   キャッシュ戦略: Cache First
   ========================================= */
async function cacheFirstStrategy(request, cacheName) {
    const cacheToUse = cacheName || STATIC_CACHE;
    try {
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            return cachedResponse;
        }
        
        const networkResponse = await fetch(request);
        
        if (networkResponse && networkResponse.status === 200) {
            const cache = await caches.open(cacheToUse);
            if (cacheToUse === IMAGE_CACHE) {
                await trimImageCacheIfNeeded(cache);
            }
            cache.put(request, networkResponse.clone());
        }
        
        return networkResponse;
        
    } catch (error) {
        if (request.mode === 'navigate') {
            const cachedFallback = await caches.match('./index.html');
            if (cachedFallback) {
                return cachedFallback;
            }
        }
        
        return new Response('オフラインです。ネットワーク接続を確認してください。', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: new Headers({
                'Content-Type': 'text/plain; charset=utf-8'
            })
        });
    }
}

async function trimImageCacheIfNeeded(cache) {
    const keys = await cache.keys();
    if (keys.length >= IMAGE_CACHE_MAX_ENTRIES) {
        await cache.delete(keys[0]);
    }
}

/* =========================================
   キャッシュ戦略: Network First（タイムアウト付き）
   ========================================= */
async function networkFirstWithTimeout(request, cacheName, timeoutMs) {
    const cacheToUse = cacheName || API_CACHE;
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        const networkResponse = await fetch(request, { signal: controller.signal });
        clearTimeout(timeoutId);
        
        if (networkResponse && networkResponse.status === 200) {
            const cache = await caches.open(cacheToUse);
            cache.put(request, networkResponse.clone());
        }
        
        return networkResponse;
        
    } catch (error) {
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            return cachedResponse;
        }
        throw error;
    }
}

/* =========================================
   ヘルパー関数
   ========================================= */

/**
 * 外部API（キャッシュ対象外）かどうかを判定
 * @param {URL} url - 判定するURL
 * @returns {boolean} 外部APIならtrue
 */
function isExternalAPI(url) {
    return EXTERNAL_API_PATTERNS.some(pattern => url.href.includes(pattern));
}

/**
 * CDN（ネットワーク優先）かどうかを判定
 * @param {URL} url - 判定するURL
 * @returns {boolean} CDNならtrue
 */
function isCDN(url) {
    return CDN_PATTERNS.some(pattern => url.href.includes(pattern));
}

/* =========================================
   notificationclick: 通知タップでアプリをフォーカス/起動（Phase 4 Step 4-4）
   ========================================= */
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    const urlToOpen = './?from=notification&type=' + (event.notification.data?.type || 'reminder');

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then((clientList) => {
                for (const client of clientList) {
                    if (client.url.includes(self.registration.scope) && 'focus' in client) {
                        client.navigate(urlToOpen);
                        return client.focus();
                    }
                }
                if (self.clients.openWindow) {
                    return self.clients.openWindow(urlToOpen);
                }
            })
    );
});

/* =========================================
   sync: Background Sync（Phase 4 Step 4-5・対応環境のみ）
   ========================================= */
self.addEventListener('sync', (event) => {
    if (event.tag === 'bp-sync') {
        event.waitUntil(
            self.clients.matchAll({ type: 'window', includeUncontrolled: true })
                .then((clientList) => {
                    for (const client of clientList) {
                        if (client.url.includes(self.registration.scope)) {
                            client.postMessage({ type: 'flushSyncQueue' });
                            break;
                        }
                    }
                })
        );
    }
});

/* =========================================
   push: 将来のPush拡張用雛形（Phase 4 Step 4-4）
   ========================================= */
self.addEventListener('push', (event) => {
    if (!event.data) return;
    try {
        const payload = event.data.json();
        const title = payload?.title || '血圧記録アプリ';
        const options = {
            body: payload?.body || '',
            icon: './icons/icon-192.png',
            data: payload?.data || {}
        };
        event.waitUntil(
            self.registration.showNotification(title, options)
        );
    } catch (e) {
        console.warn('[SW] push payload parse error:', e);
    }
});
