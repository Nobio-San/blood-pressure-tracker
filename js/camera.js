/**
 * カメラ制御モジュール (Phase 2 Step 2-1)
 * 目的: PWA（Android）でカメラアクセス、プレビュー表示、静止画キャプチャを提供
 */

/* =========================================
   定数・設定
   ========================================= */
const MAX_CAPTURE_EDGE = 1280; // キャプチャ画像の最大辺長（px）
const DEBUG_MODE = true; // ログ出力フラグ（本番ではfalse）

// Phase 2 Step 2-2: 画像プレビュー・最適化関連
const RESIZE_MAX_EDGE = 1280; // 最適化後の最大辺長（px）
const JPEG_QUALITY = 0.8; // JPEG圧縮品質（0.0〜1.0、OCR前提で高めに設定）
const OUTPUT_MIME = 'image/jpeg'; // 出力MIME type
const CAMERA_STORAGE_KEY = 'bp:lastCapturedImage'; // sessionStorage保存キー

// Phase 2 Step 2-3: 撮影ガイド機能関連
const GUIDE_CONFIG = {
    // ガイド枠サイズ（コンテナに対する割合）
    // 数値列のみに絞る縦長枠（OMRONロゴ・ラベル・余白を除外してOCR精度向上）
    frameWidthRatio: 0.50,          // 幅: コンテナの50%
    frameHeightRatio: 0.52,         // 高さ: コンテナの52%
    frameAspect: 0.45,              // 縦横比（幅/高さ=0.45で縦長の数値列枠）
    
    // マスク設定
    maskColor: 'rgba(0, 0, 0, 0.45)', // マスクの濃度
    
    // 枠スタイル
    frameBorderWidth: 3,            // 枠線の太さ（px）
    frameBorderColor: '#4a90e2',    // 枠線の色
    frameBorderRadius: 8,           // 枠の角丸（px）
    
    // テキスト設定
    guideText: '数値（最高・最低血圧・脈拍）のみを枠内に合わせてください',
    hintText: '明るい場所で、反射に注意してください',
    textFontSize: 18,               // フォントサイズ（px）
    textColor: '#ffffff',           // テキストの色
    textBackgroundColor: 'rgba(0, 0, 0, 0.7)', // テキスト背景の色
    
    // グリッド設定
    gridEnabled: false,             // グリッド表示ON/OFF
    gridColor: 'rgba(255, 255, 255, 0.3)', // グリッド線の色
    
    // 下部余白（操作UI領域を避ける）
    bottomSafetyMargin: 20,         // 操作UIとの間の余白（px）
    
    // リサイズデバウンス時間
    resizeDebounceMs: 150           // リサイズイベントのデバウンス（ms）
};

/* =========================================
   状態定義（State Machine）
   ========================================= */
const STATE = {
    CAMERA_PREVIEW: 'CAMERA_PREVIEW',   // カメラプレビュー表示中
    PROCESSING: 'PROCESSING',           // 画像処理中（縮小/圧縮/回転）
    PHOTO_PREVIEW: 'PHOTO_PREVIEW'      // 撮影画像プレビュー表示中
};

/* =========================================
   内部状態
   ========================================= */
let stream = null; // MediaStreamインスタンス
let videoEl = null; // video要素参照
let isStarting = false; // 起動中フラグ（二重起動防止）
let currentState = STATE.CAMERA_PREVIEW; // 現在の状態
let currentPhotoData = null; // 撮影中の画像データ（一時保持）
let originalCapturedBlob = null; // 撮影直後のオリジナルblob（回転用）
let currentObjectUrl = null; // 表示用Object URL（revoke用）
let rotationAngle = 0; // 現在の回転角（0/90/180/270）

// Phase 2 Step 2-3: ガイド機能用の内部状態
let guideOverlayEl = null; // ガイドオーバーレイ要素
let guideFrameEl = null; // ガイド枠要素
let resizeObserver = null; // リサイズ監視
let resizeTimer = null; // デバウンス用タイマー
let currentGuideROI = { x: 0, y: 0, w: 0, h: 0 }; // 現在のROI（正規化座標）

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
 * 状態を変更する（ログ付き）
 * @param {string} newState - 新しい状態
 */
function setState(newState) {
    log(`State transition: ${currentState} -> ${newState}`);
    currentState = newState;
}

/**
 * 画像を縮小・圧縮する
 * @param {Blob} inputBlob - 入力画像blob
 * @param {number} rotation - 回転角度（0/90/180/270）
 * @returns {Promise<{ blob: Blob, base64: string, width: number, height: number }>}
 */
async function optimizeImage(inputBlob, rotation = 0) {
    log(`optimizeImage() called, rotation: ${rotation}`);
    
    return new Promise((resolve, reject) => {
        const img = new Image();
        const tempUrl = URL.createObjectURL(inputBlob);
        
        img.onload = () => {
            // 一時URLを解放
            URL.revokeObjectURL(tempUrl);
            
            try {
                // 回転を考慮したサイズ計算
                let srcWidth = img.width;
                let srcHeight = img.height;
                
                // 縮小計算
                let targetWidth = srcWidth;
                let targetHeight = srcHeight;
                const maxEdge = Math.max(srcWidth, srcHeight);
                
                if (maxEdge > RESIZE_MAX_EDGE) {
                    const scale = RESIZE_MAX_EDGE / maxEdge;
                    targetWidth = Math.round(srcWidth * scale);
                    targetHeight = Math.round(srcHeight * scale);
                    log(`Resizing: ${srcWidth}x${srcHeight} -> ${targetWidth}x${targetHeight}`);
                }
                
                // 90度または270度回転の場合、canvas のサイズを入れ替え
                let canvasWidth = targetWidth;
                let canvasHeight = targetHeight;
                if (rotation === 90 || rotation === 270) {
                    canvasWidth = targetHeight;
                    canvasHeight = targetWidth;
                }
                
                // canvasに描画
                const canvas = document.createElement('canvas');
                canvas.width = canvasWidth;
                canvas.height = canvasHeight;
                const ctx = canvas.getContext('2d');
                
                // 回転を適用
                if (rotation !== 0) {
                    // canvas中央を原点に移動
                    ctx.translate(canvasWidth / 2, canvasHeight / 2);
                    // 回転
                    ctx.rotate((rotation * Math.PI) / 180);
                    // 画像を中央に配置
                    ctx.drawImage(img, -targetWidth / 2, -targetHeight / 2, targetWidth, targetHeight);
                } else {
                    ctx.drawImage(img, 0, 0, targetWidth, targetHeight);
                }
                
                // Blobに変換
                canvas.toBlob(
                    (blob) => {
                        if (!blob) {
                            reject(new Error('画像の最適化に失敗しました'));
                            return;
                        }
                        
                        // Base64に変換
                        const reader = new FileReader();
                        reader.onload = () => {
                            const base64 = reader.result;
                            log(`Optimized: ${blob.size} bytes, ${canvasWidth}x${canvasHeight}`);
                            
                            resolve({
                                blob,
                                base64,
                                width: canvasWidth,
                                height: canvasHeight
                            });
                        };
                        reader.onerror = () => {
                            reject(new Error('Base64変換に失敗しました'));
                        };
                        reader.readAsDataURL(blob);
                    },
                    OUTPUT_MIME,
                    JPEG_QUALITY
                );
            } catch (err) {
                log('Image optimization failed', err);
                reject(err);
            }
        };
        
        img.onerror = () => {
            URL.revokeObjectURL(tempUrl);
            reject(new Error('画像の読み込みに失敗しました'));
        };
        
        img.src = tempUrl;
    });
}

/**
 * 画像をsessionStorageに保存
 * @param {Object} imageData - 画像データ
 * @param {string} imageData.base64 - Base64画像
 * @param {number} imageData.width - 幅
 * @param {number} imageData.height - 高さ
 * @returns {boolean} 保存成功/失敗
 */
function saveToSessionStorage(imageData) {
    try {
        const payload = {
            base64: imageData.base64,
            width: imageData.width,
            height: imageData.height,
            mime: OUTPUT_MIME,
            createdAt: new Date().toISOString(),
            rotation: rotationAngle
        };
        
        sessionStorage.setItem(CAMERA_STORAGE_KEY, JSON.stringify(payload));
        log('Image saved to sessionStorage', {
            size: imageData.base64.length,
            dimensions: `${imageData.width}x${imageData.height}`
        });
        return true;
    } catch (err) {
        log('Failed to save to sessionStorage', err);
        return false;
    }
}

/**
 * sessionStorageから画像を削除
 */
function clearSessionStorage() {
    try {
        sessionStorage.removeItem(CAMERA_STORAGE_KEY);
        log('Session storage cleared');
    } catch (err) {
        log('Failed to clear sessionStorage', err);
    }
}

/**
 * Object URLを破棄（メモリリーク対策）
 */
function revokeCurrentObjectUrl() {
    if (currentObjectUrl) {
        URL.revokeObjectURL(currentObjectUrl);
        log('Object URL revoked');
        currentObjectUrl = null;
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

    // プレビューデータもクリーンアップ
    revokeCurrentObjectUrl();
    currentPhotoData = null;
    originalCapturedBlob = null;
    rotationAngle = 0;

    // Phase 2 Step 2-3: ガイドのクリーンアップ
    disposeGuide();

    isStarting = false;
    setState(STATE.CAMERA_PREVIEW);
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

/**
 * 撮影後の処理フロー（撮影→最適化→プレビュー表示）
 * @param {Object} options - オプション
 * @param {Blob} options.capturedBlob - 撮影したblob
 * @param {HTMLImageElement} options.previewImg - プレビュー表示用のimg要素
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function processCapturedPhoto({ capturedBlob, previewImg }) {
    log('processCapturedPhoto() called');
    setState(STATE.PROCESSING);
    
    try {
        // 既存のObject URLを破棄
        revokeCurrentObjectUrl();
        
        // オリジナルblobを保存（回転用）
        originalCapturedBlob = capturedBlob;
        rotationAngle = 0; // 初回は回転なし
        
        // 画像を最適化（縮小・圧縮・回転）
        const optimized = await optimizeImage(capturedBlob, rotationAngle);
        
        // プレビュー表示用のObject URLを生成
        currentObjectUrl = URL.createObjectURL(optimized.blob);
        currentPhotoData = optimized;
        
        // img要素に表示
        if (previewImg) {
            previewImg.src = currentObjectUrl;
        }
        
        setState(STATE.PHOTO_PREVIEW);
        log('Photo preview ready');
        
        return { ok: true };
    } catch (err) {
        log('Failed to process photo', err);
        setState(STATE.CAMERA_PREVIEW);
        return { ok: false, error: err.message || '画像処理に失敗しました' };
    }
}

/**
 * 再撮影（プレビュー→カメラプレビューへ戻る）
 */
function retakePhoto() {
    log('retakePhoto() called');
    
    // 一時データをクリア
    revokeCurrentObjectUrl();
    currentPhotoData = null;
    originalCapturedBlob = null;
    rotationAngle = 0;
    
    setState(STATE.CAMERA_PREVIEW);
}

/**
 * 画像を90度回転
 * @param {HTMLImageElement} previewImg - プレビュー表示用のimg要素
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function rotatePhoto({ previewImg }) {
    log('rotatePhoto() called');
    
    if (!originalCapturedBlob || currentState !== STATE.PHOTO_PREVIEW) {
        return { ok: false, error: '回転できる画像がありません' };
    }
    
    setState(STATE.PROCESSING);
    
    try {
        // 回転角を更新（90度ずつ）
        rotationAngle = (rotationAngle + 90) % 360;
        log(`Rotation angle: ${rotationAngle}`);
        
        // オリジナルblobから再度最適化（新しい回転角で）
        const optimized = await optimizeImage(originalCapturedBlob, rotationAngle);
        
        // Object URLを更新
        revokeCurrentObjectUrl();
        currentObjectUrl = URL.createObjectURL(optimized.blob);
        currentPhotoData = optimized;
        
        if (previewImg) {
            previewImg.src = currentObjectUrl;
        }
        
        setState(STATE.PHOTO_PREVIEW);
        return { ok: true };
    } catch (err) {
        log('Failed to rotate photo', err);
        setState(STATE.PHOTO_PREVIEW);
        return { ok: false, error: err.message || '回転に失敗しました' };
    }
}

/**
 * 画像を採用（sessionStorageに保存 + app.jsへイベント通知）
 * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
 */
async function usePhoto() {
    log('usePhoto() called');
    
    if (!currentPhotoData || currentState !== STATE.PHOTO_PREVIEW) {
        return { ok: false, error: '採用できる画像がありません' };
    }
    
    try {
        // sessionStorageに保存
        const saved = saveToSessionStorage(currentPhotoData);
        
        if (!saved) {
            // 保存失敗時、画質を下げて再試行
            log('Retrying with lower quality');
            const retryBlob = await new Promise((resolve, reject) => {
                const canvas = document.createElement('canvas');
                const img = new Image();
                img.onload = () => {
                    canvas.width = currentPhotoData.width;
                    canvas.height = currentPhotoData.height;
                    const ctx = canvas.getContext('2d');
                    ctx.drawImage(img, 0, 0);
                    
                    canvas.toBlob(
                        (blob) => {
                            if (!blob) {
                                reject(new Error('再生成失敗'));
                                return;
                            }
                            const reader = new FileReader();
                            reader.onload = () => resolve({ 
                                base64: reader.result,
                                width: currentPhotoData.width,
                                height: currentPhotoData.height
                            });
                            reader.onerror = () => reject(new Error('Base64変換失敗'));
                            reader.readAsDataURL(blob);
                        },
                        OUTPUT_MIME,
                        0.6 // 画質を下げる
                    );
                };
                img.onerror = () => reject(new Error('画像読み込み失敗'));
                img.src = currentObjectUrl;
            });
            
            const retrySaved = saveToSessionStorage(retryBlob);
            if (!retrySaved) {
                return { ok: false, error: '画像の保存に失敗しました（容量制限の可能性があります）' };
            }
        }
        
        log('Photo saved successfully');
        
        // Phase 2 Step 2-4: app.jsへ画像選択イベントを通知
        dispatchImageSelectedEvent(currentPhotoData);
        
        return { ok: true };
    } catch (err) {
        log('Failed to use photo', err);
        return { ok: false, error: err.message || '画像の保存に失敗しました' };
    }
}

/**
 * Phase 2 Step 2-4: 画像選択イベントをdocumentに通知
 * 入力: 画像データ
 * 出力: なし
 * 副作用: CustomEventをdispatch
 * @param {Object} imageData - 画像データ
 */
function dispatchImageSelectedEvent(imageData) {
    try {
        const event = new CustomEvent('bp:image:selected', {
            detail: {
                base64: imageData.base64,
                width: imageData.width,
                height: imageData.height,
                mime: OUTPUT_MIME,
                createdAt: new Date().toISOString(),
                rotation: rotationAngle
            }
        });
        
        document.dispatchEvent(event);
        log('Image selected event dispatched', {
            width: imageData.width,
            height: imageData.height
        });
    } catch (err) {
        log('Failed to dispatch image selected event', err);
    }
}

/* =========================================
   Phase 2 Step 2-3: 撮影ガイド機能
   ========================================= */

/**
 * ガイドオーバーレイを生成してコンテナに追加
 * 入力: プレビューコンテナ要素
 * 出力: なし
 * 副作用: DOM生成・追加、内部変数（guideOverlayEl, guideFrameEl）の更新
 * @param {HTMLElement} containerEl - プレビューコンテナ要素
 */
function createGuideOverlay(containerEl) {
    log('createGuideOverlay() called');
    
    // 既存のガイドを削除（念のため）
    if (guideOverlayEl) {
        disposeGuide();
    }
    
    // オーバーレイ要素を生成
    guideOverlayEl = document.createElement('div');
    guideOverlayEl.className = 'camera-guide';
    guideOverlayEl.setAttribute('aria-hidden', 'true');
    
    // ガイド枠を生成
    guideFrameEl = document.createElement('div');
    guideFrameEl.className = 'camera-guide__frame';
    
    // グリッド（任意）
    if (GUIDE_CONFIG.gridEnabled) {
        const gridEl = document.createElement('div');
        gridEl.className = 'camera-guide__grid';
        guideFrameEl.appendChild(gridEl);
    }
    
    // 案内テキストを生成
    const textEl = document.createElement('div');
    textEl.className = 'camera-guide__text';
    textEl.textContent = GUIDE_CONFIG.guideText;
    
    // ヒントテキストを生成（任意）
    if (GUIDE_CONFIG.hintText) {
        const hintEl = document.createElement('div');
        hintEl.className = 'camera-guide__hint';
        hintEl.textContent = GUIDE_CONFIG.hintText;
        textEl.appendChild(hintEl);
    }
    
    // オーバーレイに追加
    guideOverlayEl.appendChild(guideFrameEl);
    guideOverlayEl.appendChild(textEl);
    
    // コンテナに追加
    containerEl.appendChild(guideOverlayEl);
    
    log('Guide overlay created');
}

/**
 * ガイドレイアウトを計算・更新
 * 入力: コンテナ矩形
 * 出力: なし
 * 副作用: ガイド要素のstyle更新、currentGuideROIの更新
 * 注意: 操作ボタンはプレビューコンテナの外にあるため、干渉回避は不要
 * @param {Object} options - オプション
 * @param {DOMRect} options.containerRect - プレビューコンテナの矩形
 */
function updateGuideLayout({ containerRect }) {
    if (!guideFrameEl || !guideOverlayEl) {
        log('Guide elements not initialized');
        return;
    }
    
    const containerWidth = containerRect.width;
    const containerHeight = containerRect.height;
    
    if (containerWidth === 0 || containerHeight === 0) {
        log('Container has no dimensions, skipping layout');
        return;
    }
    
    // 枠サイズを計算
    let frameWidth = containerWidth * GUIDE_CONFIG.frameWidthRatio;
    let frameHeight = containerHeight * GUIDE_CONFIG.frameHeightRatio;
    
    // 縦横比が指定されている場合は調整
    if (GUIDE_CONFIG.frameAspect) {
        const currentAspect = frameWidth / frameHeight;
        if (currentAspect > GUIDE_CONFIG.frameAspect) {
            frameWidth = frameHeight * GUIDE_CONFIG.frameAspect;
        } else {
            frameHeight = frameWidth / GUIDE_CONFIG.frameAspect;
        }
    }
    
    // 枠の位置を計算（コンテナの中央に配置）
    const frameLeft = (containerWidth - frameWidth) / 2;
    const frameTop = (containerHeight - frameHeight) / 2;
    
    // スタイルを適用
    guideFrameEl.style.width = `${frameWidth}px`;
    guideFrameEl.style.height = `${frameHeight}px`;
    guideFrameEl.style.left = `${frameLeft}px`;
    guideFrameEl.style.top = `${frameTop}px`;
    
    // 案内テキストの位置を更新（枠の上に配置、重ならないように）
    const textEl = guideOverlayEl.querySelector('.camera-guide__text');
    if (textEl) {
        const textHeight = textEl.offsetHeight || 60;
        const gap = 12; // 枠とテキストの間隔（px）
        const textTop = frameTop - textHeight - gap;
        
        if (textTop >= 8) {
            // 枠の上にテキストが収まる場合
            textEl.style.top = `${textTop}px`;
            textEl.style.bottom = '';
        } else {
            // 上に収まらない場合は枠の下に配置
            const textBottom = containerHeight - (frameTop + frameHeight) - gap;
            if (textBottom >= textHeight) {
                textEl.style.top = `${frameTop + frameHeight + gap}px`;
                textEl.style.bottom = '';
            } else {
                // どちらも十分でなければ上端に配置
                textEl.style.top = '8px';
                textEl.style.bottom = '';
            }
        }
    }
    
    // ROI（正規化座標）を更新
    currentGuideROI = {
        x: frameLeft / containerWidth,
        y: frameTop / containerHeight,
        w: frameWidth / containerWidth,
        h: frameHeight / containerHeight
    };
    
    log('Guide layout updated', {
        container: { width: containerWidth, height: containerHeight },
        frame: { width: frameWidth, height: frameHeight, left: frameLeft, top: frameTop },
        roi: currentGuideROI
    });
}

/**
 * ガイドの表示/非表示を切り替え
 * 入力: 表示フラグ
 * 出力: なし
 * 副作用: ガイド要素のクラス更新
 * @param {boolean} isVisible - 表示する場合true
 */
function toggleGuideVisible(isVisible) {
    if (!guideOverlayEl) {
        return;
    }
    
    if (isVisible) {
        guideOverlayEl.classList.remove('camera-guide--hidden');
        log('Guide visible');
    } else {
        guideOverlayEl.classList.add('camera-guide--hidden');
        log('Guide hidden');
    }
}

/**
 * グリッド表示のON/OFF（任意機能）
 * 入力: グリッド表示フラグ
 * 出力: なし
 * 副作用: ガイド枠要素のクラス更新
 * @param {boolean} isOn - グリッド表示する場合true
 */
function toggleGuideGrid(isOn) {
    if (!guideFrameEl) {
        return;
    }
    
    if (isOn) {
        guideFrameEl.classList.add('camera-guide__frame--grid');
        log('Grid enabled');
    } else {
        guideFrameEl.classList.remove('camera-guide__frame--grid');
        log('Grid disabled');
    }
}

/**
 * ガイド枠ROI（正規化座標）を取得
 * 入力: なし
 * 出力: ROI（0〜1の正規化座標）
 * 副作用: なし
 * 注意: この座標は"表示上"の座標であり、object-fit: coverでトリミングされた
 *       実画像への変換はPhase 3で別途実装が必要
 * @returns {{ x: number, y: number, w: number, h: number }} ROI（0〜1）
 */
function getGuideROI() {
    return { ...currentGuideROI };
}

/**
 * リサイズ/回転追従の開始
 * 入力: プレビューコンテナ要素
 * 出力: なし
 * 副作用: イベントリスナー登録、ResizeObserver登録
 * @param {HTMLElement} containerEl - プレビューコンテナ要素
 */
function startGuideResizeTracking(containerEl) {
    log('startGuideResizeTracking() called');
    
    // レイアウト更新関数（デバウンスなし、ResizeObserverから直接呼ぶ）
    const runLayout = () => {
        const containerRect = containerEl.getBoundingClientRect();
        updateGuideLayout({ containerRect });
    };
    
    // デバウンス付きのレイアウト更新関数（windowイベント用）
    const debouncedLayout = () => {
        if (resizeTimer) {
            clearTimeout(resizeTimer);
        }
        resizeTimer = setTimeout(runLayout, GUIDE_CONFIG.resizeDebounceMs);
    };
    
    // ResizeObserverでコンテナのサイズ変更を監視（最も正確）
    if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => {
            runLayout();
        });
        resizeObserver.observe(containerEl);
        log('ResizeObserver started for container');
    }
    
    // resize / orientationchange も監視（フォールバック）
    window.addEventListener('resize', debouncedLayout);
    window.addEventListener('orientationchange', debouncedLayout);
    
    // 初回レイアウト計算
    requestAnimationFrame(() => {
        runLayout();
    });
}

/**
 * リサイズ/回転追従の停止とクリーンアップ
 * 入力: なし
 * 出力: なし
 * 副作用: イベントリスナー解除、タイマークリア
 */
function stopGuideResizeTracking() {
    log('stopGuideResizeTracking() called');
    
    if (resizeTimer) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
    }
    
    // ResizeObserverの解除
    if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
        log('ResizeObserver stopped');
    }
    
    // イベントリスナー解除は、モーダル全体が破棄されるため省略
    // （名前付き関数として参照を保持する実装も可能だが、簡易版として実装）
}

/**
 * ガイド機能のクリーンアップ
 * 入力: なし
 * 出力: なし
 * 副作用: DOM削除、イベント解除、内部変数リセット
 */
function disposeGuide() {
    log('disposeGuide() called');
    
    // イベント解除
    stopGuideResizeTracking();
    
    // DOM削除
    if (guideOverlayEl && guideOverlayEl.parentNode) {
        guideOverlayEl.parentNode.removeChild(guideOverlayEl);
    }
    
    // 内部変数リセット
    guideOverlayEl = null;
    guideFrameEl = null;
    currentGuideROI = { x: 0, y: 0, w: 0, h: 0 };
    
    log('Guide disposed');
}

/* =========================================
   モジュールのエクスポート（グローバル公開）
   ========================================= */
// 既存のapp.jsがmoduleでない場合はグローバルに公開
window.CameraModule = {
    startCamera,
    stopCamera,
    capturePhoto,
    processCapturedPhoto,
    retakePhoto,
    rotatePhoto,
    usePhoto,
    clearSessionStorage,
    // Phase 2 Step 2-3: ガイド機能
    createGuideOverlay,
    updateGuideLayout,
    toggleGuideVisible,
    toggleGuideGrid,
    getGuideROI,
    startGuideResizeTracking,
    stopGuideResizeTracking,
    disposeGuide,
    // 定数もエクスポート
    STATE,
    CAMERA_STORAGE_KEY
};
