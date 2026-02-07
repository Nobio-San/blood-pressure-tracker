/**
 * カメラ制御モジュール (Phase 2 Step 2-1)
 * 目的: PWA（Android）でカメラアクセス、プレビュー表示、静止画キャプチャを提供
 */

/* =========================================
   定数・設定
   ========================================= */
const MAX_CAPTURE_EDGE = 1280; // キャプチャ画像の最大辺長（px）
const DEBUG_MODE = true; // ログ出力フラグ（本番ではfalse）

/* =========================================
   内部状態
   ========================================= */
let stream = null; // MediaStreamインスタンス
let videoEl = null; // video要素参照
let isStarting = false; // 起動中フラグ（二重起動防止）

/* =========================================
   エラーコード定義
   ========================================= */
const ERROR_CODES = {
    NOT_SECURE_CONTEXT: 'NOT_SECURE_CONTEXT',
    NOT_ALLOWED: 'NotAllowedError',
    NOT_FOUND: 'NotFoundError',
    NOT_READABLE: 'NotReadableError',
    OVERCONSTRAINED: 'OverconstrainedError',
    NOT_SUPPORTED: 'NotSupportedError',
    TYPE_ERROR: 'TypeError',
    UNKNOWN: 'UNKNOWN'
};

/* =========================================
   ユーティリティ
   ========================================= */

/**
 * デバッグログ出力
 * @param {string} message - ログメッセージ
 * @param {any} data - 追加データ（任意）
 */
function log(message, data = null) {
    if (!DEBUG_MODE) return;
    if (data) {
        console.log(`[Camera] ${message}`, data);
    } else {
        console.log(`[Camera] ${message}`);
    }
}

/**
 * エラーを分類してユーザー向けメッセージを生成
 * @param {Error} error - 例外オブジェクト
 * @returns {{ code: string, message: string }} エラー情報
 */
function classifyError(error) {
    let code = error.name || ERROR_CODES.UNKNOWN;
    let message = '';

    switch (code) {
        case ERROR_CODES.NOT_ALLOWED:
            message = 'カメラの使用が許可されていません。\nブラウザの設定でカメラへのアクセスを許可してください。';
            break;
        case ERROR_CODES.NOT_FOUND:
            message = 'カメラが見つかりませんでした。\n端末にカメラが接続されているか確認してください。';
            break;
        case ERROR_CODES.NOT_READABLE:
            message = 'カメラが使用できません。\n他のアプリがカメラを使用している可能性があります。他のアプリを終了してから再度お試しください。';
            break;
        case ERROR_CODES.OVERCONSTRAINED:
            message = 'カメラの制約を満たせませんでした。\n別のカメラ設定で再試行します。';
            break;
        case ERROR_CODES.NOT_SUPPORTED:
        case ERROR_CODES.TYPE_ERROR:
            message = 'お使いのブラウザはカメラ機能に対応していません。\n最新版のChrome、Safari、Edgeをお試しください。';
            break;
        default:
            message = `カメラの起動に失敗しました。\nエラー: ${error.message || '不明なエラー'}`;
    }

    return { code, message };
}

/* =========================================
   公開API
   ========================================= */

/**
 * カメラを起動してプレビューを開始
 * @param {Object} options - オプション
 * @param {HTMLVideoElement} options.videoEl - video要素
 * @returns {Promise<{ ok: true } | { ok: false, error: { code: string, message: string } }>}
 */
async function startCamera({ videoEl: videoElement }) {
    log('startCamera() called');

    // セキュアコンテキストチェック
    if (!window.isSecureContext) {
        const error = {
            code: ERROR_CODES.NOT_SECURE_CONTEXT,
            message: 'カメラはHTTPSまたはlocalhostでのみ使用できます。\nセキュアな接続でアクセスしてください。'
        };
        log('Not secure context', error);
        return { ok: false, error };
    }

    // getUserMedia API対応チェック
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        const error = {
            code: ERROR_CODES.NOT_SUPPORTED,
            message: 'お使いのブラウザはカメラ機能に対応していません。\n最新版のChrome、Safari、Edgeをお試しください。'
        };
        log('getUserMedia not supported', error);
        return { ok: false, error };
    }

    // 二重起動防止
    if (isStarting || stream) {
        log('Camera already starting or started');
        return { ok: true };
    }

    isStarting = true;
    videoEl = videoElement;

    try {
        // まず背面カメラ優先で試行
        log('Requesting camera with facingMode: environment');
        stream = await navigator.mediaDevices.getUserMedia({
            video: {
                facingMode: { ideal: 'environment' },
                width: { ideal: 1920 },
                height: { ideal: 1080 }
            },
            audio: false
        });

        log('Camera stream obtained');
    } catch (err) {
        log('Failed with environment constraint, retrying with generic constraints', err);

        // Overconstrainedの場合は汎用constraintsで再試行
        if (err.name === ERROR_CODES.OVERCONSTRAINED) {
            try {
                stream = await navigator.mediaDevices.getUserMedia({
                    video: true,
                    audio: false
                });
                log('Camera stream obtained with generic constraints');
            } catch (retryErr) {
                isStarting = false;
                const error = classifyError(retryErr);
                log('Camera start failed (retry)', error);
                return { ok: false, error };
            }
        } else {
            isStarting = false;
            const error = classifyError(err);
            log('Camera start failed', error);
            return { ok: false, error };
        }
    }

    // video要素に割り当て
    try {
        videoEl.srcObject = stream;
        await videoEl.play();
        log('Video playback started');
        
        isStarting = false;
        return { ok: true };
    } catch (err) {
        log('Failed to play video', err);
        stopCamera();
        isStarting = false;
        const error = classifyError(err);
        return { ok: false, error };
    }
}

/**
 * カメラを停止してリソースを解放
 */
function stopCamera() {
    log('stopCamera() called');

    if (stream) {
        stream.getTracks().forEach(track => {
            track.stop();
            log(`Track stopped: ${track.kind}`);
        });
        stream = null;
    }

    if (videoEl) {
        videoEl.srcObject = null;
        videoEl = null;
    }

    isStarting = false;
    log('Camera stopped');
}

/**
 * 静止画をキャプチャ
 * @param {Object} options - オプション
 * @param {HTMLVideoElement} options.videoEl - video要素
 * @param {HTMLCanvasElement} options.canvasEl - canvas要素
 * @returns {Promise<{ blob: Blob, objectUrl: string, width: number, height: number }>}
 */
async function capturePhoto({ videoEl, canvasEl }) {
    log('capturePhoto() called');

    return new Promise((resolve, reject) => {
        // video要素の準備確認
        if (!videoEl || videoEl.readyState < 2) {
            const error = new Error('ビデオの準備ができていません');
            log('Video not ready', error);
            reject(error);
            return;
        }

        const videoWidth = videoEl.videoWidth;
        const videoHeight = videoEl.videoHeight;

        if (videoWidth === 0 || videoHeight === 0) {
            const error = new Error('ビデオの解像度が取得できません');
            log('Invalid video dimensions', error);
            reject(error);
            return;
        }

        log(`Capturing: ${videoWidth}x${videoHeight}`);

        // サイズ制御（縮小）
        let captureWidth = videoWidth;
        let captureHeight = videoHeight;
        const maxEdge = Math.max(captureWidth, captureHeight);

        if (maxEdge > MAX_CAPTURE_EDGE) {
            const scale = MAX_CAPTURE_EDGE / maxEdge;
            captureWidth = Math.round(captureWidth * scale);
            captureHeight = Math.round(captureHeight * scale);
            log(`Scaled down: ${captureWidth}x${captureHeight}`);
        }

        // canvasに描画
        canvasEl.width = captureWidth;
        canvasEl.height = captureHeight;

        const ctx = canvasEl.getContext('2d');
        ctx.drawImage(videoEl, 0, 0, captureWidth, captureHeight);

        // Blobに変換
        canvasEl.toBlob(
            (blob) => {
                if (!blob) {
                    const error = new Error('画像データの生成に失敗しました');
                    log('Failed to create blob', error);
                    reject(error);
                    return;
                }

                const objectUrl = URL.createObjectURL(blob);
                log(`Captured: ${blob.size} bytes, ${captureWidth}x${captureHeight}`);

                resolve({
                    blob,
                    objectUrl,
                    width: captureWidth,
                    height: captureHeight
                });
            },
            'image/jpeg',
            0.85
        );
    });
}

/* =========================================
   モジュールのエクスポート（グローバル公開）
   ========================================= */
// 既存のapp.jsがmoduleでない場合はグローバルに公開
window.CameraModule = {
    startCamera,
    stopCamera,
    capturePhoto
};
