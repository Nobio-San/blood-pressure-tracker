/**
 * 画像前処理モジュール（Phase 3 Step 3-2）
 * 入力: 画像要素/Canvas/Blob/base64 → 出力: 前処理済みcanvas + meta
 * ROI→グレースケール→二値化→（任意）ノイズ除去を直列パイプラインで実施
 */
(function() {
    'use strict';

    const D = window.PREPROCESS_DEFAULTS || {};

    /**
     * 入力sourceをcanvasに描画して返す（非同期）
     * 入力: HTMLImageElement | HTMLCanvasElement | Blob | string(base64/URL)
     * 出力: Promise<HTMLCanvasElement>
     */
    function sourceToCanvas(source) {
        if (!source) {
            return Promise.reject(new Error('画像ソースが指定されていません'));
        }
        if (source instanceof HTMLCanvasElement) {
            const c = document.createElement('canvas');
            c.width = source.width;
            c.height = source.height;
            c.getContext('2d').drawImage(source, 0, 0);
            return Promise.resolve(c);
        }
        if (source instanceof HTMLImageElement) {
            const c = document.createElement('canvas');
            c.width = source.naturalWidth || source.width;
            c.height = source.naturalHeight || source.height;
            c.getContext('2d').drawImage(source, 0, 0);
            return Promise.resolve(c);
        }
        if (typeof source === 'string') {
            return new Promise((resolve, reject) => {
                const img = new Image();
                img.onload = () => {
                    const c = document.createElement('canvas');
                    c.width = img.naturalWidth;
                    c.height = img.naturalHeight;
                    c.getContext('2d').drawImage(img, 0, 0);
                    resolve(c);
                };
                img.onerror = () => reject(new Error('画像の読み込みに失敗しました'));
                img.crossOrigin = 'anonymous';
                img.src = source;
            });
        }
        if (source instanceof Blob) {
            return new Promise((resolve, reject) => {
                const url = URL.createObjectURL(source);
                const img = new Image();
                img.onload = () => {
                    URL.revokeObjectURL(url);
                    const c = document.createElement('canvas');
                    c.width = img.naturalWidth;
                    c.height = img.naturalHeight;
                    c.getContext('2d').drawImage(img, 0, 0);
                    resolve(c);
                };
                img.onerror = () => {
                    URL.revokeObjectURL(url);
                    reject(new Error('Blob画像の読み込みに失敗しました'));
                };
                img.src = url;
            });
        }
        return Promise.reject(new Error('未対応の画像ソース形式です'));
    }

    /**
     * ガイド枠（表示座標）を撮影画像座標系に変換
     * object-fit: cover を想定（コンテナを埋めるように拡大しはみ出しをクリップ）
     * 入力: guideRect(DOMRect相当), videoDisplayRect(表示領域), captureSize({ width, height })
     * 出力: { x, y, width, height } 画像ピクセル、clamp済み
     */
    function mapGuideRectToImageRect(guideRect, videoDisplayRect, captureSize) {
        const cw = videoDisplayRect.width || 1;
        const ch = videoDisplayRect.height || 1;
        const iw = captureSize.width || 1;
        const ih = captureSize.height || 1;
        const scale = Math.max(cw / iw, ch / ih);
        const offsetX = iw / 2 - cw / (2 * scale);
        const offsetY = ih / 2 - ch / (2 * scale);
        let x = Math.round(guideRect.x / scale + offsetX);
        let y = Math.round(guideRect.y / scale + offsetY);
        let w = Math.round((guideRect.width || 0) / scale);
        let h = Math.round((guideRect.height || 0) / scale);
        x = Math.max(0, Math.min(x, iw - 1));
        y = Math.max(0, Math.min(y, ih - 1));
        const x2 = Math.max(0, Math.min(x + w, iw));
        const y2 = Math.max(0, Math.min(y + h, ih));
        w = x2 - x;
        h = y2 - y;
        if (w <= 0 || h <= 0) {
            w = Math.max(1, w);
            h = Math.max(1, h);
        }
        return { x, y, width: w, height: h };
    }

    /**
     * ROIで切り抜き。未指定時は中央寄せ固定比率でフォールバック
     * 入力: inputCanvas, roi(任意), marginRatio(0〜0.1程度)
     * 出力: 新規canvas（切り抜き結果）、metaにroi最終値を積む
     */
    function cropToROI(inputCanvas, roi, marginRatio, meta) {
        const w = inputCanvas.width;
        const h = inputCanvas.height;
        let x, y, rw, rh;
        if (roi && typeof roi.width === 'number' && typeof roi.height === 'number' && roi.width > 0 && roi.height > 0) {
            const marginX = Math.floor((roi.width || 0) * (marginRatio || 0));
            const marginY = Math.floor((roi.height || 0) * (marginRatio || 0));
            x = Math.max(0, (roi.x || 0) - marginX);
            y = Math.max(0, (roi.y || 0) - marginY);
            rw = Math.min(w - x, (roi.width || 0) + 2 * marginX);
            rh = Math.min(h - y, (roi.height || 0) + 2 * marginY);
            if (x + rw > w) rw = w - x;
            if (y + rh > h) rh = h - y;
            if (rw <= 0 || rh <= 0) {
                rw = Math.max(1, rw);
                rh = Math.max(1, rh);
            }
            if (meta && meta.warnings) meta.warnings.push('ROIマージン適用');
        } else {
            const ratio = 0.88;
            rw = Math.floor(Math.min(w, h) * ratio);
            rh = Math.floor(rw * 0.5);
            if (rh > h) rh = Math.floor(h * ratio);
            x = Math.max(0, Math.floor((w - rw) / 2));
            y = Math.max(0, Math.floor((h - rh) / 2));
            rw = Math.min(rw, w - x);
            rh = Math.min(rh, h - y);
            if (meta && meta.warnings) meta.warnings.push('ROI未指定のため中央固定比率で切り抜き');
        }
        const out = document.createElement('canvas');
        out.width = rw;
        out.height = rh;
        out.getContext('2d').drawImage(inputCanvas, x, y, rw, rh, 0, 0, rw, rh);
        if (meta) {
            meta.roi = { x, y, width: rw, height: rh, marginApplied: !!marginRatio && marginRatio > 0 };
        }
        return out;
    }

    /**
     * 長辺を上限で縮小（必要時のみ新規canvas）
     */
    function resizeLongEdge(canvas, longEdgeMax, meta) {
        const w = canvas.width;
        const h = canvas.height;
        const maxEdge = Math.max(w, h);
        if (maxEdge <= longEdgeMax || longEdgeMax <= 0) {
            if (meta) meta.resize = { applied: false, scale: 1, longEdgeMax };
            return canvas;
        }
        const scale = longEdgeMax / maxEdge;
        const nw = Math.round(w * scale);
        const nh = Math.round(h * scale);
        const out = document.createElement('canvas');
        out.width = nw;
        out.height = nh;
        out.getContext('2d').drawImage(canvas, 0, 0, w, h, 0, 0, nw, nh);
        if (meta) meta.resize = { applied: true, scale, longEdgeMax };
        return out;
    }

    /**
     * グレースケール化（輝度 0.299R+0.587G+0.114B、in-place）
     */
    function toGrayscale(canvas) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        const data = ctx.getImageData(0, 0, w, h);
        const d = data.data;
        const len = d.length;
        for (let i = 0; i < len; i += 4) {
            const v = (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0;
            d[i] = d[i + 1] = d[i + 2] = v;
            d[i + 3] = 255;
        }
        ctx.putImageData(data, 0, 0);
        return canvas;
    }

    /**
     * コントラスト・明度の線形補正（in-place）
     * contrast: 0で無変化、brightness: 0で無変化
     */
    function adjustContrast(canvas, contrast, brightness) {
        if (!contrast && !brightness) return canvas;
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        const data = ctx.getImageData(0, 0, w, h);
        const d = data.data;
        const factor = (259 * (contrast * 255 + 255)) / (255 * (259 - contrast * 255));
        const len = d.length;
        for (let i = 0; i < len; i += 4) {
            let r = d[i] * factor + brightness * 255;
            let g = d[i + 1] * factor + brightness * 255;
            let b = d[i + 2] * factor + brightness * 255;
            d[i] = Math.max(0, Math.min(255, r | 0));
            d[i + 1] = Math.max(0, Math.min(255, g | 0));
            d[i + 2] = Math.max(0, Math.min(255, b | 0));
        }
        ctx.putImageData(data, 0, 0);
        return canvas;
    }

    /**
     * ヒストグラムからOtsu閾値を算出
     */
    function otsuThreshold(imageData) {
        const d = imageData.data;
        const len = d.length;
        const hist = new Int32Array(256);
        for (let i = 0; i < len; i += 4) {
            hist[d[i]]++;
        }
        let sum = 0;
        for (let i = 0; i < 256; i++) sum += i * hist[i];
        let sumB = 0;
        let wB = 0;
        let wF;
        let maxVar = 0;
        let threshold = 0;
        const total = len / 4;
        for (let t = 0; t < 256; t++) {
            wB += hist[t];
            if (wB === 0) continue;
            wF = total - wB;
            if (wF === 0) break;
            sumB += t * hist[t];
            const mB = sumB / wB;
            const mF = (sum - sumB) / wF;
            const varBetween = wB * wF * (mB - mF) * (mB - mF);
            if (varBetween > maxVar) {
                maxVar = varBetween;
                threshold = t;
            }
        }
        return threshold;
    }

    /**
     * 二値化（閾値で白黒、in-place）
     */
    function binarize(canvas, threshold) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        const data = ctx.getImageData(0, 0, w, h);
        const d = data.data;
        const len = d.length;
        const t = threshold != null ? threshold : 128;
        for (let i = 0; i < len; i += 4) {
            const v = d[i] <= t ? 0 : 255;
            d[i] = d[i + 1] = d[i + 2] = v;
            d[i + 3] = 255;
        }
        ctx.putImageData(data, 0, 0);
        return canvas;
    }

    /**
     * 適応的閾値（局所平均との比較、重いので小ROI向け）
     */
    function adaptiveThreshold(canvas, windowSize, c) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        const data = ctx.getImageData(0, 0, w, h);
        const d = data.data;
        const half = (windowSize | 0) || 11;
        const radius = Math.max(1, half);
        const C = (c | 0) || 5;
        const out = new Uint8ClampedArray(d.length);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                let sum = 0;
                let count = 0;
                for (let dy = -radius; dy <= radius; dy++) {
                    for (let dx = -radius; dx <= radius; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                            const idx = (ny * w + nx) * 4;
                            sum += d[idx];
                            count++;
                        }
                    }
                }
                const mean = count > 0 ? sum / count : 0;
                const idx = (y * w + x) * 4;
                const v = d[idx] <= (mean - C) ? 0 : 255;
                out[idx] = out[idx + 1] = out[idx + 2] = v;
                out[idx + 3] = 255;
            }
        }
        for (let i = 0; i < d.length; i++) d[i] = out[i];
        ctx.putImageData(data, 0, 0);
        return canvas;
    }

    /**
     * メディアンフィルタ（グレースケール前提、半径は小さく）
     */
    function medianFilter(canvas, radius) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        const data = ctx.getImageData(0, 0, w, h);
        const d = data.data;
        const r = Math.max(1, Math.min(2, radius | 0));
        const arr = [];
        const out = new Uint8ClampedArray(d.length);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                arr.length = 0;
                for (let dy = -r; dy <= r; dy++) {
                    for (let dx = -r; dx <= r; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
                            arr.push(d[((ny * w + nx) * 4)]);
                        }
                    }
                }
                arr.sort((a, b) => a - b);
                const mid = arr[Math.floor(arr.length / 2)];
                const idx = (y * w + x) * 4;
                out[idx] = out[idx + 1] = out[idx + 2] = mid;
                out[idx + 3] = 255;
            }
        }
        for (let i = 0; i < d.length; i++) d[i] = out[i];
        ctx.putImageData(data, 0, 0);
        return canvas;
    }

    /**
     * モルフォロジー（膨張/収縮）、二値画像前提
     */
    function morphology(canvas, op, iterations) {
        const ctx = canvas.getContext('2d');
        const w = canvas.width;
        const h = canvas.height;
        const data = ctx.getImageData(0, 0, w, h);
        const d = data.data;
        const it = Math.max(1, iterations | 0);
        const get = (x, y) => {
            if (x < 0 || x >= w || y < 0 || y >= h) return op === 'dilate' ? 0 : 255;
            return d[(y * w + x) * 4];
        };
        for (let iter = 0; iter < it; iter++) {
            const buf = new Uint8ClampedArray(d.length);
            for (let y = 0; y < h; y++) {
                for (let x = 0; x < w; x++) {
                    let v = get(x, y);
                    if (op === 'dilate') {
                        v = Math.max(v, get(x - 1, y), get(x + 1, y), get(x, y - 1), get(x, y + 1));
                    } else {
                        v = Math.min(v, get(x - 1, y), get(x + 1, y), get(x, y - 1), get(x, y + 1));
                    }
                    const idx = (y * w + x) * 4;
                    buf[idx] = buf[idx + 1] = buf[idx + 2] = v;
                    buf[idx + 3] = 255;
                }
            }
            for (let i = 0; i < d.length; i++) d[i] = buf[i];
        }
        ctx.putImageData(data, 0, 0);
        return canvas;
    }

    /**
     * 直列パイプライン適用。各ステップの処理時間をmeta.timingsMs.stepsに記録
     */
    function applyPipeline(initialCanvas, options, meta) {
        const steps = [];
        const timings = meta.timingsMs && meta.timingsMs.steps ? meta.timingsMs.steps : {};
        let canvas = initialCanvas;
        const debug = options.debug && options.debug.enabled;
        const maxKeep = (options.debug && options.debug.maxKeep) || 5;
        const debugCanvases = (meta.debugCanvases = meta.debugCanvases || []);

        function keepDebug(label) {
            if (!debug || debugCanvases.length >= maxKeep) return;
            const c = document.createElement('canvas');
            c.width = canvas.width;
            c.height = canvas.height;
            c.getContext('2d').drawImage(canvas, 0, 0);
            debugCanvases.push({ label, canvas: c });
        }

        const roiOpt = options.roi;
        const roiFromGuide = options.roiFromGuide;
        const marginRatio = options.roiMarginRatio != null ? options.roiMarginRatio : (D.roiMarginRatio != null ? D.roiMarginRatio : 0.03);
        let roi = roiOpt;
        if (roiFromGuide && roiFromGuide.guideRect && roiFromGuide.captureSize) {
            roi = mapGuideRectToImageRect(
                roiFromGuide.guideRect,
                roiFromGuide.videoDisplayRect || roiFromGuide.guideRect,
                roiFromGuide.captureSize
            );
        }

        let t0 = performance.now();
        canvas = cropToROI(canvas, roi, marginRatio, meta);
        timings.roi = Math.round(performance.now() - t0);
        keepDebug('roi');

        const longEdgeMax = options.resizeLongEdgeMax != null ? options.resizeLongEdgeMax : (D.resizeLongEdgeMax != null ? D.resizeLongEdgeMax : 960);
        t0 = performance.now();
        canvas = resizeLongEdge(canvas, longEdgeMax, meta);
        timings.resize = Math.round(performance.now() - t0);

        t0 = performance.now();
        canvas = toGrayscale(canvas);
        timings.grayscale = Math.round(performance.now() - t0);
        keepDebug('gray');

        const contrastOpt = options.contrast != null ? options.contrast : D.contrast;
        if (contrastOpt && contrastOpt.enabled) {
            t0 = performance.now();
            adjustContrast(canvas, contrastOpt.contrast || 0, contrastOpt.brightness || 0);
            timings.contrast = Math.round(performance.now() - t0);
        }

        const medianOpt = options.median != null ? options.median : D.median;
        if (medianOpt && medianOpt.enabled && medianOpt.radius) {
            t0 = performance.now();
            medianFilter(canvas, medianOpt.radius);
            timings.median = Math.round(performance.now() - t0);
        }

        const mode = options.thresholdMode || D.thresholdMode || 'otsu';
        let thresholdValue = null;
        t0 = performance.now();
        if (mode === 'otsu' || mode === 'auto') {
            const id = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
            thresholdValue = otsuThreshold(id);
            binarize(canvas, thresholdValue);
        } else if (mode === 'adaptive') {
            const ad = options.adaptive != null ? options.adaptive : D.adaptive;
            adaptiveThreshold(canvas, ad && ad.windowSize, ad && ad.c);
            if (meta.threshold) meta.threshold.mode = 'adaptive';
        }
        timings.binarize = Math.round(performance.now() - t0);
        if (meta.threshold) {
            meta.threshold.mode = mode;
            meta.threshold.value = thresholdValue;
        }
        keepDebug('bin');

        const morphOpt = options.morphology != null ? options.morphology : D.morphology;
        if (morphOpt && morphOpt.enabled && morphOpt.iterations) {
            t0 = performance.now();
            morphology(canvas, morphOpt.op || 'dilate', morphOpt.iterations);
            timings.morphology = Math.round(performance.now() - t0);
            keepDebug('post');
        }

        if (meta.timingsMs) {
            let total = 0;
            for (const k in timings) total += timings[k];
            meta.timingsMs.total = Math.round(total);
        }
        return canvas;
    }

    /**
     * 前処理の公開API
     * 入力: source, options
     * 出力: Promise<{ canvas, meta }> 失敗時はwarningsに理由を入れ可能なら最小限で続行
     */
    async function preprocessImage(source, options) {
        const opts = options || {};
        const meta = {
            roi: null,
            threshold: { mode: opts.thresholdMode || 'otsu', value: null },
            timingsMs: { total: 0, steps: {} },
            resize: { applied: false, scale: 1, longEdgeMax: null },
            warnings: []
        };
        try {
            let canvas = await sourceToCanvas(source);
            if (!canvas || canvas.width === 0 || canvas.height === 0) {
                meta.warnings.push('ソース画像のサイズが無効です');
                return { canvas, meta };
            }
            canvas = applyPipeline(canvas, opts, meta);
            return { canvas, meta };
        } catch (err) {
            meta.warnings.push(err.message || '前処理中にエラーが発生しました');
            try {
                const fallback = await sourceToCanvas(source);
                if (fallback && fallback.width > 0 && fallback.height > 0) {
                    return { canvas: fallback, meta };
                }
            } catch (_) {}
            throw err;
        }
    }

    window.ImagePreprocess = {
        preprocessImage,
        mapGuideRectToImageRect,
        cropToROI,
        toGrayscale,
        otsuThreshold,
        binarize,
        sourceToCanvas
    };
})();
