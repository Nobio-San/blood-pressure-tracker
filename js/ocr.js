/**
 * OCRモジュール（Tesseract.js wrapper）
 * 
 * 目的: 撮影した血圧計画像から文字認識（OCR）を実行する最小構成の基盤を提供
 * 
 * 公開API（window.OCR）:
 *   - initOcr(options?)     : ワーカー初期化（シングルトン、多重初期化防止）
 *   - recognizeText(image)  : OCR実行（入力: URL/Base64/canvas/Blob等）
 *   - terminateOcr()        : ワーカー破棄（再初期化可能）
 * 
 * 設計方針:
 *   - ワーカーはシングルトンで再利用（重い処理・メモリ節約）
 *   - 初期化は最初の recognizeText() で自動実行（呼び出し側が順序を意識不要）
 *   - 例外は投げる（呼び出し側でキャッチ）
 */

(function() {
    'use strict';

    // ===== 設定（定数）=====
    const CONFIG = {
        // OCR言語（日本語+英語）
        lang: 'jpn+eng',
        
        // langPath / corePath はTesseract.js v5のデフォルトを使用
        // （CDN版はライブラリ内部で正しい取得先を解決するため、明示指定しない）
        // 将来ローカル配置する場合はここを変更
        
        // OCR設定（血圧計表示に最適化）
        tesseractConfig: {
            // 認識対象文字を制限（数字とスラッシュのみ）
            tessedit_char_whitelist: '0123456789/',
            
            // PSM（Page Segmentation Mode）: 6 = 一様なテキストブロックと仮定
            // 後続Stepで血圧計レイアウトに応じて最適化（候補: 7 = 単一テキスト行）
            psm: 6
        }
    };

    // ===== 内部状態 =====
    let worker = null;          // Tesseract.js ワーカーインスタンス
    let initPromise = null;     // 初期化中のPromise（多重初期化防止）

    /**
     * OCRワーカーを初期化
     * 
     * @param {Object} options - オプション設定
     * @param {Function} options.onProgress - 進捗コールバック（logger）
     * @returns {Promise<void>}
     * @throws {Error} 初期化失敗時
     */
    async function initOcr(options = {}) {
        // すでに初期化済みなら何もしない
        if (worker) {
            if (typeof options.onProgress === 'function') {
                options.onProgress({ status: 'ready', progress: 1 });
            }
            return;
        }

        // 初期化中なら、同じPromiseを返す（多重初期化防止）
        if (initPromise) {
            return initPromise;
        }

        try {
            initPromise = (async () => {
                console.log('[OCR] ワーカー初期化を開始...');
                
                // Tesseract.js v5.x の createWorker を使用
                // loggerを設定
                const logger = options.onProgress || ((info) => {
                    // デフォルトのlogger（コンソール出力）
                    console.log(`[OCR] ${info.status}: ${Math.round((info.progress || 0) * 100)}%`);
                });
                
                worker = await Tesseract.createWorker(CONFIG.lang, 1, {
                    logger: logger
                });

                // パラメータ設定
                console.log('[OCR] パラメータ設定中...', CONFIG.tesseractConfig);
                await worker.setParameters(CONFIG.tesseractConfig);

                console.log('[OCR] ワーカー初期化完了');
            })();

            await initPromise;
            initPromise = null; // 初期化完了後はnullにリセット

        } catch (error) {
            console.error('[OCR] 初期化失敗:', error);
            
            // 失敗時は状態をクリア（再試行可能にする）
            worker = null;
            initPromise = null;
            
            throw new Error(`OCRワーカーの初期化に失敗しました: ${error.message}`);
        }
    }

    /**
     * OCRを実行してテキストを認識
     * 
     * @param {string|HTMLCanvasElement|Blob|ImageData} image - 認識対象画像
     *        入力形式: URL(Base64含む) / HTMLCanvasElement / Blob / ImageData
     * @param {Object} options - オプション設定
     * @param {Function} options.onProgress - 進捗コールバック
     * @returns {Promise<Object>} 認識結果
     *          - rawText: 認識全文（加工しない）
     *          - confidence: 平均信頼度（0〜100）
     *          - data: Tesseractの生データ（デバッグ用）
     * @throws {Error} OCR実行失敗時
     */
    async function recognizeText(image, options = {}) {
        if (!image) {
            throw new Error('画像が指定されていません');
        }

        try {
            // ワーカー初期化（未初期化なら自動実行）
            await initOcr(options);

            console.log('[OCR] 文字認識を開始...');
            const startTime = performance.now();

            // OCR実行
            const result = await worker.recognize(image);

            const elapsedTime = Math.round(performance.now() - startTime);
            console.log(`[OCR] 認識完了（${elapsedTime}ms）`);

            // 結果を整形して返す
            return {
                rawText: result.data.text || '',
                confidence: result.data.confidence || 0,
                data: result.data // デバッグ用途で生データも含める
            };

        } catch (error) {
            console.error('[OCR] 認識失敗:', error);
            throw new Error(`OCR認識に失敗しました: ${error.message}`);
        }
    }

    /**
     * OCRワーカーを破棄（メモリ解放）
     * 
     * @returns {Promise<void>}
     */
    async function terminateOcr() {
        if (!worker) {
            console.log('[OCR] ワーカーは起動していません');
            return;
        }

        try {
            console.log('[OCR] ワーカーを終了...');
            await worker.terminate();
            worker = null;
            initPromise = null;
            console.log('[OCR] ワーカー終了完了');
        } catch (error) {
            console.error('[OCR] ワーカー終了失敗:', error);
            // 失敗してもstateはクリア（再初期化可能にする）
            worker = null;
            initPromise = null;
        }
    }

    // ===== 公開API =====
    window.OCR = {
        initOcr,
        recognizeText,
        terminateOcr
    };

    console.log('[OCR] モジュール読み込み完了');

})();
