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

    // ===== 血圧値抽出用定数 =====
    /**
     * 閾値・範囲・スコア係数を一か所に集約
     * TODO: 実機データに合わせて LOW_CONFIDENCE_THRESHOLD 等を最適化
     */
    const VITALS_CONSTANTS = {
        // バリデーション範囲
        SYSTOLIC_MIN: 50,
        SYSTOLIC_MAX: 250,
        DIASTOLIC_MIN: 30,
        DIASTOLIC_MAX: 150,
        PULSE_MIN: 40,
        PULSE_MAX: 200,
        // 警告閾値
        SMALL_BP_GAP_THRESHOLD: 5,
        LOW_CONFIDENCE_THRESHOLD: 70,
        MULTI_CANDIDATE_SCORE_DIFF: 10,
        MULTI_CANDIDATE_MAX_COUNT: 5,
        // スコアリング ボーナス／ペナルティ
        SCORE_BONUS_SEPARATOR: 20,
        SCORE_BONUS_LABEL: 15,
        SCORE_BONUS_REASONABLE_GAP: 10,
        SCORE_PENALTY_OUTLIER: 10,
        SCORE_BONUS_PULSE_LABEL: 25,
        SCORE_BONUS_PULSE_IN_RANGE: 10,
        // 妥当な血圧差の範囲
        REASONABLE_GAP_MIN: 20,
        REASONABLE_GAP_MAX: 80,
        // 外れ値境界（SYSTOLIC_MIN/MAX からこの幅以内を外れ値とみなす）
        OUTLIER_BOUNDARY: 10,
        // 総合confidence の加重（BP 優先）
        WEIGHT_BP: 0.7,
        WEIGHT_PULSE: 0.3,
        // words メタ情報がない場合のデフォルト信頼度
        DEFAULT_CONF: 80,
        // トークン近接ペア検出の最大ギャップ文字数
        TOKEN_PAIR_MAX_GAP: 5,
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
     * 前処理（ROI→グレースケール→二値化）を適用してからTesseractに渡す。失敗時は前処理スキップで継続。
     *
     * @param {string|HTMLCanvasElement|Blob|ImageData} image - 認識対象画像
     * @param {Object} options - オプション（onProgress, preprocessOptions 等）
     * @returns {Promise<Object>} 認識結果（rawText, confidence, data, preprocessMeta）
     */
    async function recognizeText(image, options = {}) {
        if (!image) {
            throw new Error('画像が指定されていません');
        }

        try {
            await initOcr(options);

            console.log('[OCR] 文字認識を開始...');
            const startTime = performance.now();

            let inputForOcr = image;
            let preprocessMeta = null;

            if (window.ImagePreprocess && typeof window.ImagePreprocess.preprocessImage === 'function') {
                try {
                    const preprocessOpts = options.preprocessOptions || {};
                    if (options.debugPreprocess) {
                        preprocessOpts.debug = preprocessOpts.debug || {};
                        preprocessOpts.debug.enabled = true;
                    }
                    const { canvas, meta } = await window.ImagePreprocess.preprocessImage(image, preprocessOpts);
                    inputForOcr = canvas;
                    preprocessMeta = meta;
                    if (meta && meta.timingsMs && meta.timingsMs.total != null) {
                        console.log(`[OCR] 前処理: ${meta.timingsMs.total}ms`);
                    }
                } catch (preprocessError) {
                    console.warn('[OCR] 前処理をスキップして続行:', preprocessError.message);
                    if (!preprocessMeta) preprocessMeta = { warnings: [preprocessError.message] };
                }
            }

            const result = await worker.recognize(inputForOcr);

            const elapsedTime = Math.round(performance.now() - startTime);
            console.log(`[OCR] 認識完了（${elapsedTime}ms）`);

            const out = {
                rawText: result.data.text || '',
                confidence: result.data.confidence || 0,
                data: result.data
            };
            if (preprocessMeta) out.preprocessMeta = preprocessMeta;
            return out;

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

    function getPreprocessImage() {
        return window.ImagePreprocess && typeof window.ImagePreprocess.preprocessImage === 'function'
            ? window.ImagePreprocess.preprocessImage
            : null;
    }

    // ===== 血圧値抽出ロジック =====

    /**
     * Tesseract words 配列から指定テキストに対応する信頼度を取得
     * 入力: 数字文字列, words メタ配列（省略可）, デフォルト信頼度
     * 出力: confidence (0-100)
     * 副作用: なし
     *
     * @param {string} numStr
     * @param {Array|null} words
     * @param {number} defaultConf
     * @returns {number}
     */
    function getWordConf(numStr, words, defaultConf) {
        if (!words || !Array.isArray(words)) return defaultConf;
        const matched = words.find(w => w && w.text && w.text.trim() === numStr);
        return (matched && typeof matched.confidence === 'number') ? matched.confidence : defaultConf;
    }

    /**
     * OCRテキストを正規化する
     * 入力: OCR生テキスト文字列
     * 出力: 正規化後テキスト（全角→半角、改行→スペース、区切り記号統一、誤認識補正）
     * 副作用: なし
     *
     * @param {string} rawText
     * @returns {string}
     */
    function normalizeOcrText(rawText) {
        if (!rawText || typeof rawText !== 'string') return '';
        let text = rawText;

        // 全角数字→半角数字
        text = text.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));

        // 全角・特殊区切り記号→半角スラッシュ（血圧値セパレータとして扱う）
        text = text.replace(/[／＼｜|]/g, '/');

        // 改行・タブ・全角スペース→半角スペース
        text = text.replace(/[\r\n\t　]+/g, ' ');

        // 誤認識補正（数字近傍のみ：過補正によるラベル文字の数字化を防ぐ）
        // O/〇→0（直前または直後が数字）
        text = text.replace(/(\d)[OoＯｏ〇]/g, (_, p1) => p1 + '0');
        text = text.replace(/[OoＯｏ〇](\d)/g, (_, p1) => '0' + p1);
        // I/l→1（直前または直後が数字）
        text = text.replace(/(\d)[IlＩｌ]/g, (_, p1) => p1 + '1');
        text = text.replace(/[IlＩｌ](\d)/g, (_, p1) => '1' + p1);
        // S→5（数字に挟まれた場合のみ：ラベル文字を保護するため厳格に適用）
        text = text.replace(/(\d)[Ss](\d)/g, (_, p1, p2) => p1 + '5' + p2);

        // 連続スペース→1つに圧縮
        text = text.replace(/\s{2,}/g, ' ').trim();

        return text;
    }

    /**
     * SYS/DIA ラベルベースの血圧ペアを抽出する内部ヘルパー
     * 入力: 正規化済みテキスト, words メタ配列（省略可）
     * 出力: 候補オブジェクト or null
     * 副作用: なし
     */
    function extractLabeledBp(text, words) {
        const C = VITALS_CONSTANTS;
        const m = /SYS\s*:?\s*(\d{2,3})\s+DIA\s*:?\s*(\d{2,3})/i.exec(text);
        if (!m) return null;
        const sys = parseInt(m[1], 10);
        const dia = parseInt(m[2], 10);
        if (sys >= C.SYSTOLIC_MIN && sys <= C.SYSTOLIC_MAX &&
            dia >= C.DIASTOLIC_MIN && dia <= C.DIASTOLIC_MAX &&
            sys > dia) {
            return {
                sys, dia,
                hasSeparator: false,
                hasLabel: true,
                confSys: getWordConf(m[1], words, C.DEFAULT_CONF),
                confDia: getWordConf(m[2], words, C.DEFAULT_CONF),
                evidence: 'label_pattern',
            };
        }
        return null;
    }

    /**
     * テキストから近接する数字トークンのペアを抽出する内部ヘルパー
     * 入力: 正規化済みテキスト, words メタ配列（省略可）
     * 出力: 候補オブジェクトの配列
     * 副作用: なし
     */
    function extractTokenPairs(text, words) {
        const C = VITALS_CONSTANTS;
        const candidates = [];
        const tokenPattern = /\d{2,3}/g;
        const tokens = [];
        let tm;
        while ((tm = tokenPattern.exec(text)) !== null) {
            tokens.push({ value: parseInt(tm[0], 10), str: tm[0], index: tm.index });
        }
        for (let i = 0; i < tokens.length - 1; i++) {
            const t1 = tokens[i];
            const t2 = tokens[i + 1];
            const gap = t2.index - (t1.index + t1.str.length);
            if (gap > C.TOKEN_PAIR_MAX_GAP) continue;
            const sys = t1.value;
            const dia = t2.value;
            if (sys >= C.SYSTOLIC_MIN && sys <= C.SYSTOLIC_MAX &&
                dia >= C.DIASTOLIC_MIN && dia <= C.DIASTOLIC_MAX &&
                sys > dia) {
                candidates.push({
                    sys, dia,
                    hasSeparator: false,
                    hasLabel: false,
                    confSys: getWordConf(t1.str, words, C.DEFAULT_CONF),
                    confDia: getWordConf(t2.str, words, C.DEFAULT_CONF),
                    evidence: 'token_pair',
                });
            }
        }
        return candidates;
    }

    /**
     * 正規化テキストから血圧候補を抽出する
     * 入力: 正規化テキスト, OCRメタ（result.data）
     * 出力: BP候補オブジェクトの配列 [{sys, dia, hasSeparator, hasLabel, confSys, confDia, evidence}]
     * 副作用: なし
     *
     * @param {string} text - 正規化済みテキスト
     * @param {Object|null} ocrMeta - result.data (words プロパティを含む場合がある)
     * @returns {Array}
     */
    function extractBpCandidates(text, ocrMeta) {
        const C = VITALS_CONSTANTS;
        const candidates = [];
        const words = (ocrMeta && Array.isArray(ocrMeta.words)) ? ocrMeta.words : null;

        // Pattern 1: XXX/YYY（セパレータあり）
        let separatorAttempted = false;
        const sepPattern = /(\d{2,3})\s*\/\s*(\d{2,3})/g;
        let m;
        while ((m = sepPattern.exec(text)) !== null) {
            separatorAttempted = true;
            const sys = parseInt(m[1], 10);
            const dia = parseInt(m[2], 10);
            if (sys >= C.SYSTOLIC_MIN && sys <= C.SYSTOLIC_MAX &&
                dia >= C.DIASTOLIC_MIN && dia <= C.DIASTOLIC_MAX &&
                sys > dia) {
                candidates.push({
                    sys, dia,
                    hasSeparator: true,
                    hasLabel: false,
                    confSys: getWordConf(m[1], words, C.DEFAULT_CONF),
                    confDia: getWordConf(m[2], words, C.DEFAULT_CONF),
                    evidence: 'sep_pattern',
                });
            }
        }

        // Pattern 2: SYS/DIA ラベルベース
        const labeledBp = extractLabeledBp(text, words);
        if (labeledBp && !candidates.some(c => c.sys === labeledBp.sys && c.dia === labeledBp.dia)) {
            candidates.push(labeledBp);
        }

        // Pattern 3: 近接トークンペア（セパレータ未検出かつラベル候補なしの場合のみ）
        // セパレータが存在した場合は意図的なペア指定とみなし、トークンペアは使わない
        if (!separatorAttempted && candidates.length === 0) {
            const tokenPairs = extractTokenPairs(text, words);
            tokenPairs.forEach(pair => {
                if (!candidates.some(c => c.sys === pair.sys && c.dia === pair.dia)) {
                    candidates.push(pair);
                }
            });
        }

        return candidates;
    }

    /**
     * 正規化テキストから脈拍候補を抽出する
     * 入力: 正規化テキスト, OCRメタ, 採用済み最高/最低血圧値（null 可）
     * 出力: 脈拍候補オブジェクトの配列 [{value, conf, hasLabel, evidence}]
     * 副作用: なし
     *
     * @param {string} text - 正規化済みテキスト
     * @param {Object|null} ocrMeta
     * @param {number|null} usedSys - 採用済み最高血圧（除外用）
     * @param {number|null} usedDia - 採用済み最低血圧（除外用）
     * @returns {Array}
     */
    function extractPulseCandidates(text, ocrMeta, usedSys, usedDia) {
        const C = VITALS_CONSTANTS;
        const candidates = [];
        const words = (ocrMeta && Array.isArray(ocrMeta.words)) ? ocrMeta.words : null;

        // ラベル優先（PUL/PULSE/HR/BPM/脈拍 の近傍）
        const labelBefore = /(?:PUL|PULSE|HR|BPM|脈拍)\s*:?\s*(\d{2,3})/gi;
        const labelAfter = /(\d{2,3})\s*BPM/gi;
        let lm;

        while ((lm = labelBefore.exec(text)) !== null) {
            const val = parseInt(lm[1], 10);
            if (!candidates.some(c => c.value === val)) {
                candidates.push({
                    value: val,
                    conf: getWordConf(lm[1], words, C.DEFAULT_CONF),
                    hasLabel: true,
                    evidence: 'label_before',
                });
            }
        }

        while ((lm = labelAfter.exec(text)) !== null) {
            const val = parseInt(lm[1], 10);
            if (!candidates.some(c => c.value === val)) {
                candidates.push({
                    value: val,
                    conf: getWordConf(lm[1], words, C.DEFAULT_CONF),
                    hasLabel: true,
                    evidence: 'label_after',
                });
            }
        }

        // フォールバック: 残りの 2〜3 桁数字（採用済み BP 値を除外）
        const tokenPattern = /\d{2,3}/g;
        let tm;
        while ((tm = tokenPattern.exec(text)) !== null) {
            const val = parseInt(tm[0], 10);
            if (val === usedSys || val === usedDia) continue;
            if (candidates.some(c => c.value === val)) continue;
            candidates.push({
                value: val,
                conf: getWordConf(tm[0], words, C.DEFAULT_CONF),
                hasLabel: false,
                evidence: 'fallback',
            });
        }

        return candidates;
    }

    /**
     * 血圧・脈拍値のバリデーションを実行する
     * 入力: {systolic, diastolic, pulse}（各値は null 可）
     * 出力: {systolic, diastolic, pulse, errors, warnings}（範囲外は null に変換）
     * 副作用: なし
     *
     * @param {{systolic: number|null, diastolic: number|null, pulse: number|null}} vitals
     * @returns {{systolic: number|null, diastolic: number|null, pulse: number|null, errors: string[], warnings: string[]}}
     */
    function validateVitals(vitals) {
        const C = VITALS_CONSTANTS;
        const errors = [];
        const warnings = [];
        let { systolic, diastolic, pulse } = vitals;

        if (systolic !== null && (systolic < C.SYSTOLIC_MIN || systolic > C.SYSTOLIC_MAX)) {
            errors.push('VALIDATION_FAILED');
            systolic = null;
        }
        if (diastolic !== null && (diastolic < C.DIASTOLIC_MIN || diastolic > C.DIASTOLIC_MAX)) {
            errors.push('VALIDATION_FAILED');
            diastolic = null;
        }
        if (pulse !== null && (pulse < C.PULSE_MIN || pulse > C.PULSE_MAX)) {
            pulse = null;
        }

        if (systolic !== null && diastolic !== null) {
            if (systolic <= diastolic) {
                errors.push('VALIDATION_FAILED');
                systolic = null;
                diastolic = null;
            } else if (systolic - diastolic < C.SMALL_BP_GAP_THRESHOLD) {
                warnings.push('SMALL_BP_GAP');
            }
        }

        return { systolic, diastolic, pulse, errors, warnings };
    }

    /**
     * BP候補の中から最高スコアのものを選ぶ
     * 入力: 候補配列
     * 出力: {best, warnings, allScored} or null
     * 副作用: なし
     *
     * @param {Array} candidates
     * @returns {{best: Object, warnings: string[], allScored: Array}|null}
     */
    function selectBestBpCandidate(candidates) {
        const C = VITALS_CONSTANTS;
        if (!candidates || candidates.length === 0) return null;

        const scored = candidates.map(c => {
            const confAvg = ((c.confSys || C.DEFAULT_CONF) + (c.confDia || C.DEFAULT_CONF)) / 2;
            let score = confAvg;
            if (c.hasSeparator) score += C.SCORE_BONUS_SEPARATOR;
            if (c.hasLabel) score += C.SCORE_BONUS_LABEL;
            const gap = c.sys - c.dia;
            if (gap >= C.REASONABLE_GAP_MIN && gap <= C.REASONABLE_GAP_MAX) {
                score += C.SCORE_BONUS_REASONABLE_GAP;
            }
            if (c.sys <= C.SYSTOLIC_MIN + C.OUTLIER_BOUNDARY ||
                c.sys >= C.SYSTOLIC_MAX - C.OUTLIER_BOUNDARY) {
                score -= C.SCORE_PENALTY_OUTLIER;
            }
            return { ...c, score };
        });

        scored.sort((a, b) => b.score - a.score);

        const warnings = [];
        if (scored.length >= C.MULTI_CANDIDATE_MAX_COUNT) {
            warnings.push('MULTIPLE_CANDIDATES');
        } else if (scored.length >= 2 &&
            scored[0].score - scored[1].score < C.MULTI_CANDIDATE_SCORE_DIFF) {
            warnings.push('MULTIPLE_CANDIDATES');
        }

        return { best: scored[0], warnings, allScored: scored };
    }

    /**
     * 脈拍候補の中から最高スコアのものを選ぶ
     * 入力: 候補配列
     * 出力: {best, warnings} or null
     * 副作用: なし
     *
     * @param {Array} candidates
     * @returns {{best: Object, warnings: string[]}|null}
     */
    function selectBestPulseCandidate(candidates) {
        const C = VITALS_CONSTANTS;
        if (!candidates || candidates.length === 0) return null;

        const valid = candidates.filter(c => c.value >= C.PULSE_MIN && c.value <= C.PULSE_MAX);
        if (valid.length === 0) return null;

        const scored = valid.map(c => {
            let score = (c.conf || C.DEFAULT_CONF);
            if (c.hasLabel) score += C.SCORE_BONUS_PULSE_LABEL;
            score += C.SCORE_BONUS_PULSE_IN_RANGE;
            return { ...c, score };
        });

        scored.sort((a, b) => b.score - a.score);

        const warnings = [];
        if (scored.length >= 2 &&
            scored[0].score - scored[1].score < C.MULTI_CANDIDATE_SCORE_DIFF) {
            warnings.push('MULTIPLE_CANDIDATES');
        }

        return { best: scored[0], warnings };
    }

    /**
     * 各フィールドの confidence から総合 confidence を算出する
     * 入力: fieldConfidence ({systolic, diastolic, pulse})
     * 出力: 0〜100 の整数
     * 副作用: なし
     *
     * @param {{systolic: number, diastolic: number, pulse: number}} fieldConfidence
     * @returns {number}
     */
    function computeOverallConfidence(fieldConfidence) {
        const C = VITALS_CONSTANTS;
        const bpConf = (fieldConfidence.systolic + fieldConfidence.diastolic) / 2;
        const pulseConf = fieldConfidence.pulse;
        return Math.round(bpConf * C.WEIGHT_BP + pulseConf * C.WEIGHT_PULSE);
    }

    /**
     * Tesseract.js OCR結果から血圧・脈拍値を抽出する（外部公開 I/F）
     * 入力: result（Tesseract.js 認識結果。result.data.text が必須）
     *       options（省略可: { debug: boolean }）
     * 出力: 抽出結果オブジェクト
     *   { systolic, diastolic, pulse, confidence, fieldConfidence,
     *     rawText, normalizedText, warnings, errors, debug? }
     * 副作用: options.debug=true のとき console ログ
     *
     * @param {Object} result - Tesseract.js の認識結果
     * @param {Object} [options]
     * @param {boolean} [options.debug] - デバッグ情報を返す場合は true
     * @returns {Object}
     */
    function extractVitalsFromOcr(result, options) {
        options = options || {};
        const C = VITALS_CONSTANTS;

        const defaultResult = {
            systolic: null,
            diastolic: null,
            pulse: null,
            confidence: 0,
            fieldConfidence: { systolic: 0, diastolic: 0, pulse: 0 },
            rawText: '',
            normalizedText: '',
            warnings: [],
            errors: [],
        };

        try {
            const rawText = (result && result.data && result.data.text)
                ? result.data.text : '';
            defaultResult.rawText = rawText;

            if (!rawText.trim()) {
                defaultResult.errors.push('BP_PAIR_NOT_FOUND', 'PULSE_NOT_FOUND');
                return defaultResult;
            }

            const normalizedText = normalizeOcrText(rawText);
            defaultResult.normalizedText = normalizedText;

            const ocrMeta = (result && result.data) ? result.data : null;

            if (options.debug) {
                console.log('[OCR extract] normalizedText:', normalizedText);
            }

            // BP候補抽出 → 選別
            const bpCandidates = extractBpCandidates(normalizedText, ocrMeta);
            if (options.debug) {
                console.log('[OCR extract] bpCandidates:', bpCandidates);
            }

            const bpResult = selectBestBpCandidate(bpCandidates);
            const allWarnings = [];
            const allErrors = [];
            let systolic = null, diastolic = null, confSys = 0, confDia = 0;

            if (bpResult && bpResult.best) {
                systolic = bpResult.best.sys;
                diastolic = bpResult.best.dia;
                confSys = bpResult.best.confSys || C.DEFAULT_CONF;
                confDia = bpResult.best.confDia || C.DEFAULT_CONF;
                allWarnings.push(...bpResult.warnings);
            } else {
                allErrors.push('BP_PAIR_NOT_FOUND');
            }

            // 脈拍候補抽出 → 選別（採用済み BP 値を除外）
            const pulseCandidates = extractPulseCandidates(
                normalizedText, ocrMeta, systolic, diastolic
            );
            if (options.debug) {
                console.log('[OCR extract] pulseCandidates:', pulseCandidates);
            }

            const pulseResult = selectBestPulseCandidate(pulseCandidates);
            let pulse = null, confPulse = 0;

            if (pulseResult && pulseResult.best) {
                pulse = pulseResult.best.value;
                confPulse = pulseResult.best.conf || C.DEFAULT_CONF;
                allWarnings.push(...pulseResult.warnings);
            } else {
                allErrors.push('PULSE_NOT_FOUND');
            }

            // バリデーション（範囲・大小関係）
            const validated = validateVitals({ systolic, diastolic, pulse });
            systolic = validated.systolic;
            diastolic = validated.diastolic;
            pulse = validated.pulse;
            allErrors.push(...validated.errors);
            allWarnings.push(...validated.warnings);

            // fieldConfidence（バリデーションで null になったフィールドは 0）
            const fieldConfidence = {
                systolic: systolic !== null ? confSys : 0,
                diastolic: diastolic !== null ? confDia : 0,
                pulse: pulse !== null ? confPulse : 0,
            };

            const confidence = computeOverallConfidence(fieldConfidence);

            if (confidence < C.LOW_CONFIDENCE_THRESHOLD) {
                allWarnings.push('LOW_CONFIDENCE');
            }

            const uniqueWarnings = [...new Set(allWarnings)];
            const uniqueErrors = [...new Set(allErrors)];

            const output = {
                systolic,
                diastolic,
                pulse,
                confidence,
                fieldConfidence,
                rawText,
                normalizedText,
                warnings: uniqueWarnings,
                errors: uniqueErrors,
            };

            if (options.debug) {
                output.debug = {
                    bpCandidates,
                    pulseCandidates,
                    bpResult,
                    pulseResult,
                };
            }

            return output;

        } catch (err) {
            console.error('[OCR] extractVitalsFromOcr 例外:', err);
            return {
                ...defaultResult,
                errors: ['BP_PAIR_NOT_FOUND', 'PULSE_NOT_FOUND'],
            };
        }
    }

    /**
     * 抽出ロジックの簡易自己テスト（fixtures 駆動）
     * 入力: なし
     * 出力: {passed, failed, total}（console に PASS/FAIL 詳細も出力）
     * 副作用: console 出力
     *
     * 呼び出し方: ブラウザ console で `OCR.runExtractionSelfTest()` を実行
     * 本番 UI からは呼び出さない
     *
     * @returns {{passed: number, failed: number, total: number}}
     */
    function runExtractionSelfTest() {
        const fixtures = [
            {
                desc: '標準パターン (XXX/YYY ZZZ)',
                input: '120/80 65',
                expected: { systolic: 120, diastolic: 80, pulse: 65 },
            },
            {
                desc: 'ラベル付きパターン (SYS DIA PUL)',
                input: 'SYS 120 DIA 80 PUL 65',
                expected: { systolic: 120, diastolic: 80, pulse: 65 },
            },
            {
                desc: '全角混在 (１２０／８０ ６５)',
                input: '１２０／８０ ６５',
                expected: { systolic: 120, diastolic: 80, pulse: 65 },
            },
            {
                desc: 'セパレータ欠落 (120 80 65)',
                input: '120 80 65',
                expected: { systolic: 120, diastolic: 80, pulse: 65 },
            },
            {
                desc: '改行分断 (120\\n80\\n65)',
                input: '120\n80\n65',
                expected: { systolic: 120, diastolic: 80, pulse: 65 },
            },
            {
                desc: '誤認識 O→0 (12O/8O 65)',
                input: '12O/8O 65',
                expected: { systolic: 120, diastolic: 80, pulse: 65 },
            },
            {
                desc: '最高/最低が反転 (80/120) → BP null',
                input: '80/120',
                expected: { systolic: null, diastolic: null },
            },
            {
                desc: '範囲外データ (999/10 65) → BP null, pulse 65',
                input: '999/10 65',
                expected: { systolic: null, diastolic: null, pulse: 65 },
            },
            {
                desc: '空テキスト → 全 null',
                input: '',
                expected: { systolic: null, diastolic: null, pulse: null },
            },
            {
                desc: 'BPMラベル付き脈拍 (130/85 72BPM)',
                input: '130/85 72BPM',
                expected: { systolic: 130, diastolic: 85, pulse: 72 },
            },
        ];

        console.log(`[OCR Self-Test] 開始... (${fixtures.length} ケース)`);
        let passed = 0, failed = 0;

        fixtures.forEach(fixture => {
            const result = extractVitalsFromOcr(
                { data: { text: fixture.input } },
                { debug: false }
            );

            let ok = true;
            const keys = Object.keys(fixture.expected);
            for (const key of keys) {
                if (result[key] !== fixture.expected[key]) {
                    ok = false;
                    break;
                }
            }

            if (ok) {
                console.log(`[PASS] ${fixture.desc}`);
                passed++;
            } else {
                console.warn(`[FAIL] ${fixture.desc}`);
                console.warn('  期待値:', fixture.expected);
                console.warn('  実際値:', {
                    systolic: result.systolic,
                    diastolic: result.diastolic,
                    pulse: result.pulse,
                });
                console.warn('  正規化後テキスト:', result.normalizedText);
                console.warn('  エラー:', result.errors);
                console.warn('  警告:', result.warnings);
                failed++;
            }
        });

        console.log(`[OCR Self-Test] 完了: ${passed}/${fixtures.length} PASS, ${failed} FAIL`);
        return { passed, failed, total: fixtures.length };
    }

    // ===== 公開API =====
    window.OCR = {
        initOcr,
        recognizeText,
        terminateOcr,
        extractVitalsFromOcr,
        runExtractionSelfTest,
        get preprocessImage() { return getPreprocessImage(); }
    };

    console.log('[OCR] モジュール読み込み完了');

})();
