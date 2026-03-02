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

/**
 * OCR精度最適化定数（Phase 3 Step 3-5）
 * 試行数・閾値・スコア重み・探索順序などを集約
 */
const OCR_CONSTANTS = {
    OCR_DEBUG_DEFAULT: false,
    USE_7SEG_FIRST: true,

    ATTEMPTS_MAX: 24,
    ROI_CANDIDATES_MAX: 3,

    RESOLUTION_LEVELS: [640, 960, 1280],
    PSM_LIST: [7, 6, 8],

    OCR_TOTAL_TIMEOUT_MS: 10000,
    SCORE_EARLY_ACCEPT: 85,

    SYS_MIN: 50,
    SYS_MAX: 250,
    DIA_MIN: 30,
    DIA_MAX: 150,
    PUL_MIN: 40,
    PUL_MAX: 200,

    OCR_CONF_WEIGHT: 0.4,
    EXTRACT_WEIGHT: 0.6,

    SCORE_RANGE_VALID: 20,
    SCORE_SYS_GT_DIA: 20,
    SCORE_TYPICAL_RANGE: 5,
    SCORE_SEPARATOR_CLEAR: 10,
    SCORE_LABEL_FOUND: 15,

    PENALTY_MISSING_VALUE: 30,
    PENALTY_OUTLIER: 10,

    CONFIDENCE_HIGH: 80,
    CONFIDENCE_MEDIUM: 60,

    RETRY_MAX: 1,

    PREPROCESS_PATTERNS: [
        {
            name: 'A',
            label: 'グレースケール＋Otsu二値化',
            options: {
                thresholdMode: 'otsu',
                contrast: { enabled: false },
                median: { enabled: false },
                morphology: { enabled: false }
            }
        },
        {
            name: 'B',
            label: 'コントラスト強調＋二値化',
            options: {
                thresholdMode: 'otsu',
                contrast: { enabled: true, contrast: 0.3, brightness: 0.05 },
                median: { enabled: false },
                morphology: { enabled: false }
            }
        },
        {
            name: 'C',
            label: 'エッジ強調＋二値化',
            options: {
                thresholdMode: 'otsu',
                contrast: { enabled: true, contrast: 0.5, brightness: 0 },
                median: { enabled: true, radius: 1 },
                morphology: { enabled: true, op: 'erode', iterations: 1 }
            }
        },
        {
            name: 'D',
            label: 'Adaptive閾値（LCD向け）',
            options: {
                thresholdMode: 'adaptive',
                contrast: { enabled: false },
                median: { enabled: true, radius: 1 },
                morphology: { enabled: false }
            }
        },
        {
            name: 'E',
            label: 'Otsu二値化＋膨張（LCD太字化）',
            options: {
                thresholdMode: 'otsu',
                contrast: { enabled: false },
                median: { enabled: false },
                morphology: { enabled: true, op: 'dilate', iterations: 2 },
                invert: false
            }
        },
        {
            name: 'F',
            label: 'Otsu二値化＋膨張＋反転（明背景化）',
            options: {
                thresholdMode: 'otsu',
                contrast: { enabled: false },
                median: { enabled: false },
                morphology: { enabled: true, op: 'dilate', iterations: 2 },
                invert: true
            }
        },
        {
            name: 'G',
            label: 'Adaptive閾値＋膨張＋反転（LCD明背景）',
            options: {
                thresholdMode: 'adaptive',
                contrast: { enabled: false },
                median: { enabled: true, radius: 1 },
                morphology: { enabled: true, op: 'dilate', iterations: 2 },
                invert: true
            }
        },
        {
            name: 'H',
            label: 'ハイライト抑制＋Otsu＋膨張＋反転（映り込み対策）',
            options: {
                highlightSuppress: { enabled: true, ceiling: 220, replaceValue: 180 },
                thresholdMode: 'otsu',
                contrast: { enabled: false },
                median: { enabled: false },
                morphology: { enabled: true, op: 'dilate', iterations: 2 },
                invert: true
            }
        },
        {
            name: 'I',
            label: 'ハイライト抑制＋Adaptive＋膨張＋反転（映り込み＋LCD対策）',
            options: {
                highlightSuppress: { enabled: true, ceiling: 200, replaceValue: 160 },
                thresholdMode: 'adaptive',
                contrast: { enabled: false },
                median: { enabled: true, radius: 1 },
                morphology: { enabled: true, op: 'dilate', iterations: 2 },
                invert: true
            }
        },
        {
            name: 'J',
            label: 'ハイライト抑制＋Adaptive＋反転（膨張なし・細線保護）',
            options: {
                highlightSuppress: { enabled: true, ceiling: 220, replaceValue: 180 },
                thresholdMode: 'adaptive',
                contrast: { enabled: false },
                median: { enabled: true, radius: 1 },
                morphology: { enabled: false },
                invert: true
            }
        },
        {
            name: 'K',
            label: 'ハイライト抑制＋Otsu＋反転（膨張なし・細線保護）',
            options: {
                highlightSuppress: { enabled: true, ceiling: 220, replaceValue: 180 },
                thresholdMode: 'otsu',
                contrast: { enabled: false },
                median: { enabled: false },
                morphology: { enabled: false },
                invert: true
            }
        },
        {
            name: 'L',
            label: 'グレースケールのみ（二値化なし・Tesseract内部処理に委任）',
            options: {
                thresholdMode: 'none',
                contrast: { enabled: false },
                median: { enabled: false },
                morphology: { enabled: false }
            }
        },
        {
            name: 'M',
            label: 'グレースケール＋コントラスト強調（二値化なし）',
            options: {
                thresholdMode: 'none',
                contrast: { enabled: true, contrast: 0.2, brightness: 0.05 },
                median: { enabled: false },
                morphology: { enabled: false }
            }
        }
    ],

    EXPLORATION_ORDER: [
        { resolution: 960, preprocess: 'L', psm: 4 },
        { resolution: 960, preprocess: 'L', psm: 6 },
        { resolution: 960, preprocess: 'M', psm: 4 },
        { resolution: 960, preprocess: 'M', psm: 6 },
        { resolution: 960, preprocess: 'J', psm: 4 },
        { resolution: 960, preprocess: 'K', psm: 4 },
        { resolution: 640, preprocess: 'L', psm: 4 },
        { resolution: 640, preprocess: 'L', psm: 6 },
        { resolution: 1280, preprocess: 'L', psm: 4 },
        { resolution: 1280, preprocess: 'L', psm: 6 },
        { resolution: 960, preprocess: 'H', psm: 4 },
        { resolution: 960, preprocess: 'I', psm: 4 },
        { resolution: 960, preprocess: 'H', psm: 11 },
        { resolution: 960, preprocess: 'H', psm: 6 },
        { resolution: 960, preprocess: 'I', psm: 11 },
        { resolution: 640, preprocess: 'J', psm: 4 },
        { resolution: 640, preprocess: 'H', psm: 11 },
        { resolution: 1280, preprocess: 'H', psm: 11 },
        { resolution: 1280, preprocess: 'F', psm: 11 }
    ],

    CAPTURE_HINTS: [
        '画面の反射を避けてください',
        '明るい場所で撮影してください',
        '血圧計の表示をガイド枠内に収めてください',
        'カメラを水平に構えてください'
    ]
};

window.OCR_CONSTANTS = OCR_CONSTANTS;

/**
 * グラフ機能強化 定数（Phase 4 Step 4-2）
 */
const GRAPH_CONSTANTS = {
    RANGE_KEYS: ['7d', '30d', '90d', 'all'],
    RANGE_DAYS: { '7d': 7, '30d': 30, '90d': 90 },
    CHART_TYPES: ['line', 'bar', 'scatter'],
    VIEW_MODES: ['trend', 'timeband', 'weekday'],
    TIMEBAND: {
        morning: { start: 4, end: 10, label: '朝' },
        noon: { start: 11, end: 16, label: '昼' },
        night: { start: 17, end: 3, label: '夜' }
    },
    WEEKDAY_LABELS: ['月', '火', '水', '木', '金', '土', '日'],
    SCATTER_MAX_DAYS: 90,
    ANIMATION_THRESHOLD: 200,
    STORAGE_KEY: 'bp_graph_state_v1'
};
window.GRAPH_CONSTANTS = GRAPH_CONSTANTS;
