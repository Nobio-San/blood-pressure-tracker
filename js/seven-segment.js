/**
 * 7セグメント表示認識モジュール
 * 血圧計のLCD 7セグメント表示を読み取る（Tesseract OCRの代替・補完）
 *
 * セグメント配置（標準）:
 *    aaa
 *   f   b
 *   f   b
 *    ggg
 *   e   c
 *   e   c
 *    ddd
 */
(function() {
    'use strict';

    // 0-9 のセグメントパターン（a=0x40, b=0x20, c=0x10, d=0x08, e=0x04, f=0x02, g=0x01）
    var SEGMENT_PATTERNS = {
        0: 0x7E, 1: 0x30, 2: 0x6D, 3: 0x79, 4: 0x33,
        5: 0x5B, 6: 0x5F, 7: 0x70, 8: 0x7F, 9: 0x73
    };

    var PATTERN_TO_DIGIT = {};
    for (var d = 0; d <= 9; d++) {
        PATTERN_TO_DIGIT[SEGMENT_PATTERNS[d]] = d;
    }

    // 1ビット違いの許容（ノイズ対策）
    var FUZZY_PATTERNS = {};
    for (var d = 0; d <= 9; d++) {
        var p = SEGMENT_PATTERNS[d];
        FUZZY_PATTERNS[p] = d;
        for (var bit = 0; bit < 7; bit++) {
            var flipped = p ^ (1 << bit);
            if (!(flipped in FUZZY_PATTERNS)) FUZZY_PATTERNS[flipped] = d;
        }
    }

    /**
     * 単一桁画像から7セグメントパターンを検出
     * @param {HTMLCanvasElement} digitCanvas - 1桁分の画像
     * @param {Object} opts - { invert: boolean } 暗いセグメント=true
     * @returns {number|null} 0-9 または null
     */
    function recognizeDigit(digitCanvas, opts) {
        opts = opts || {};
        var w = digitCanvas.width;
        var h = digitCanvas.height;
        if (w < 5 || h < 5) return null;

        var ctx = digitCanvas.getContext('2d');
        var imgData = ctx.getImageData(0, 0, w, h);
        var d = imgData.data;

        function sampleRegion(x1, y1, x2, y2) {
            var sum = 0, count = 0;
            for (var y = Math.max(0, y1); y < Math.min(h, y2); y++) {
                for (var x = Math.max(0, x1); x < Math.min(w, x2); x++) {
                    var i = (y * w + x) * 4;
                    sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
                    count++;
                }
            }
            return count > 0 ? sum / count : 0;
        }

        var r0 = 0, r1 = h / 5, r2 = 2 * h / 5, r3 = 3 * h / 5, r4 = 4 * h / 5, r5 = h;
        var c0 = 0, c1 = w / 3, c2 = 2 * w / 3, c3 = w;

        var segA = sampleRegion(c0, r0, c3, r1);
        var segB = sampleRegion(c2, r1, c3, r3);
        var segC = sampleRegion(c2, r3, c3, r5);
        var segD = sampleRegion(c0, r4, c3, r5);
        var segE = sampleRegion(c0, r3, c1, r5);
        var segF = sampleRegion(c0, r1, c1, r3);
        var segG = sampleRegion(c0, r2, c3, r3);

        var segs = [segA, segB, segC, segD, segE, segF, segG];
        var total = segs.reduce(function(a, b) { return a + b; }, 0);
        var threshold = total / 7;

        var pattern = 0;
        for (var i = 0; i < 7; i++) {
            var lit = opts.invert ? segs[i] < threshold : segs[i] > threshold;
            if (lit) pattern |= (1 << (6 - i));
        }

        if (pattern in PATTERN_TO_DIGIT) return PATTERN_TO_DIGIT[pattern];
        if (pattern in FUZZY_PATTERNS) return FUZZY_PATTERNS[pattern];
        return null;
    }

    /**
     * 画像をソースからcanvasに変換
     */
    function toCanvas(source) {
        if (!source) return Promise.reject(new Error('画像ソースが指定されていません'));
        if (source instanceof HTMLCanvasElement) {
            var c = document.createElement('canvas');
            c.width = source.width;
            c.height = source.height;
            c.getContext('2d').drawImage(source, 0, 0);
            return Promise.resolve(c);
        }
        if (typeof source === 'string') {
            return new Promise(function(resolve, reject) {
                var img = new Image();
                img.onload = function() {
                    var c = document.createElement('canvas');
                    c.width = img.naturalWidth;
                    c.height = img.naturalHeight;
                    c.getContext('2d').drawImage(img, 0, 0);
                    resolve(c);
                };
                img.onerror = function() { reject(new Error('画像の読み込みに失敗しました')); };
                img.crossOrigin = 'anonymous';
                img.src = source;
            });
        }
        if (source instanceof Blob) {
            return new Promise(function(resolve, reject) {
                var url = URL.createObjectURL(source);
                var img = new Image();
                img.onload = function() {
                    URL.revokeObjectURL(url);
                    var c = document.createElement('canvas');
                    c.width = img.naturalWidth;
                    c.height = img.naturalHeight;
                    c.getContext('2d').drawImage(img, 0, 0);
                    resolve(c);
                };
                img.onerror = function() {
                    URL.revokeObjectURL(url);
                    reject(new Error('Blob画像の読み込みに失敗しました'));
                };
                img.src = url;
            });
        }
        return Promise.reject(new Error('未対応の画像ソース形式です'));
    }

    /**
     * 画像をグレースケール＋二値化（7セグ用：暗背景・明セグメントを想定）
     */
    function preprocessFor7Seg(canvas) {
        var w = canvas.width;
        var h = canvas.height;
        var out = document.createElement('canvas');
        out.width = w;
        out.height = h;
        var ctx = out.getContext('2d');
        ctx.drawImage(canvas, 0, 0);
        var id = ctx.getImageData(0, 0, w, h);
        var d = id.data;
        for (var i = 0; i < d.length; i += 4) {
            var g = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
            d[i] = d[i + 1] = d[i + 2] = g;
        }
        ctx.putImageData(id, 0, 0);
        return out;
    }

    /**
     * 縦方向の輝度プロファイルから桁の境界を推定
     * @param {HTMLCanvasElement} canvas - 数値行の画像
     * @param {number} digitCount - 想定桁数（2 or 3）
     * @returns {number[]} 各桁の左端x座標（digitCount+1個）
     */
    function findDigitBoundaries(canvas, digitCount) {
        var w = canvas.width;
        var h = canvas.height;
        var ctx = canvas.getContext('2d');
        var id = ctx.getImageData(0, 0, w, h);
        var d = id.data;

        var profile = [];
        for (var x = 0; x < w; x++) {
            var sum = 0;
            for (var y = 0; y < h; y++) {
                var i = (y * w + x) * 4;
                sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
            }
            profile.push(sum / h);
        }

        var avg = profile.reduce(function(a, b) { return a + b; }, 0) / w;
        var gaps = [];
        var inGap = false;
        var gapStart = 0;
        for (var i = 0; i < w; i++) {
            var dark = profile[i] < avg * 0.9;
            if (dark && !inGap) {
                inGap = true;
                gapStart = i;
            } else if (!dark && inGap && (i - gapStart) > w * 0.03) {
                inGap = false;
                gaps.push(Math.floor((gapStart + i) / 2));
            }
        }

        if (gaps.length >= digitCount) {
            gaps.sort(function(a, b) { return a - b; });
            var step = Math.floor(w / (digitCount + 1));
            var bounds = [0];
            for (var k = 0; k < digitCount - 1; k++) {
                var target = step * (k + 1);
                var best = gaps.reduce(function(prev, g) {
                    return Math.abs(g - target) < Math.abs(prev - target) ? g : prev;
                });
                bounds.push(best);
            }
            bounds.push(w);
            bounds.sort(function(a, b) { return a - b; });
            return bounds;
        }

        var step = w / digitCount;
        var fixed = [0];
        for (var j = 1; j < digitCount; j++) fixed.push(Math.floor(step * j));
        fixed.push(w);
        return fixed;
    }

    /**
     * 血圧計画像から3行の数値を7セグ方式で読み取る
     * レイアウト: 上段=最高血圧(3桁), 中段=最低血圧(2桁), 下段=脈拍(2桁)
     * @param {HTMLCanvasElement|string} source - 画像（ガイド枠クロップ済み推奨）
     * @param {Object} opts - { invert: boolean }
     * @returns {Promise<{systolic:number|null, diastolic:number|null, pulse:number|null, method:string}>}
     */
    async function recognizeBloodPressureDisplay(source, opts) {
        opts = opts || {};
        var canvas = await toCanvas(source);
        var w = canvas.width;
        var h = canvas.height;
        if (w < 20 || h < 20) {
            return { systolic: null, diastolic: null, pulse: null, method: '7seg' };
        }

        canvas = preprocessFor7Seg(canvas);

        var bandH = h / 3;
        var bandY = [0, bandH, 2 * bandH];

        function extractRow(rowIndex, digitCount) {
            var y = bandY[rowIndex];
            var rowCanvas = document.createElement('canvas');
            rowCanvas.width = w;
            rowCanvas.height = Math.ceil(bandH);
            rowCanvas.getContext('2d').drawImage(canvas, 0, y, w, bandH, 0, 0, w, bandH);

            var bounds = findDigitBoundaries(rowCanvas, digitCount);
            var digits = [];
            for (var i = 0; i < digitCount; i++) {
                var x1 = bounds[i];
                var x2 = bounds[i + 1];
                var digitW = Math.max(10, x2 - x1 - 2);
                var digitCanvas = document.createElement('canvas');
                digitCanvas.width = digitW;
                digitCanvas.height = Math.ceil(bandH) - 4;
                digitCanvas.getContext('2d').drawImage(rowCanvas, x1 + 1, 2, digitW, bandH - 4, 0, 0, digitW, bandH - 4);

                var d = recognizeDigit(digitCanvas, opts);
                digits.push(d);
            }
            return digits;
        }

        var sysDigits = extractRow(0, 3);
        var diaDigits = extractRow(1, 2);
        var pulDigits = extractRow(2, 2);

        function toNumber(arr) {
            if (arr.some(function(x) { return x === null; })) return null;
            return parseInt(arr.join(''), 10);
        }

        var systolic = toNumber(sysDigits);
        var diastolic = toNumber(diaDigits);
        var pulse = toNumber(pulDigits);

        if (systolic === null && opts.tryInvert !== false) {
            opts.invert = !opts.invert;
            return recognizeBloodPressureDisplay(source, opts);
        }

        return {
            systolic: systolic,
            diastolic: diastolic,
            pulse: pulse,
            method: '7seg',
            rawDigits: { sys: sysDigits, dia: diaDigits, pul: pulDigits }
        };
    }

    /**
     * 2桁・3桁の可変対応版（上段が2桁の場合は3桁として扱う）
     */
    async function recognizeBloodPressureDisplayFlexible(source, opts) {
        opts = opts || {};
        var canvas = await toCanvas(source);
        var w = canvas.width;
        var h = canvas.height;
        if (w < 20 || h < 20) {
            return { systolic: null, diastolic: null, pulse: null, method: '7seg' };
        }

        canvas = preprocessFor7Seg(canvas);
        var bandH = h / 3;
        var bandY = [0, bandH, 2 * bandH];

        function extractRowFlexible(rowIndex) {
            var y = bandY[rowIndex];
            var rowCanvas = document.createElement('canvas');
            rowCanvas.width = w;
            rowCanvas.height = Math.ceil(bandH);
            rowCanvas.getContext('2d').drawImage(canvas, 0, y, w, bandH, 0, 0, w, bandH);

            function tryExtract(digitCount, bounds) {
                var digits = [];
                for (var i = 0; i < digitCount; i++) {
                    var x1 = bounds[i];
                    var x2 = bounds[i + 1];
                    var digitW = Math.max(10, Math.min(80, x2 - x1 - 2));
                    var digitCanvas = document.createElement('canvas');
                    digitCanvas.width = digitW;
                    digitCanvas.height = Math.max(15, Math.ceil(bandH) - 4);
                    digitCanvas.getContext('2d').drawImage(rowCanvas, x1 + 1, 2, digitW, bandH - 4, 0, 0, digitW, bandH - 4);
                    var d = recognizeDigit(digitCanvas, opts);
                    digits.push(d);
                }
                return digits;
            }

            for (var dc = 3; dc >= 2; dc--) {
                var bounds = findDigitBoundaries(rowCanvas, dc);
                var digits = tryExtract(dc, bounds);
                if (!digits.some(function(x) { return x === null; })) {
                    return { value: parseInt(digits.join(''), 10), digits: digits };
                }
                var step = w / dc;
                var fixedBounds = [0];
                for (var j = 1; j < dc; j++) fixedBounds.push(Math.floor(step * j));
                fixedBounds.push(w);
                digits = tryExtract(dc, fixedBounds);
                if (!digits.some(function(x) { return x === null; })) {
                    return { value: parseInt(digits.join(''), 10), digits: digits };
                }
            }
            return { value: null, digits: [] };
        }

        var sysRow = extractRowFlexible(0);
        var diaRow = extractRowFlexible(1);
        var pulRow = extractRowFlexible(2);

        var result = {
            systolic: sysRow.value,
            diastolic: diaRow.value,
            pulse: pulRow.value,
            method: '7seg',
            rawDigits: { sys: sysRow.digits, dia: diaRow.digits, pul: pulRow.digits }
        };

        if (result.systolic === null && result.diastolic === null && opts.tryInvert !== false) {
            opts.invert = !opts.invert;
            opts.tryInvert = false;
            return recognizeBloodPressureDisplayFlexible(source, opts);
        }

        return result;
    }

    window.SevenSegment = {
        recognizeDigit: recognizeDigit,
        recognizeBloodPressureDisplay: recognizeBloodPressureDisplay,
        recognizeBloodPressureDisplayFlexible: recognizeBloodPressureDisplayFlexible,
        toCanvas: toCanvas,
        preprocessFor7Seg: preprocessFor7Seg
    };

    console.log('[SevenSegment] 7セグメント認識モジュール読み込み完了');
})();
