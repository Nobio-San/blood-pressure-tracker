/**
 * OCRモジュール（Tesseract.js wrapper）― Phase 3 Step 3-5 多重試行対応版
 *
 * 公開API（window.OCR）:
 *   - initOcr(options?)     : ワーカー初期化（シングルトン、多重初期化防止）
 *   - recognizeText(image, options?)  : OCR実行（複数試行→最良選択）
 *   - terminateOcr()        : ワーカー破棄（再初期化可能）
 *   - extractVitalsFromOcr(result, options?) : 単一結果から血圧値抽出
 *   - runExtractionSelfTest() : 抽出ロジックの簡易セルフテスト
 *   - isDebugMode()         : デバッグモード判定
 */

(function() {
    'use strict';

    // ===== 設定（定数）=====
    const CONFIG = {
        lang: 'eng',
        tesseractConfig: {
            tessedit_char_whitelist: '0123456789/',
            psm: 6
        }
    };

    // ===== 血圧値抽出用定数 =====
    const VITALS_CONSTANTS = {
        SYSTOLIC_MIN: 50,
        SYSTOLIC_MAX: 250,
        DIASTOLIC_MIN: 30,
        DIASTOLIC_MAX: 150,
        PULSE_MIN: 40,
        PULSE_MAX: 200,
        SMALL_BP_GAP_THRESHOLD: 5,
        LOW_CONFIDENCE_THRESHOLD: 70,
        MULTI_CANDIDATE_SCORE_DIFF: 10,
        MULTI_CANDIDATE_MAX_COUNT: 5,
        SCORE_BONUS_SEPARATOR: 20,
        SCORE_BONUS_LABEL: 15,
        SCORE_BONUS_VERTICAL_ORDER: 18,
        SCORE_BONUS_REASONABLE_GAP: 10,
        SCORE_PENALTY_OUTLIER: 10,
        SCORE_PENALTY_HIGH_SYS: 15,
        DATE_LIKE_SYS_MIN: 200,
        DATE_LIKE_SYS_MAX: 231,
        SCORE_BONUS_PULSE_LABEL: 25,
        SCORE_BONUS_PULSE_IN_RANGE: 10,
        REASONABLE_GAP_MIN: 20,
        REASONABLE_GAP_MAX: 80,
        OUTLIER_BOUNDARY: 10,
        WEIGHT_BP: 0.7,
        WEIGHT_PULSE: 0.3,
        DEFAULT_CONF: 80,
        TOKEN_PAIR_MAX_GAP: 5,
    };

    // ===== 内部状態 =====
    let worker = null;
    let initPromise = null;

    // ===== デバッグモード判定 =====

    /**
     * デバッグモード判定
     * 入力: なし
     * 出力: boolean
     * 副作用: なし
     */
    function isDebugMode() {
        try {
            if (typeof URLSearchParams !== 'undefined') {
                const params = new URLSearchParams(window.location.search);
                if (params.get('debug') === '1') return true;
            }
        } catch (_) { /* ignore */ }
        try {
            if (localStorage.getItem('OCR_DEBUG') === '1') return true;
        } catch (_) { /* ignore */ }
        var OC = window.OCR_CONSTANTS;
        return !!(OC && OC.OCR_DEBUG_DEFAULT);
    }

    // ===== ワーカー管理 =====

    /**
     * OCRワーカーを初期化
     * @param {Object} options - オプション設定
     * @param {Function} options.onProgress - 進捗コールバック
     * @returns {Promise<void>}
     */
    async function initOcr(options = {}) {
        if (worker) {
            if (typeof options.onProgress === 'function') {
                options.onProgress({ status: 'ready', progress: 1 });
            }
            return;
        }

        if (initPromise) {
            return initPromise;
        }

        try {
            initPromise = (async () => {
                console.log('[OCR] ワーカー初期化を開始...');

                const logger = options.onProgress || ((info) => {
                    console.log(`[OCR] ${info.status}: ${Math.round((info.progress || 0) * 100)}%`);
                });

                worker = await Tesseract.createWorker(CONFIG.lang, 1, {
                    logger: logger
                });

                console.log('[OCR] パラメータ設定中...', CONFIG.tesseractConfig);
                await worker.setParameters(CONFIG.tesseractConfig);

                console.log('[OCR] ワーカー初期化完了');
            })();

            await initPromise;
            initPromise = null;

        } catch (error) {
            console.error('[OCR] 初期化失敗:', error);
            worker = null;
            initPromise = null;
            throw new Error(`OCRワーカーの初期化に失敗しました: ${error.message}`);
        }
    }

    /**
     * OCRワーカーを破棄
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
            worker = null;
            initPromise = null;
        }
    }

    function getPreprocessImage() {
        return window.ImagePreprocess && typeof window.ImagePreprocess.preprocessImage === 'function'
            ? window.ImagePreprocess.preprocessImage
            : null;
    }

    // ===== テキスト正規化 =====

    /**
     * OCRテキストを正規化する
     * 入力: OCR生テキスト文字列
     * 出力: 正規化後テキスト
     * 副作用: なし
     */
    function normalizeOcrText(rawText) {
        if (!rawText || typeof rawText !== 'string') return '';
        var text = rawText;

        // 全角数字→半角数字
        text = text.replace(/[０-９]/g, function(c) {
            return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
        });

        // 全角・特殊区切り記号→半角スラッシュ
        text = text.replace(/[／＼｜|]/g, '/');

        // 改行・タブ・全角スペース→半角スペース
        text = text.replace(/[\r\n\t　]+/g, ' ');

        // 数字間の区切り記号揺れを吸収（- : ： → /）
        text = text.replace(/(\d)\s*[-:：]\s*(\d)/g, '$1/$2');

        // 誤認識補正（数字近傍のみ）
        text = text.replace(/(\d)[OoＯｏ〇]/g, function(_, p1) { return p1 + '0'; });
        text = text.replace(/[OoＯｏ〇](\d)/g, function(_, p1) { return '0' + p1; });
        text = text.replace(/(\d)[IlＩｌ]/g, function(_, p1) { return p1 + '1'; });
        text = text.replace(/[IlＩｌ](\d)/g, function(_, p1) { return '1' + p1; });
        text = text.replace(/(\d)[Ss](\d)/g, function(_, p1, p2) { return p1 + '5' + p2; });

        // 連続スペース→1つに圧縮
        text = text.replace(/\s{2,}/g, ' ').trim();

        return text;
    }

    // ===== 血圧値抽出ロジック =====

    /**
     * Tesseract words 配列から指定テキストに対応する信頼度を取得
     * 入力: 数字文字列, words メタ配列（省略可）, デフォルト信頼度
     * 出力: confidence (0-100)
     * 副作用: なし
     */
    function getWordConf(numStr, words, defaultConf) {
        if (!words || !Array.isArray(words)) return defaultConf;
        var matched = words.find(function(w) { return w && w.text && w.text.trim() === numStr; });
        return (matched && typeof matched.confidence === 'number') ? matched.confidence : defaultConf;
    }

    /**
     * SYS/DIA ラベルベースの血圧ペアを抽出する内部ヘルパー
     * 入力: 正規化済みテキスト, words メタ配列
     * 出力: 候補オブジェクト or null
     * 副作用: なし
     */
    function extractLabeledBp(text, words) {
        var C = VITALS_CONSTANTS;
        var m = /SYS\s*:?\s*(\d{2,3})\s+DIA\s*:?\s*(\d{2,3})/i.exec(text);
        if (!m) return null;
        var sys = parseInt(m[1], 10);
        var dia = parseInt(m[2], 10);
        if (sys >= C.SYSTOLIC_MIN && sys <= C.SYSTOLIC_MAX &&
            dia >= C.DIASTOLIC_MIN && dia <= C.DIASTOLIC_MAX &&
            sys > dia) {
            return {
                sys: sys, dia: dia,
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
     * OCRでよくある桁の誤認識（3↔9, 5↔9）の補正候補を生成
     * 入力: 数値（2〜3桁）
     * 出力: 元の値＋補正候補の配列（重複なし）
     */
    function getDigitConfusionVariants(value) {
        var s = String(value);
        var results = [value];
        var pairs = [['3', '9'], ['5', '9'], ['6', '8']];
        var seen = { value: true };
        function trySwap(idx, fromChar, toChar) {
            if (s[idx] !== fromChar) return;
            var variant = parseInt(s.substring(0, idx) + toChar + s.substring(idx + 1), 10);
            if (!seen[variant]) {
                seen[variant] = true;
                results.push(variant);
            }
        }
        for (var i = 0; i < s.length; i++) {
            for (var p = 0; p < pairs.length; p++) {
                trySwap(i, pairs[p][0], pairs[p][1]);
                trySwap(i, pairs[p][1], pairs[p][0]);
            }
        }
        return results;
    }

    /**
     * 日付様の数値か（2/25→225, 1/15→115等）を判定
     */
    function isDateLikeNumber(value) {
        if (value < 100 || value > 999) return false;
        var C = VITALS_CONSTANTS;
        if (value >= C.DATE_LIKE_SYS_MIN && value <= C.DATE_LIKE_SYS_MAX) return true;
        return false;
    }

    /**
     * 1行内の断片化した数字トークンを結合して2〜3桁の値を復元する
     * 例: "4 23" → 423 (範囲外) , "1 14" → 114, "6 9" → 69
     * 入力: 1行のテキスト
     * 出力: 復元した数値（2〜3桁）または null
     */
    function reassembleLineDigits(line) {
        var cleaned = line.replace(/[^0-9\s]/g, '').trim();
        if (!cleaned) return null;
        var digits = cleaned.replace(/\s+/g, '');
        if (digits.length >= 2 && digits.length <= 3) {
            return parseInt(digits, 10);
        }
        var m3 = /^(\d{2,3})/.exec(cleaned);
        if (m3) return parseInt(m3[1], 10);
        return null;
    }

    /**
     * 各行の数字を縦方向順にSYS/DIAペア候補として抽出する
     * 日付様の数値（2/25→225等）を除外し、桁誤認識（3↔9, 5↔9）の補正候補も生成
     */
    function extractVerticalOrderCandidates(text, words) {
        var C = VITALS_CONSTANTS;
        var candidates = [];
        var lines = text.split(/\n+/);
        var lineNums = [];
        for (var i = 0; i < lines.length; i++) {
            var line = lines[i].trim();
            if (!line) continue;
            var val = null, str = null;
            var directMatch = /(\d{2,3})/.exec(line);
            if (directMatch) {
                val = parseInt(directMatch[1], 10);
                str = directMatch[1];
            } else {
                val = reassembleLineDigits(line);
                str = val !== null ? String(val) : null;
            }
            if (val === null || val < 10 || val > 999) continue;
            if (lineNums.length === 0 && isDateLikeNumber(val)) continue;
            lineNums.push({ value: val, str: str || String(val) });
        }
        for (var j = 0; j + 1 < lineNums.length; j++) {
            var sysVal = lineNums[j].value;
            var diaVal = lineNums[j + 1].value;
            if (isDateLikeNumber(sysVal)) continue;
            var sysVariants = getDigitConfusionVariants(sysVal);
            var diaVariants = getDigitConfusionVariants(diaVal);
            for (var si = 0; si < sysVariants.length; si++) {
                for (var di = 0; di < diaVariants.length; di++) {
                    var sys = sysVariants[si];
                    var dia = diaVariants[di];
                    if (sys >= C.SYSTOLIC_MIN && sys <= C.SYSTOLIC_MAX &&
                        dia >= C.DIASTOLIC_MIN && dia <= C.DIASTOLIC_MAX &&
                        sys > dia) {
                        var isCorrected = (sys !== sysVal || dia !== diaVal);
                        candidates.push({
                            sys: sys, dia: dia,
                            hasSeparator: false,
                            hasLabel: false,
                            isVerticalOrder: true,
                            isDigitCorrected: isCorrected,
                            confSys: getWordConf(lineNums[j].str, words, C.DEFAULT_CONF),
                            confDia: getWordConf(lineNums[j + 1].str, words, C.DEFAULT_CONF),
                            evidence: isCorrected ? 'vertical_order_corrected' : 'vertical_order',
                        });
                        break;
                    }
                }
            }
        }
        return candidates;
    }

    /**
     * テキストから近接する数字トークンのペアを抽出する内部ヘルパー
     * 入力: 正規化済みテキスト, words メタ配列
     * 出力: 候補オブジェクトの配列
     * 副作用: なし
     */
    function extractTokenPairs(text, words) {
        var C = VITALS_CONSTANTS;
        var candidates = [];
        var tokenPattern = /\d{2,3}/g;
        var tokens = [];
        var tm;
        while ((tm = tokenPattern.exec(text)) !== null) {
            tokens.push({ value: parseInt(tm[0], 10), str: tm[0], index: tm.index });
        }
        for (var i = 0; i < tokens.length - 1; i++) {
            var t1 = tokens[i];
            var t2 = tokens[i + 1];
            var gap = t2.index - (t1.index + t1.str.length);
            if (gap > C.TOKEN_PAIR_MAX_GAP) continue;
            var sysVariants = getDigitConfusionVariants(t1.value);
            var diaVariants = getDigitConfusionVariants(t2.value);
            for (var si = 0; si < sysVariants.length; si++) {
                for (var di = 0; di < diaVariants.length; di++) {
                    var sys = sysVariants[si];
                    var dia = diaVariants[di];
                    if (sys >= C.SYSTOLIC_MIN && sys <= C.SYSTOLIC_MAX &&
                        dia >= C.DIASTOLIC_MIN && dia <= C.DIASTOLIC_MAX &&
                        sys > dia) {
                        candidates.push({
                            sys: sys, dia: dia,
                            hasSeparator: false,
                            hasLabel: false,
                            confSys: getWordConf(t1.str, words, C.DEFAULT_CONF),
                            confDia: getWordConf(t2.str, words, C.DEFAULT_CONF),
                            evidence: (sys !== t1.value || dia !== t2.value) ? 'token_pair_corrected' : 'token_pair',
                        });
                        break;
                    }
                }
            }
        }
        return candidates;
    }

    /**
     * 正規化テキストから血圧候補を抽出する
     * 入力: 正規化テキスト, OCRメタ（result.data）
     * 出力: BP候補オブジェクトの配列
     * 副作用: なし
     */
    function extractBpCandidates(text, ocrMeta, rawText) {
        var C = VITALS_CONSTANTS;
        var candidates = [];
        var words = (ocrMeta && Array.isArray(ocrMeta.words)) ? ocrMeta.words : null;

        var separatorAttempted = false;
        var sepPattern = /(\d{2,3})\s*\/\s*(\d{2,3})/g;
        var m;
        while ((m = sepPattern.exec(text)) !== null) {
            separatorAttempted = true;
            var sys = parseInt(m[1], 10);
            var dia = parseInt(m[2], 10);
            if (isDateLikeNumber(sys)) continue;
            if (sys >= C.SYSTOLIC_MIN && sys <= C.SYSTOLIC_MAX &&
                dia >= C.DIASTOLIC_MIN && dia <= C.DIASTOLIC_MAX &&
                sys > dia) {
                candidates.push({
                    sys: sys, dia: dia,
                    hasSeparator: true,
                    hasLabel: false,
                    confSys: getWordConf(m[1], words, C.DEFAULT_CONF),
                    confDia: getWordConf(m[2], words, C.DEFAULT_CONF),
                    evidence: 'sep_pattern',
                });
            }
        }

        var labeledBp = extractLabeledBp(text, words);
        if (labeledBp && !candidates.some(function(c) { return c.sys === labeledBp.sys && c.dia === labeledBp.dia; })) {
            candidates.push(labeledBp);
        }

        var verticalSource = (rawText && typeof rawText === 'string' && rawText.indexOf('\n') >= 0) ? rawText : text;
        var verticalCandidates = extractVerticalOrderCandidates(verticalSource, words);
        verticalCandidates.forEach(function(vc) {
            if (!candidates.some(function(c) { return c.sys === vc.sys && c.dia === vc.dia; })) {
                candidates.push(vc);
            }
        });

        if (candidates.length === 0) {
            var tokenPairs = extractTokenPairs(text, words);
            tokenPairs.forEach(function(pair) {
                if (!candidates.some(function(c) { return c.sys === pair.sys && c.dia === pair.dia; })) {
                    candidates.push(pair);
                }
            });
        }

        return candidates;
    }

    /**
     * 正規化テキストから脈拍候補を抽出する
     * 入力: 正規化テキスト, OCRメタ, 採用済み最高/最低血圧値
     * 出力: 脈拍候補オブジェクトの配列
     * 副作用: なし
     */
    function extractPulseCandidates(text, ocrMeta, usedSys, usedDia) {
        var C = VITALS_CONSTANTS;
        var candidates = [];
        var words = (ocrMeta && Array.isArray(ocrMeta.words)) ? ocrMeta.words : null;

        var labelBefore = /(?:PUL|PULSE|HR|BPM|脈拍)\s*:?\s*(\d{2,3})/gi;
        var labelAfter = /(\d{2,3})\s*BPM/gi;
        var lm;

        while ((lm = labelBefore.exec(text)) !== null) {
            var val = parseInt(lm[1], 10);
            if (!candidates.some(function(c) { return c.value === val; })) {
                candidates.push({
                    value: val,
                    conf: getWordConf(lm[1], words, C.DEFAULT_CONF),
                    hasLabel: true,
                    evidence: 'label_before',
                });
            }
        }

        while ((lm = labelAfter.exec(text)) !== null) {
            var val2 = parseInt(lm[1], 10);
            if (!candidates.some(function(c) { return c.value === val2; })) {
                candidates.push({
                    value: val2,
                    conf: getWordConf(lm[1], words, C.DEFAULT_CONF),
                    hasLabel: true,
                    evidence: 'label_after',
                });
            }
        }

        var tokenPattern = /\d{2,3}/g;
        var tm;
        while ((tm = tokenPattern.exec(text)) !== null) {
            var val3 = parseInt(tm[0], 10);
            if (val3 === usedSys || val3 === usedDia) continue;
            if (candidates.some(function(c) { return c.value === val3; })) continue;
            candidates.push({
                value: val3,
                conf: getWordConf(tm[0], words, C.DEFAULT_CONF),
                hasLabel: false,
                evidence: 'fallback',
            });
        }

        return candidates;
    }

    /**
     * 血圧・脈拍値のバリデーションを実行する
     * 入力: {systolic, diastolic, pulse}
     * 出力: {systolic, diastolic, pulse, errors, warnings}
     * 副作用: なし
     */
    function validateVitals(vitals) {
        var C = VITALS_CONSTANTS;
        var errors = [];
        var warnings = [];
        var systolic = vitals.systolic;
        var diastolic = vitals.diastolic;
        var pulse = vitals.pulse;

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

        return { systolic: systolic, diastolic: diastolic, pulse: pulse, errors: errors, warnings: warnings };
    }

    /**
     * BP候補の中から最高スコアのものを選ぶ
     * 入力: 候補配列
     * 出力: {best, warnings, allScored} or null
     * 副作用: なし
     */
    function selectBestBpCandidate(candidates) {
        var C = VITALS_CONSTANTS;
        if (!candidates || candidates.length === 0) return null;

        var scored = candidates.map(function(c) {
            var confAvg = ((c.confSys || C.DEFAULT_CONF) + (c.confDia || C.DEFAULT_CONF)) / 2;
            var score = confAvg;
            if (c.hasSeparator) score += C.SCORE_BONUS_SEPARATOR;
            if (c.hasLabel) score += C.SCORE_BONUS_LABEL;
            if (c.isVerticalOrder) score += C.SCORE_BONUS_VERTICAL_ORDER;
            var gap = c.sys - c.dia;
            if (gap >= C.REASONABLE_GAP_MIN && gap <= C.REASONABLE_GAP_MAX) {
                score += C.SCORE_BONUS_REASONABLE_GAP;
            }
            if (c.sys <= C.SYSTOLIC_MIN + C.OUTLIER_BOUNDARY ||
                c.sys >= C.SYSTOLIC_MAX - C.OUTLIER_BOUNDARY) {
                score -= C.SCORE_PENALTY_OUTLIER;
            }
            if (c.sys >= 200) {
                score -= (C.SCORE_PENALTY_HIGH_SYS || 15);
            }
            return Object.assign({}, c, { score: score });
        });

        scored.sort(function(a, b) { return b.score - a.score; });

        var warnings = [];
        if (scored.length >= C.MULTI_CANDIDATE_MAX_COUNT) {
            warnings.push('MULTIPLE_CANDIDATES');
        } else if (scored.length >= 2 &&
            scored[0].score - scored[1].score < C.MULTI_CANDIDATE_SCORE_DIFF) {
            warnings.push('MULTIPLE_CANDIDATES');
        }

        return { best: scored[0], warnings: warnings, allScored: scored };
    }

    /**
     * 脈拍候補の中から最高スコアのものを選ぶ
     * 入力: 候補配列
     * 出力: {best, warnings} or null
     * 副作用: なし
     */
    function selectBestPulseCandidate(candidates) {
        var C = VITALS_CONSTANTS;
        if (!candidates || candidates.length === 0) return null;

        var valid = candidates.filter(function(c) { return c.value >= C.PULSE_MIN && c.value <= C.PULSE_MAX; });
        if (valid.length === 0) return null;

        var scored = valid.map(function(c) {
            var score = (c.conf || C.DEFAULT_CONF);
            if (c.hasLabel) score += C.SCORE_BONUS_PULSE_LABEL;
            score += C.SCORE_BONUS_PULSE_IN_RANGE;
            return Object.assign({}, c, { score: score });
        });

        scored.sort(function(a, b) { return b.score - a.score; });

        var warnings = [];
        if (scored.length >= 2 &&
            scored[0].score - scored[1].score < C.MULTI_CANDIDATE_SCORE_DIFF) {
            warnings.push('MULTIPLE_CANDIDATES');
        }

        return { best: scored[0], warnings: warnings };
    }

    /**
     * 各フィールドの confidence から総合 confidence を算出する
     * 入力: fieldConfidence
     * 出力: 0〜100 の整数
     * 副作用: なし
     */
    function computeOverallConfidence(fieldConfidence) {
        var C = VITALS_CONSTANTS;
        var bpConf = (fieldConfidence.systolic + fieldConfidence.diastolic) / 2;
        var pulseConf = fieldConfidence.pulse;
        return Math.round(bpConf * C.WEIGHT_BP + pulseConf * C.WEIGHT_PULSE);
    }

    /**
     * Tesseract.js OCR結果から血圧・脈拍値を抽出する
     * 入力: result（Tesseract.js 認識結果）, options
     * 出力: 抽出結果オブジェクト（needsReview, confidenceLevel を含む）
     * 副作用: options.debug=true のとき console ログ
     */
    function extractVitalsFromOcr(result, options) {
        options = options || {};
        var C = VITALS_CONSTANTS;
        var OC = window.OCR_CONSTANTS || {};

        var defaultResult = {
            systolic: null,
            diastolic: null,
            pulse: null,
            confidence: 0,
            fieldConfidence: { systolic: 0, diastolic: 0, pulse: 0 },
            rawText: '',
            normalizedText: '',
            warnings: [],
            errors: [],
            needsReview: true,
            confidenceLevel: 'low',
        };

        try {
            var rawText = (result && result.data && result.data.text)
                ? result.data.text : '';
            defaultResult.rawText = rawText;

            if (!rawText.trim()) {
                defaultResult.errors.push('BP_PAIR_NOT_FOUND', 'PULSE_NOT_FOUND');
                return defaultResult;
            }

            var normalizedText = normalizeOcrText(rawText);
            defaultResult.normalizedText = normalizedText;

            var ocrMeta = (result && result.data) ? result.data : null;

            if (options.debug) {
                console.log('[OCR extract] normalizedText:', normalizedText);
            }

            var bpCandidates = extractBpCandidates(normalizedText, ocrMeta, rawText);
            if (options.debug) {
                console.log('[OCR extract] bpCandidates:', bpCandidates);
            }

            var bpResult = selectBestBpCandidate(bpCandidates);
            var allWarnings = [];
            var allErrors = [];
            var systolic = null, diastolic = null, confSys = 0, confDia = 0;

            if (bpResult && bpResult.best) {
                systolic = bpResult.best.sys;
                diastolic = bpResult.best.dia;
                confSys = bpResult.best.confSys || C.DEFAULT_CONF;
                confDia = bpResult.best.confDia || C.DEFAULT_CONF;
                allWarnings.push.apply(allWarnings, bpResult.warnings);
            } else {
                allErrors.push('BP_PAIR_NOT_FOUND');
            }

            var pulseCandidates = extractPulseCandidates(
                normalizedText, ocrMeta, systolic, diastolic
            );
            if (options.debug) {
                console.log('[OCR extract] pulseCandidates:', pulseCandidates);
            }

            var pulseResult = selectBestPulseCandidate(pulseCandidates);
            var pulse = null, confPulse = 0;

            if (pulseResult && pulseResult.best) {
                pulse = pulseResult.best.value;
                confPulse = pulseResult.best.conf || C.DEFAULT_CONF;
                allWarnings.push.apply(allWarnings, pulseResult.warnings);
            } else {
                allErrors.push('PULSE_NOT_FOUND');
            }

            var validated = validateVitals({ systolic: systolic, diastolic: diastolic, pulse: pulse });
            systolic = validated.systolic;
            diastolic = validated.diastolic;
            pulse = validated.pulse;
            allErrors.push.apply(allErrors, validated.errors);
            allWarnings.push.apply(allWarnings, validated.warnings);

            var fieldConfidence = {
                systolic: systolic !== null ? confSys : 0,
                diastolic: diastolic !== null ? confDia : 0,
                pulse: pulse !== null ? confPulse : 0,
            };

            var confidence = computeOverallConfidence(fieldConfidence);

            if (confidence < C.LOW_CONFIDENCE_THRESHOLD) {
                allWarnings.push('LOW_CONFIDENCE');
            }

            var uniqueWarnings = allWarnings.filter(function(v, i, a) { return a.indexOf(v) === i; });
            var uniqueErrors = allErrors.filter(function(v, i, a) { return a.indexOf(v) === i; });

            // Strict/Relaxed 妥当性判定
            var highThreshold = OC.CONFIDENCE_HIGH || 80;
            var medThreshold = OC.CONFIDENCE_MEDIUM || 60;
            var confidenceLevel = 'low';
            var needsReview = true;

            if (systolic !== null && diastolic !== null && systolic > diastolic &&
                uniqueErrors.length === 0 && confidence >= highThreshold) {
                confidenceLevel = 'high';
                needsReview = false;
            } else if (systolic !== null && diastolic !== null && confidence >= medThreshold) {
                confidenceLevel = 'medium';
                needsReview = true;
            }

            var output = {
                systolic: systolic,
                diastolic: diastolic,
                pulse: pulse,
                confidence: confidence,
                fieldConfidence: fieldConfidence,
                rawText: rawText,
                normalizedText: normalizedText,
                warnings: uniqueWarnings,
                errors: uniqueErrors,
                needsReview: needsReview,
                confidenceLevel: confidenceLevel,
            };

            if (options.debug) {
                output.debug = {
                    bpCandidates: bpCandidates,
                    pulseCandidates: pulseCandidates,
                    bpResult: bpResult,
                    pulseResult: pulseResult,
                };
            }

            return output;

        } catch (err) {
            console.error('[OCR] extractVitalsFromOcr 例外:', err);
            return Object.assign({}, defaultResult, {
                errors: ['BP_PAIR_NOT_FOUND', 'PULSE_NOT_FOUND'],
            });
        }
    }

    // ===== 多重試行アーキテクチャ =====

    /**
     * 前処理パターン定義を名前で取得
     * 入力: パターン名 (A/B/C)
     * 出力: パターン定義オブジェクト
     * 副作用: なし
     */
    function getPreprocessPattern(name) {
        var OC = window.OCR_CONSTANTS || {};
        var patterns = OC.PREPROCESS_PATTERNS || [];
        var found = null;
        for (var i = 0; i < patterns.length; i++) {
            if (patterns[i].name === name) {
                found = patterns[i];
                break;
            }
        }
        if (found) return found;
        return {
            name: 'A',
            label: 'デフォルト',
            options: { thresholdMode: 'otsu', contrast: { enabled: false }, median: { enabled: false }, morphology: { enabled: false } }
        };
    }

    /**
     * 単一試行のattempt-levelスコアを算出
     * 入力: vitals（extractVitalsFromOcrの出力）, ocrConfidence（Tesseract confidence）
     * 出力: { ocrConfidence, extractScore, total, hasValidBp, hasPulse }
     * 副作用: なし
     */
    function scoreAttempt(vitals, ocrConfidence) {
        var OC = window.OCR_CONSTANTS || {};
        var extractScore = 0;

        if (vitals.systolic !== null && vitals.diastolic !== null) {
            extractScore += 40;
            if (vitals.systolic > vitals.diastolic) {
                extractScore += 20;
            }
        }
        if (vitals.pulse !== null) {
            extractScore += 10;
        }
        if (vitals.errors.length === 0) {
            extractScore += 10;
        }
        if (vitals.warnings.length === 0) {
            extractScore += 5;
        }

        // 典型レンジボーナス
        if (vitals.systolic !== null && vitals.systolic >= 90 && vitals.systolic <= 180) {
            extractScore += 5;
        }
        if (vitals.diastolic !== null && vitals.diastolic >= 50 && vitals.diastolic <= 110) {
            extractScore += 5;
        }
        if (vitals.pulse !== null && vitals.pulse >= 50 && vitals.pulse <= 100) {
            extractScore += 5;
        }

        extractScore = Math.min(extractScore, 100);

        var confWeight = OC.OCR_CONF_WEIGHT || 0.4;
        var extractWeight = OC.EXTRACT_WEIGHT || 0.6;
        var total = Math.round(confWeight * (ocrConfidence || 0) + extractWeight * extractScore);

        return {
            ocrConfidence: Math.round(ocrConfidence || 0),
            extractScore: extractScore,
            total: total,
            hasValidBp: vitals.systolic !== null && vitals.diastolic !== null,
            hasPulse: vitals.pulse !== null,
        };
    }

    /**
     * 単一の前処理パターン×PSM×解像度でOCRを実行する
     * 入力: sourceCanvas, config, baseOptions, debug
     * 出力: attemptオブジェクト
     * 副作用: Tesseract workerパラメータ変更
     */
    async function runSingleAttempt(sourceCanvas, config, baseOptions, debug) {
        var start = performance.now();

        var pattern = getPreprocessPattern(config.preprocess);
        var preprocessOpts = Object.assign({}, pattern.options, {
            resizeLongEdgeMax: config.resolution
        });

        if (baseOptions.roi) {
            preprocessOpts.roi = baseOptions.roi;
        }
        if (baseOptions.roiFromGuide) {
            preprocessOpts.roiFromGuide = baseOptions.roiFromGuide;
        }
        if (baseOptions.roiMarginRatio !== undefined) {
            preprocessOpts.roiMarginRatio = baseOptions.roiMarginRatio;
        }

        if (debug) {
            preprocessOpts.debug = { enabled: true, maxKeep: 3 };
        }

        var inputForOcr = sourceCanvas;
        var preprocessMeta = null;

        if (window.ImagePreprocess && typeof window.ImagePreprocess.preprocessImage === 'function') {
            try {
                var ppResult = await window.ImagePreprocess.preprocessImage(sourceCanvas, preprocessOpts);
                inputForOcr = ppResult.canvas;
                preprocessMeta = ppResult.meta;
            } catch (ppErr) {
                console.warn('[OCR] 前処理スキップ:', ppErr.message);
                preprocessMeta = { warnings: [ppErr.message] };
            }
        }

        // Tesseractパラメータをこの試行用に設定
        var whitelist = config.whitelist || '0123456789 ';
        await worker.setParameters({
            tessedit_pageseg_mode: String(config.psm),
            tessedit_char_whitelist: whitelist,
        });

        var result = await worker.recognize(inputForOcr);

        // 抽出
        var vitals = extractVitalsFromOcr(result, { debug: debug });

        // スコアリング
        var score = scoreAttempt(vitals, result.data.confidence);

        var attemptId = config.preprocess + '_PSM' + config.psm + '_' + config.resolution;
        var elapsed = Math.round(performance.now() - start);

        var attempt = {
            id: attemptId,
            preprocessName: config.preprocess,
            preprocessLabel: pattern.label,
            resolutionLevel: config.resolution,
            tesseract: { psm: config.psm, whitelist: whitelist },
            rawText: result.data.text || '',
            confidence: result.data.confidence || 0,
            vitals: vitals,
            scoreBreakdown: score,
            totalScore: score.total,
            elapsedMs: elapsed,
            data: result.data,
            preprocessMeta: preprocessMeta,
        };

        if (debug) {
            attempt.normalizedText = vitals.normalizedText;
            attempt.debugCanvas = inputForOcr;
        }

        return attempt;
    }

    /**
     * OCR実行（多重試行版）
     * 入力: image（URL/Base64/Canvas/Blob等）, options
     * 出力: 最良試行の結果 + 全試行データ（デバッグ時）
     * 副作用: Worker初期化、パラメータ変更
     */
    async function recognizeText(image, options) {
        options = options || {};
        if (!image) {
            throw new Error('画像が指定されていません');
        }

        var debug = isDebugMode() || !!options.debug;
        var OC = window.OCR_CONSTANTS || {};

        await initOcr(options);

        var totalStart = performance.now();
        var attempts = [];
        var bestAttempt = null;
        var errorCode = null;

        // ソース画像をcanvasへ変換（1回だけ）
        var sourceCanvas;
        if (window.ImagePreprocess && typeof window.ImagePreprocess.sourceToCanvas === 'function') {
            sourceCanvas = await window.ImagePreprocess.sourceToCanvas(image);
        } else {
            sourceCanvas = image;
        }

        var use7SegFirst = (OC.USE_7SEG_FIRST !== false) && window.SevenSegment &&
            typeof window.SevenSegment.recognizeBloodPressureDisplayFlexible === 'function';

        if (use7SegFirst) {
            try {
                var segResult = await window.SevenSegment.recognizeBloodPressureDisplayFlexible(sourceCanvas, {});
                var segSys = segResult.systolic;
                var segDia = segResult.diastolic;
                var segPul = segResult.pulse;
                var segDateLike = segSys >= 200 && segSys <= 231;
                var segValid = segSys !== null && segDia !== null && segSys > segDia &&
                    segSys >= 50 && segSys <= 250 && segDia >= 30 && segDia <= 150 && !segDateLike;
                if (segValid) {
                    var segVitals = {
                        systolic: segSys,
                        diastolic: segDia,
                        pulse: segPul,
                        confidence: 92,
                        fieldConfidence: { systolic: 92, diastolic: 92, pulse: segPul !== null ? 92 : 0 },
                        rawText: segSys + '/' + segDia + ' ' + (segPul || ''),
                        normalizedText: segSys + '/' + segDia + ' ' + (segPul || ''),
                        warnings: [],
                        errors: [],
                        needsReview: false,
                        confidenceLevel: 'high'
                    };
                    var segElapsed = Math.round(performance.now() - totalStart);
                    console.log('[OCR] 7セグ方式で認識成功 (' + segElapsed + 'ms):', segSys + '/' + segDia + ' ' + (segPul || '-'));
                    return {
                        rawText: segVitals.rawText,
                        confidence: 92,
                        data: {},
                        preprocessMeta: { method: '7seg' },
                        vitals: segVitals,
                        selectedAttemptId: '7seg',
                        selectedReason: '7-segment display recognition',
                        totalElapsedMs: segElapsed,
                        errorCode: null,
                        attempts: debug ? [{ id: '7seg', vitals: segVitals, totalScore: 95 }] : undefined
                    };
                }
            } catch (segErr) {
                console.warn('[OCR] 7セグ方式スキップ:', segErr.message);
            }
        }

        var explorationOrder = OC.EXPLORATION_ORDER || [
            { resolution: 960, preprocess: 'A', psm: 6 }
        ];
        var attemptsMax = OC.ATTEMPTS_MAX || 24;
        var timeoutMs = OC.OCR_TOTAL_TIMEOUT_MS || 10000;
        var earlyAccept = OC.SCORE_EARLY_ACCEPT || 85;
        var timedOut = false;

        console.log('[OCR] 多重試行開始 (最大' + attemptsMax + '件, timeout=' + timeoutMs + 'ms)');

        for (var i = 0; i < explorationOrder.length; i++) {
            if (attempts.length >= attemptsMax) {
                console.log('[OCR] 最大試行数に到達');
                break;
            }

            var elapsed = performance.now() - totalStart;
            if (elapsed > timeoutMs) {
                timedOut = true;
                console.log('[OCR] タイムアウト (' + Math.round(elapsed) + 'ms)');
                break;
            }

            var config = explorationOrder[i];

            try {
                var attempt = await runSingleAttempt(sourceCanvas, config, options, debug);
                attempts.push(attempt);

                if (debug) {
                    console.log('[OCR] attempt ' + attempt.id + ' score=' + attempt.totalScore +
                        ' BP=' + (attempt.vitals.systolic || '-') + '/' + (attempt.vitals.diastolic || '-') +
                        ' PUL=' + (attempt.vitals.pulse || '-') +
                        ' (' + attempt.elapsedMs + 'ms)');
                }

                if (!bestAttempt || attempt.totalScore > bestAttempt.totalScore) {
                    bestAttempt = attempt;
                }

                if (attempt.totalScore >= earlyAccept) {
                    console.log('[OCR] 早期確定 (score=' + attempt.totalScore + ')');
                    break;
                }

            } catch (err) {
                console.warn('[OCR] attempt失敗 (' + config.preprocess + '_PSM' + config.psm + '):', err.message);
                attempts.push({
                    id: config.preprocess + '_PSM' + config.psm + '_' + config.resolution,
                    preprocessName: config.preprocess,
                    resolutionLevel: config.resolution,
                    tesseract: { psm: config.psm },
                    error: err.message,
                    totalScore: 0,
                    vitals: null,
                    elapsedMs: 0,
                });
            }
        }

        var totalElapsed = Math.round(performance.now() - totalStart);
        console.log('[OCR] 多重試行完了: ' + attempts.length + '件, ' + totalElapsed + 'ms' +
            (bestAttempt ? ', best=' + bestAttempt.id + '(score=' + bestAttempt.totalScore + ')' : ''));

        // タイムアウト時のエラーコード
        if (timedOut && (!bestAttempt || !bestAttempt.vitals || bestAttempt.vitals.systolic === null)) {
            errorCode = 'TIMEOUT';
        } else if (!bestAttempt || !bestAttempt.vitals) {
            errorCode = 'NO_VALID_RESULT';
        }

        // 結果オブジェクト構築
        var out;
        if (bestAttempt && bestAttempt.vitals) {
            out = {
                rawText: bestAttempt.rawText || '',
                confidence: bestAttempt.confidence || 0,
                data: bestAttempt.data || {},
                preprocessMeta: bestAttempt.preprocessMeta,
                vitals: bestAttempt.vitals,
                selectedAttemptId: bestAttempt.id,
                selectedReason: 'totalScore=' + bestAttempt.totalScore +
                    ' (ocr=' + bestAttempt.scoreBreakdown.ocrConfidence +
                    ', extract=' + bestAttempt.scoreBreakdown.extractScore + ')',
                totalElapsedMs: totalElapsed,
                errorCode: errorCode,
            };
        } else {
            out = {
                rawText: '',
                confidence: 0,
                data: {},
                preprocessMeta: null,
                vitals: {
                    systolic: null, diastolic: null, pulse: null,
                    confidence: 0, fieldConfidence: { systolic: 0, diastolic: 0, pulse: 0 },
                    rawText: '', normalizedText: '',
                    warnings: [], errors: ['NO_VALID_RESULT'],
                    needsReview: true, confidenceLevel: 'low',
                },
                selectedAttemptId: null,
                selectedReason: 'no valid result',
                totalElapsedMs: totalElapsed,
                errorCode: errorCode || 'NO_VALID_RESULT',
            };
        }

        if (debug) {
            out.attempts = attempts;
        }

        return out;
    }

    // ===== セルフテスト =====

    /**
     * 抽出ロジックの簡易自己テスト（fixtures 駆動）
     * 入力: なし
     * 出力: {passed, failed, total}
     * 副作用: console 出力
     */
    function runExtractionSelfTest() {
        var fixtures = [
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
            {
                desc: '区切り記号 : を / に正規化 (120:80 65)',
                input: '120:80 65',
                expected: { systolic: 120, diastolic: 80, pulse: 65 },
            },
            {
                desc: '縦並び改行 (114\\n69\\n55)',
                input: '114\n69\n55',
                expected: { systolic: 114, diastolic: 69, pulse: 55 },
            },
            {
                desc: '断片化した行を含む縦並び (1 14\\n69\\n55)',
                input: '1 14\n69\n55',
                expected: { systolic: 114, diastolic: 69, pulse: 55 },
            },
        ];

        console.log('[OCR Self-Test] 開始... (' + fixtures.length + ' ケース)');
        var passed = 0, failed = 0;

        fixtures.forEach(function(fixture) {
            var result = extractVitalsFromOcr(
                { data: { text: fixture.input } },
                { debug: false }
            );

            var ok = true;
            var keys = Object.keys(fixture.expected);
            for (var ki = 0; ki < keys.length; ki++) {
                if (result[keys[ki]] !== fixture.expected[keys[ki]]) {
                    ok = false;
                    break;
                }
            }

            if (ok) {
                console.log('[PASS] ' + fixture.desc);
                passed++;
            } else {
                console.warn('[FAIL] ' + fixture.desc);
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

        console.log('[OCR Self-Test] 完了: ' + passed + '/' + fixtures.length + ' PASS, ' + failed + ' FAIL');
        return { passed: passed, failed: failed, total: fixtures.length };
    }

    // ===== 公開API =====
    window.OCR = {
        initOcr: initOcr,
        recognizeText: recognizeText,
        terminateOcr: terminateOcr,
        extractVitalsFromOcr: extractVitalsFromOcr,
        runExtractionSelfTest: runExtractionSelfTest,
        isDebugMode: isDebugMode,
        get preprocessImage() { return getPreprocessImage(); }
    };

    console.log('[OCR] モジュール読み込み完了（多重試行対応版）');

})();
