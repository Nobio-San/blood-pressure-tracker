/**
 * Service Worker - 血圧記録アプリ
 * 目的: オフライン時にもアプリシェル（HTML/CSS/JS）を表示できるようにする
 */

// キャッシュ名（バージョン管理用）
const CACHE_VERSION = 'v3';
const CACHE_NAME = `bp-cache-${CACHE_VERSION}`;

// プリキャッシュ対象（アプリシェル: 最小限から開始）
const PRECACHE_URLS = [
    './',
    './index.html',
    './css/style.css',
    './js/app.js',
    './js/sheets-api.js',
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
                // 新しいSWをすぐに有効化（今回は基本方針として skipWaiting() は使用しない）
                // return self.skipWaiting();
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
                return Promise.all(
                    cacheNames.map((cacheName) => {
                        // 現在のバージョン以外のキャッシュを削除
                        if (cacheName !== CACHE_NAME) {
                            console.log('[SW] 古いキャッシュを削除:', cacheName);
                            return caches.delete(cacheName);
                        }
                    })
                );
            })
            .then(() => {
                console.log('[SW] キャッシュクリーンアップ完了');
                // 既存のクライアントを即座に制御（今回は基本方針として clientsClaim() は使用しない）
                // return self.clients.claim();
            })
    );
});

/* =========================================
   fetch: リクエストのキャッシュ戦略
   ========================================= */
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);
    
    // GETリクエストのみ対象（POST等は触らない）
    if (request.method !== 'GET') {
        return;
    }
    
    // http/https 以外のスキームはスキップ
    // chrome-extension:// 等はCache APIが対応しないためエラーになる
    if (!request.url.startsWith('http')) {
        return;
    }
    
    // 外部API（Google Apps Script等）は常にネットワーク
    if (isExternalAPI(url)) {
        console.log('[SW] 外部API（キャッシュ対象外）:', url.href);
        event.respondWith(fetch(request));
        return;
    }
    
    // CDNは基本的にネットワーク優先（オフライン時はキャッシュがあれば使う）
    if (isCDN(url)) {
        event.respondWith(networkFirstStrategy(request));
        return;
    }
    
    // 静的アセット（HTML/CSS/JS/画像）はCache First
    event.respondWith(cacheFirstStrategy(request));
});

/* =========================================
   キャッシュ戦略: Cache First
   ========================================= */
async function cacheFirstStrategy(request) {
    try {
        // 1. キャッシュを確認
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            console.log('[SW] キャッシュヒット:', request.url);
            return cachedResponse;
        }
        
        // 2. キャッシュになければネットワークから取得
        console.log('[SW] ネットワークから取得:', request.url);
        const networkResponse = await fetch(request);
        
        // 3. 正常なレスポンスならキャッシュに保存
        if (networkResponse && networkResponse.status === 200) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, networkResponse.clone());
        }
        
        return networkResponse;
        
    } catch (error) {
        console.error('[SW] fetch エラー:', request.url, error);
        
        // オフライン時のフォールバック: トップページを返す
        const cachedFallback = await caches.match('./index.html');
        if (cachedFallback) {
            console.log('[SW] オフラインフォールバック: index.html');
            return cachedFallback;
        }
        
        // 最終フォールバック: エラーレスポンス
        return new Response('オフラインです。ネットワーク接続を確認してください。', {
            status: 503,
            statusText: 'Service Unavailable',
            headers: new Headers({
                'Content-Type': 'text/plain; charset=utf-8'
            })
        });
    }
}

/* =========================================
   キャッシュ戦略: Network First
   ========================================= */
async function networkFirstStrategy(request) {
    try {
        // 1. ネットワークから取得を試みる
        const networkResponse = await fetch(request);
        
        // 2. 正常なレスポンスならキャッシュに保存
        if (networkResponse && networkResponse.status === 200) {
            const cache = await caches.open(CACHE_NAME);
            cache.put(request, networkResponse.clone());
        }
        
        return networkResponse;
        
    } catch (error) {
        console.error('[SW] ネットワークエラー:', request.url, error);
        
        // 3. ネットワーク失敗時はキャッシュから返す
        const cachedResponse = await caches.match(request);
        if (cachedResponse) {
            console.log('[SW] キャッシュフォールバック:', request.url);
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
