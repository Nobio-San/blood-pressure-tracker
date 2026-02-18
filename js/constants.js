/**
 * 前処理・OCR関連の定数（Phase 3 Step 3-2）
 * 魔法数を散在させないためここに集約
 */
const PREPROCESS_DEFAULTS = {
    roiMarginRatio: 0.03,
    resizeLongEdgeMax: 960,
    thresholdMode: 'otsu',
    adaptive: {
        windowSize: 21,
        c: 7
    },
    contrast: {
        enabled: false,
        contrast: 0.1,
        brightness: 0
    },
    median: {
        enabled: false,
        radius: 1
    },
    morphology: {
        enabled: false,
        op: 'dilate',
        iterations: 1
    },
    debug: {
        enabled: false,
        stages: ['source', 'roi', 'gray', 'bin', 'post'],
        maxKeep: 5
    }
};

window.PREPROCESS_DEFAULTS = PREPROCESS_DEFAULTS;
