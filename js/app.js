/**
 * 血圧記録アプリ - メインJavaScript
 * 目的: アプリの初期化と基本機能の提供
 */

/* =========================================
   定数・設定
   ========================================= */
const STORAGE_KEY = 'bp_records_v1';
const SCHEMA_VERSION = 1;
const MAX_LIST_COUNT = 10; // 一覧の最大表示件数
const SYNC_RETRY_INTERVAL_MS = 300; // 再同期時の送信間隔（ミリ秒）
const CHART_DAYS = 7; // グラフで表示する日数（過去N日）
const MAX_DATA_RETENTION_DAYS = 365; // データ保持期間（日数）

// Phase 2 Step 2-4: 画像プレビュー関連
const IMAGE_PREVIEW_MAX_HEIGHT = 200; // サムネイル最大高さ（px）

// Phase 3 Step 3-4: OCR確認UI定数
const OCR_CONFIDENCE_HIGH = 90; // 高信頼度しきい値（緑/✓）
const OCR_CONFIDENCE_MID  = 70; // 中信頼度しきい値（黄/!）
const OCR_RETRY_LIMIT = 3;      // 再試行の上限回数

// バリデーション範囲
const VALIDATION = {
    systolic: { min: 50, max: 250 },
    diastolic: { min: 30, max: 150 },
    pulse: { min: 40, max: 200 }
};

/* =========================================
   グローバル状態
   ========================================= */
let records = [];
let isResyncInProgress = false; // 再同期中フラグ（二重実行防止）
let bpChartInstance = null; // Chart.js インスタンス（描画/更新用）

// Phase 2 Step 2-4: 画像状態管理
let currentSelectedImage = null; // 現在選択中の画像データ { base64, width, height, mime, createdAt }

// Phase 3 Step 3-4: OCR状態管理
let ocrStatus = 'idle';   // 'idle' | 'running' | 'success' | 'failed'
let ocrResult = null;     // 抽出結果 { systolic, diastolic, pulse, confidence, fieldConf, rawText, warnings }
let ocrError  = null;     // エラー情報 { message, code }
let ocrProgress = null;   // 進捗 0-1（取得できない場合は null）
let imageToken = '';      // 画像破棄・撮り直し時に古い結果を無視するためのトークン
let ocrRetryCount = 0;    // 再試行回数カウンタ

// アプリの初期化
document.addEventListener('DOMContentLoaded', () => {
    init();
});

/**
 * アプリ初期化関数
 * 目的: DOMの準備完了後にアプリを初期化する（1回のみ実行）
 */
function init() {
    console.log('App initialized');
    
    // localStorage から保存済みデータを読み込み
    records = loadRecords();
    console.log(`保存済みレコード数: ${records.length}`);
    
    // 1年より前のデータを自動削除
    const cleanupResult = cleanupOldRecords(records);
    if (cleanupResult.deletedCount > 0) {
        console.log(`1年より前のデータを削除しました: ${cleanupResult.deletedCount}件`);
        records = cleanupResult.filteredRecords;
        saveRecords(records);
    }
    
    // DOM要素の取得
    const form = document.getElementById('recordForm');
    const btnSubmit = document.getElementById('btnSubmit');
    const btnClear = document.getElementById('btnClear');
    const measuredAtInput = document.getElementById('measuredAt');
    const memberInput = document.getElementById('member');
    const filterSelect = document.getElementById('filterMember');
    const recordListContainer = document.getElementById('recordListContainer');
    
    if (!form || !btnSubmit || !btnClear || !measuredAtInput) {
        console.error('必要なDOM要素が見つかりません');
        return;
    }
    
    // 測定日時の初期化（空の場合のみ）
    setDatetimeNow(measuredAtInput);
    
    // イベントリスナーの設定
    form.addEventListener('submit', handleSubmit);
    btnClear.addEventListener('click', () => handleClear(form, measuredAtInput, memberInput));
    
    // フィルタ変更時のイベント
    if (filterSelect) {
        filterSelect.addEventListener('change', refreshRecordList);
    }
    
    // 削除ボタンのイベント委譲
    if (recordListContainer) {
        recordListContainer.addEventListener('click', handleDelete);
    }
    
    // 再同期ボタンのイベント
    const btnResync = document.getElementById('btnResync');
    if (btnResync) {
        btnResync.addEventListener('click', handleResync);
    }
    
    // グラフフィルターのイベント
    const chartMemberFilter = document.getElementById('chartMemberFilter');
    if (chartMemberFilter) {
        chartMemberFilter.addEventListener('change', refreshChart);
    }
    
    // グラフ期間選択のイベント
    const chartStartDate = document.getElementById('chartStartDate');
    const chartEndDate = document.getElementById('chartEndDate');
    if (chartStartDate && chartEndDate) {
        chartStartDate.addEventListener('change', refreshChart);
        chartEndDate.addEventListener('change', refreshChart);
    }
    
    // グラフ期間の初期化（過去7日分をデフォルトとして設定）
    initChartDateRange();
    
    // オフライン検知の初期化
    initOfflineDetection();
    
    // カメラ機能の初期化 (Phase 2 Step 2-1)
    initCamera();
    
    // Phase 2 Step 2-4: 画像プレビュー機能の初期化
    initImagePreview();
    
    // Phase 3 Step 3-4: OCR確認UIの初期化
    initOcrAutoRun();
    
    // 初期表示
    refreshRecordList();
    updateUnsyncedUI();
    refreshChart();
}

/* =========================================
   localStorage アクセサ（安全な get/set）
   ========================================= */

/**
 * localStorage が使用可能かどうかを判定
 * @returns {boolean} 使用可能ならtrue
 */
function isStorageAvailable() {
    try {
        const testKey = '__storage_test__';
        localStorage.setItem(testKey, 'test');
        localStorage.removeItem(testKey);
        return true;
    } catch (e) {
        console.warn('localStorage が使用できません:', e);
        return false;
    }
}

/**
 * localStorage からレコード配列を読み込み
 * @returns {Array} BpRecord[]（空配列または保存済みレコード）
 */
function loadRecords() {
    if (!isStorageAvailable()) {
        console.warn('localStorage 不可：メモリ内のみで動作します');
        return [];
    }
    
    try {
        const json = localStorage.getItem(STORAGE_KEY);
        if (!json) {
            return [];
        }
        
        const data = JSON.parse(json);
        if (!Array.isArray(data)) {
            console.warn('保存データが配列ではありません。初期化します。');
            return [];
        }
        
        // 既存データの互換性対応：synced フラグがない場合は補完
        return data.map(record => {
            if (typeof record.synced === 'undefined') {
                record.synced = false; // デフォルトは未同期扱い
            }
            return record;
        });
    } catch (e) {
        console.error('localStorage 読み込みエラー（JSONパース失敗）:', e);
        
        // 破損したデータを退避（デバッグ用）
        try {
            const corruptKey = `${STORAGE_KEY}__corrupt__${Date.now()}`;
            const corruptData = localStorage.getItem(STORAGE_KEY);
            if (corruptData) {
                localStorage.setItem(corruptKey, corruptData);
                console.log(`破損データを ${corruptKey} に退避しました`);
            }
        } catch (backupError) {
            console.error('破損データの退避に失敗:', backupError);
        }
        
        return [];
    }
}

/**
 * レコード配列を localStorage に保存
 * @param {Array} records - BpRecord[]
 * @returns {boolean} 保存成功ならtrue
 */
function saveRecords(records) {
    if (!isStorageAvailable()) {
        showMessage('error', 'ストレージが使用できないため、保存できません。ブラウザの設定を確認してください。');
        return false;
    }
    
    try {
        const json = JSON.stringify(records);
        localStorage.setItem(STORAGE_KEY, json);
        return true;
    } catch (e) {
        console.error('localStorage 保存エラー:', e);
        
        if (e.name === 'QuotaExceededError') {
            showMessage('error', '保存容量が不足しています。古いデータを削除してください。');
        } else {
            showMessage('error', 'データの保存に失敗しました。');
        }
        
        return false;
    }
}

/**
 * 1年より前のデータを削除
 * @param {Array} records - BpRecord[]
 * @returns {Object} { filteredRecords: Array, deletedCount: number }
 */
function cleanupOldRecords(records) {
    // 1年前の日時を計算（現在時刻から365日前）
    const oneYearAgo = new Date();
    oneYearAgo.setDate(oneYearAgo.getDate() - MAX_DATA_RETENTION_DAYS);
    const oneYearAgoTime = oneYearAgo.getTime();
    
    // 1年以内のデータのみを残す
    const filteredRecords = records.filter(record => {
        if (!record.measuredAt) return true; // measuredAtがない場合は保持
        return record.measuredAt >= oneYearAgoTime;
    });
    
    const deletedCount = records.length - filteredRecords.length;
    
    return {
        filteredRecords,
        deletedCount
    };
}

/* =========================================
   バリデーション
   ========================================= */

/**
 * フォーム入力値を検証
 * @param {Object} values - { member, systolic, diastolic, pulse, datetimeLocal }
 * @returns {Object} { ok: boolean, errors: string[] }
 */
function validateForm(values) {
    const errors = [];
    
    // 必須チェック
    if (!values.member) {
        errors.push('記録者を選択してください');
    }
    if (!values.systolic) {
        errors.push('最高血圧を入力してください');
    }
    if (!values.diastolic) {
        errors.push('最低血圧を入力してください');
    }
    if (!values.pulse) {
        errors.push('脈拍を入力してください');
    }
    if (!values.datetimeLocal) {
        errors.push('測定日時を入力してください');
    }
    
    // 数値変換と型チェック
    const systolic = Number(values.systolic);
    const diastolic = Number(values.diastolic);
    const pulse = Number(values.pulse);
    
    if (!Number.isFinite(systolic)) {
        errors.push('最高血圧は数値で入力してください');
    }
    if (!Number.isFinite(diastolic)) {
        errors.push('最低血圧は数値で入力してください');
    }
    if (!Number.isFinite(pulse)) {
        errors.push('脈拍は数値で入力してください');
    }
    
    // 早期リターン（型チェックでエラーがある場合、範囲チェックは無意味）
    if (errors.length > 0) {
        return { ok: false, errors };
    }
    
    // 範囲チェック
    if (systolic < VALIDATION.systolic.min || systolic > VALIDATION.systolic.max) {
        errors.push(`最高血圧は ${VALIDATION.systolic.min}〜${VALIDATION.systolic.max} の範囲で入力してください`);
    }
    if (diastolic < VALIDATION.diastolic.min || diastolic > VALIDATION.diastolic.max) {
        errors.push(`最低血圧は ${VALIDATION.diastolic.min}〜${VALIDATION.diastolic.max} の範囲で入力してください`);
    }
    if (pulse < VALIDATION.pulse.min || pulse > VALIDATION.pulse.max) {
        errors.push(`脈拍は ${VALIDATION.pulse.min}〜${VALIDATION.pulse.max} の範囲で入力してください`);
    }
    
    // 整合性チェック
    if (systolic <= diastolic) {
        errors.push('最高血圧は最低血圧より大きい値を入力してください');
    }
    
    return {
        ok: errors.length === 0,
        errors
    };
}

/* =========================================
   レコード生成
   ========================================= */

/**
 * 入力値から保存用レコードを生成
 * @param {Object} values - { member, systolic, diastolic, pulse, datetimeLocal }
 * @returns {Object} BpRecord
 */
function buildRecord(values) {
    // datetimeLocal（YYYY-MM-DDTHH:mm）をローカル時刻として解釈
    const measuredAt = new Date(values.datetimeLocal).getTime();
    
    return {
        id: String(Date.now()),
        schemaVersion: SCHEMA_VERSION,
        member: values.member,
        systolic: Number(values.systolic),
        diastolic: Number(values.diastolic),
        pulse: Number(values.pulse),
        datetimeLocal: values.datetimeLocal,
        measuredAt: measuredAt,
        datetimeIso: new Date(measuredAt).toISOString(),
        synced: false,         // 初期は未同期
        syncedAt: null         // 同期成功時のタイムスタンプ
    };
}

/* =========================================
   UI更新（メッセージ表示）
   ========================================= */

/**
 * メッセージを表示
 * @param {string} type - 'success' | 'error' | 'warn'
 * @param {string} text - 表示するメッセージ
 */
function showMessage(type, text) {
    const messageEl = document.getElementById('message');
    if (!messageEl) {
        // フォールバック: メッセージ領域がない場合は alert
        alert(text);
        return;
    }
    
    // 既存のクラスをクリア
    messageEl.className = 'message';
    
    // 新しいクラスを追加
    messageEl.classList.add(`message--${type}`);
    messageEl.textContent = text;
    
    // アクセシビリティ: スクリーンリーダー用
    messageEl.setAttribute('role', 'status');
    messageEl.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
}

/**
 * メッセージをクリア
 */
function clearMessage() {
    const messageEl = document.getElementById('message');
    if (messageEl) {
        messageEl.className = 'message';
        messageEl.textContent = '';
    }
}

/* =========================================
   ユーティリティ
   ========================================= */

/**
 * datetime-local 入力欄に現在日時をセット
 * @param {HTMLInputElement} input - datetime-local入力要素
 */
function setDatetimeNow(input) {
    if (!input.value) {
        input.value = formatToDatetimeLocal(new Date());
    }
}

/**
 * Date オブジェクトを datetime-local 形式（YYYY-MM-DDTHH:MM）に整形
 * @param {Date} date - 変換する日時
 * @returns {string} datetime-local形式の文字列
 */
function formatToDatetimeLocal(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    
    return `${year}-${month}-${day}T${hours}:${minutes}`;
}

/* =========================================
   一覧表示用ユーティリティ
   ========================================= */

/**
 * ISO日時文字列を表示用にフォーマット（YYYY/MM/DD HH:MM）
 * @param {string} datetimeIso - ISO 8601形式の日時文字列
 * @returns {string} フォーマット済み日時文字列
 */
function formatDateTime(datetimeIso) {
    if (!datetimeIso) return '-';
    
    try {
        const date = new Date(datetimeIso);
        if (isNaN(date.getTime())) return '-';
        
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        
        return `${year}/${month}/${day} ${hours}:${minutes}`;
    } catch (e) {
        console.error('日時フォーマットエラー:', e);
        return '-';
    }
}

/**
 * 血圧値を表示用にフォーマット（XXX / YYY mmHg）
 * @param {number} systolic - 最高血圧
 * @param {number} diastolic - 最低血圧
 * @returns {string} フォーマット済み血圧文字列
 */
function formatBP(systolic, diastolic) {
    return `${systolic} / ${diastolic}`;
}

/**
 * 脈拍を表示用にフォーマット（XXX bpm）
 * @param {number} pulse - 脈拍
 * @returns {string} フォーマット済み脈拍文字列
 */
function formatPulse(pulse) {
    return `${pulse}`;
}

/**
 * レコード配列を日時降順（最新が上）にソート（破壊しない）
 * @param {Array} records - BpRecord[]
 * @returns {Array} ソート済みレコード配列
 */
function sortRecordsDescByDatetime(records) {
    return [...records].sort((a, b) => {
        const timeA = a.measuredAt || 0;
        const timeB = b.measuredAt || 0;
        return timeB - timeA; // 降順
    });
}

/**
 * レコード配列を指定件数に制限（破壊しない）
 * @param {Array} records - BpRecord[]
 * @param {number} maxCount - 最大件数
 * @returns {Array} 制限後のレコード配列
 */
function limitRecords(records, maxCount) {
    return records.slice(0, maxCount);
}

/**
 * メンバーでレコードをフィルタ（破壊しない）
 * @param {Array} records - BpRecord[]
 * @param {string|null} member - フィルタするメンバー（nullまたは空文字列なら全件）
 * @returns {Array} フィルタ済みレコード配列
 */
function filterRecordsByMember(records, member) {
    if (!member) return records;
    return records.filter(r => r.member === member);
}

/* =========================================
   一覧描画
   ========================================= */

/**
 * レコード配列を一覧表示（カード形式）
 * @param {Array} records - 表示するBpRecord配列
 */
function renderRecords(records) {
    const listContainer = document.getElementById('recordList');
    const emptyContainer = document.getElementById('recordListEmpty');
    const countDisplay = document.getElementById('recordCount');
    
    if (!listContainer || !emptyContainer || !countDisplay) {
        console.error('一覧表示用のDOM要素が見つかりません');
        return;
    }
    
    // 件数表示を更新
    countDisplay.textContent = `表示: ${records.length}件`;
    
    // 0件の場合は空状態を表示
    if (records.length === 0) {
        listContainer.style.display = 'none';
        emptyContainer.style.display = 'block';
        listContainer.innerHTML = '';
        return;
    }
    
    // 一覧を表示
    emptyContainer.style.display = 'none';
    listContainer.style.display = 'block';
    
    // カードを生成
    const fragment = document.createDocumentFragment();
    
    records.forEach(record => {
        const card = document.createElement('div');
        card.className = 'record-card';
        card.dataset.id = record.id;
        
        // ヘッダー（日時・メンバー）
        const header = document.createElement('div');
        header.className = 'record-card__header';
        
        const datetime = document.createElement('div');
        datetime.className = 'record-card__datetime';
        datetime.textContent = formatDateTime(record.datetimeIso);
        
        const member = document.createElement('div');
        member.className = 'record-card__member';
        member.textContent = record.member;
        
        header.appendChild(datetime);
        header.appendChild(member);
        
        // 未同期バッジ（任意）
        if (!record.synced) {
            const unsyncedBadge = document.createElement('span');
            unsyncedBadge.className = 'record-card__badge record-card__badge--unsynced';
            unsyncedBadge.textContent = '未同期';
            unsyncedBadge.setAttribute('aria-label', 'クラウド未同期');
            header.appendChild(unsyncedBadge);
        }
        
        // ボディ（血圧・脈拍）
        const body = document.createElement('div');
        body.className = 'record-card__body';
        
        // 最高血圧
        const systolicItem = document.createElement('div');
        systolicItem.className = 'record-card__item';
        systolicItem.innerHTML = `
            <span class="record-card__label">最高血圧</span>
            <span class="record-card__value">${record.systolic} <small>mmHg</small></span>
        `;
        
        // 最低血圧
        const diastolicItem = document.createElement('div');
        diastolicItem.className = 'record-card__item';
        diastolicItem.innerHTML = `
            <span class="record-card__label">最低血圧</span>
            <span class="record-card__value">${record.diastolic} <small>mmHg</small></span>
        `;
        
        // 脈拍
        const pulseItem = document.createElement('div');
        pulseItem.className = 'record-card__item';
        pulseItem.innerHTML = `
            <span class="record-card__label">脈拍</span>
            <span class="record-card__value">${record.pulse} <small>bpm</small></span>
        `;
        
        body.appendChild(systolicItem);
        body.appendChild(diastolicItem);
        body.appendChild(pulseItem);
        
        // フッター（削除ボタン）
        const footer = document.createElement('div');
        footer.className = 'record-card__footer';
        
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'btn btn--danger';
        deleteBtn.dataset.id = record.id;
        deleteBtn.setAttribute('aria-label', `${formatDateTime(record.datetimeIso)}の記録を削除`);
        deleteBtn.textContent = '削除';
        
        footer.appendChild(deleteBtn);
        
        // カード組み立て
        card.appendChild(header);
        card.appendChild(body);
        card.appendChild(footer);
        
        fragment.appendChild(card);
    });
    
    // DOMに反映
    listContainer.innerHTML = '';
    listContainer.appendChild(fragment);
}

/**
 * 一覧を再描画（load→filter→sort→limit→render）
 */
function refreshRecordList() {
    // localStorage から読み込み
    let allRecords = loadRecords();
    
    // フィルタ（メンバー選択）
    const filterSelect = document.getElementById('filterMember');
    const memberFilter = filterSelect ? filterSelect.value : '';
    
    let filtered = filterRecordsByMember(allRecords, memberFilter);
    
    // ソート（日時降順）
    let sorted = sortRecordsDescByDatetime(filtered);
    
    // 件数制限
    let limited = limitRecords(sorted, MAX_LIST_COUNT);
    
    // 描画
    renderRecords(limited);
    
    // 未同期UI更新
    updateUnsyncedUI();
}

/* =========================================
   同期関連の処理
   ========================================= */

/**
 * レコードを Sheets に同期（非同期）
 * @param {Object} record - 同期するレコード
 * @returns {Promise<boolean>} 成功ならtrue
 */
async function syncRecordToSheets(record) {
    // sheets-api.js が読み込まれているか確認
    if (typeof saveToSheets !== 'function') {
        console.error('saveToSheets が定義されていません。sheets-api.js を確認してください。');
        return false;
    }
    
    try {
        const result = await saveToSheets(record);
        
        if (result.ok) {
            console.log('[sync] 同期成功:', record.id);
            
            // レコードの同期状態を更新
            record.synced = true;
            record.syncedAt = new Date().toISOString();
            
            // localStorage に保存
            const allRecords = loadRecords();
            const index = allRecords.findIndex(r => r.id === record.id);
            if (index !== -1) {
                allRecords[index] = record;
                saveRecords(allRecords);
            }
            
            return true;
        } else {
            console.error('[sync] 同期失敗:', result.error);
            return false;
        }
    } catch (error) {
        console.error('[sync] 同期エラー:', error);
        return false;
    }
}

/**
 * 未同期レコード数をカウント
 * @returns {number} 未同期レコード数
 */
function countUnsyncedRecords() {
    const allRecords = loadRecords();
    return allRecords.filter(r => !r.synced).length;
}

/**
 * 未同期UIを更新（再同期ボタンの表示/非表示と件数表示）
 */
function updateUnsyncedUI() {
    const btnResync = document.getElementById('btnResync');
    const unsyncedCount = document.getElementById('unsyncedCount');
    
    if (!btnResync) return;
    
    const count = countUnsyncedRecords();
    
    if (count > 0) {
        btnResync.style.display = 'inline-block';
        if (unsyncedCount) {
            unsyncedCount.textContent = `(${count}件)`;
        }
    } else {
        btnResync.style.display = 'none';
    }
}

/**
 * 未同期レコードを再送信（手動リトライ）
 */
async function handleResync() {
    if (isResyncInProgress) {
        console.log('[resync] 既に再同期処理が実行中です');
        return;
    }
    
    const btnResync = document.getElementById('btnResync');
    const originalText = btnResync ? btnResync.textContent : '';
    
    try {
        isResyncInProgress = true;
        
        // ボタンを無効化
        if (btnResync) {
            btnResync.disabled = true;
            btnResync.textContent = '同期中...';
        }
        
        // 未同期レコードを取得
        const allRecords = loadRecords();
        const unsyncedRecords = allRecords.filter(r => !r.synced);
        
        console.log(`[resync] 未同期レコード: ${unsyncedRecords.length}件`);
        
        if (unsyncedRecords.length === 0) {
            showMessage('success', '未同期のレコードはありません');
            return;
        }
        
        // 1件ずつ送信（間隔を空ける）
        let successCount = 0;
        let failCount = 0;
        
        for (let i = 0; i < unsyncedRecords.length; i++) {
            const record = unsyncedRecords[i];
            
            console.log(`[resync] ${i + 1}/${unsyncedRecords.length} 件目を送信中...`);
            
            const success = await syncRecordToSheets(record);
            
            if (success) {
                successCount++;
            } else {
                failCount++;
                // 失敗したら停止
                console.error(`[resync] ${i + 1}件目で失敗したため、再同期を中断します`);
                break;
            }
            
            // 次のレコードまで間隔を空ける（最後は不要）
            if (i < unsyncedRecords.length - 1) {
                await sleep(SYNC_RETRY_INTERVAL_MS);
            }
        }
        
        // 結果を表示
        if (failCount === 0) {
            showMessage('success', `${successCount}件の記録を同期しました`);
        } else {
            showMessage('warn', `${successCount}件成功、${failCount}件失敗しました。ネットワーク状態を確認してください。`);
        }
        
        // UI更新
        refreshRecordList();
        
    } catch (error) {
        console.error('[resync] 再同期エラー:', error);
        showMessage('error', '再同期中にエラーが発生しました');
    } finally {
        isResyncInProgress = false;
        
        // ボタンを元に戻す
        if (btnResync) {
            btnResync.disabled = false;
            btnResync.textContent = originalText;
        }
        
        updateUnsyncedUI();
    }
}

/**
 * 指定ミリ秒待機
 * @param {number} ms - 待機時間（ミリ秒）
 * @returns {Promise<void>}
 */
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/* =========================================
   イベントハンドラ
   ========================================= */

/**
 * フォーム送信処理（バリデーション → ローカル保存 → Sheets同期）
 * @param {Event} event - submit イベント
 */
async function handleSubmit(event) {
    event.preventDefault();
    
    // メッセージをクリア
    clearMessage();
    
    // 送信ボタンを一時的に無効化（二重送信防止）
    const btnSubmit = document.getElementById('btnSubmit');
    const originalDisabled = btnSubmit.disabled;
    btnSubmit.disabled = true;
    
    try {
        // フォームから値を取得
        const form = event.target;
        const values = {
            member: form.member.value.trim(),
            systolic: form.systolic.value.trim(),
            diastolic: form.diastolic.value.trim(),
            pulse: form.pulse.value.trim(),
            datetimeLocal: form.measuredAt.value.trim()
        };
        
        // バリデーション
        const validation = validateForm(values);
        if (!validation.ok) {
            // エラーメッセージを表示
            showMessage('error', validation.errors.join('\n'));
            
            // 最初のエラー項目にフォーカス
            const firstErrorField = getFirstErrorField(form, validation.errors);
            if (firstErrorField) {
                firstErrorField.focus();
            }
            
            return;
        }
        
        // レコード生成
        const record = buildRecord(values);
        
        // ========================================
        // ステップ1: ローカル保存（最優先・必須）
        // ========================================
        records.push(record);
        const saved = saveRecords(records);
        
        if (!saved) {
            // ローカル保存失敗は致命的エラー
            return;
        }
        
        // ローカル保存成功を通知
        showMessage('success', 'ローカルに保存しました');
        console.log('ローカル保存成功:', record);
        
        // 一覧とグラフを更新
        refreshRecordList();
        refreshChart();
        
        // ========================================
        // ステップ2: Sheets 同期（オンライン時のみ・失敗しても継続）
        // ========================================
        const syncSuccess = await syncRecordToSheets(record);
        
        if (syncSuccess) {
            showMessage('success', 'ローカルに保存し、クラウドに同期しました');
            // 一覧を再更新（同期状態の反映）
            refreshRecordList();
            // グラフは既に更新済み
        } else {
            showMessage('warn', 'ローカルに保存しました（クラウド同期は失敗しました。後で「未同期を再送」ボタンから再試行できます）');
        }
        
        // Phase 2 Step 2-4: 記録保存成功後に画像をクリア
        clearImageAfterSave();
        
    } catch (error) {
        console.error('保存処理エラー:', error);
        showMessage('error', '予期しないエラーが発生しました');
    } finally {
        // ボタンを元に戻す
        btnSubmit.disabled = originalDisabled;
    }
}

/**
 * バリデーションエラーから最初のエラーフィールドを取得
 * @param {HTMLFormElement} form - フォーム要素
 * @param {string[]} errors - エラーメッセージ配列
 * @returns {HTMLElement|null} 最初のエラーフィールド
 */
function getFirstErrorField(form, errors) {
    const errorKeywords = {
        '記録者': form.member,
        '最高血圧': form.systolic,
        '最低血圧': form.diastolic,
        '脈拍': form.pulse,
        '測定日時': form.measuredAt
    };
    
    for (const error of errors) {
        for (const [keyword, field] of Object.entries(errorKeywords)) {
            if (error.includes(keyword)) {
                return field;
            }
        }
    }
    
    return null;
}

/**
 * クリアボタン処理（フォームリセット＋日時再セット＋メッセージクリア＋フォーカス戻し＋画像クリア）
 * @param {HTMLFormElement} form - フォーム要素
 * @param {HTMLInputElement} measuredAtInput - 測定日時入力要素
 * @param {HTMLInputElement} memberInput - メンバー入力要素
 */
function handleClear(form, measuredAtInput, memberInput) {
    // メッセージをクリア
    clearMessage();
    
    // フォームをリセット
    form.reset();
    
    // 測定日時を現在日時に再セット
    measuredAtInput.value = formatToDatetimeLocal(new Date());
    
    // Phase 2 Step 2-4: 画像もクリア
    if (currentSelectedImage) {
        handleRemoveImage();
    }
    
    // 先頭フィールド（メンバー）にフォーカスを戻す
    if (memberInput) {
        memberInput.focus();
    }
    
    console.log('フォームをクリアしました');
}

/**
 * 削除ボタンクリック処理（イベント委譲）
 * @param {Event} event - クリックイベント
 */
function handleDelete(event) {
    // 削除ボタンがクリックされたか確認
    const deleteBtn = event.target.closest('.btn--danger');
    if (!deleteBtn) return;
    
    const recordId = deleteBtn.dataset.id;
    if (!recordId) {
        console.error('削除対象のIDが見つかりません');
        return;
    }
    
    // 確認ダイアログ
    const confirmed = confirm('この記録を削除しますか？');
    if (!confirmed) return;
    
    try {
        // レコードを削除
        records = loadRecords();
        const filteredRecords = records.filter(r => r.id !== recordId);
        
        // 削除されたか確認
        if (filteredRecords.length === records.length) {
            showMessage('warn', '削除対象の記録が見つかりませんでした');
            return;
        }
        
        // 保存
        const saved = saveRecords(filteredRecords);
        
        if (saved) {
            records = filteredRecords;
            showMessage('success', '記録を削除しました');
            console.log(`記録を削除しました (ID: ${recordId})`);
            
            // 一覧とグラフを更新
            refreshRecordList();
            refreshChart();
        }
        
    } catch (error) {
        console.error('削除処理エラー:', error);
        showMessage('error', '削除に失敗しました');
    }
}

/* =========================================
   Chart.js グラフ表示（期間選択可能な血圧推移）
   ========================================= */

/**
 * グラフ期間の初期化（過去7日分をデフォルトとして設定）
 */
function initChartDateRange() {
    const chartStartDate = document.getElementById('chartStartDate');
    const chartEndDate = document.getElementById('chartEndDate');
    
    if (!chartStartDate || !chartEndDate) return;
    
    // 今日の日付
    const today = new Date();
    const todayStr = formatToDateOnly(today);
    
    // 7日前の日付
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - (CHART_DAYS - 1));
    const startDateStr = formatToDateOnly(startDate);
    
    // 初期値を設定（空の場合のみ）
    if (!chartStartDate.value) {
        chartStartDate.value = startDateStr;
    }
    if (!chartEndDate.value) {
        chartEndDate.value = todayStr;
    }
}

/**
 * Date オブジェクトを YYYY-MM-DD 形式に整形
 * @param {Date} date - 変換する日付
 * @returns {string} YYYY-MM-DD形式の文字列
 */
function formatToDateOnly(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * 指定期間のレコードを抽出
 * @param {Array} records - 全レコード配列
 * @param {string} startDateStr - 開始日（YYYY-MM-DD）
 * @param {string} endDateStr - 終了日（YYYY-MM-DD）
 * @returns {Array} 期間内のレコード
 */
function extractRecordsByDateRange(records, startDateStr, endDateStr) {
    // 日付文字列をDateオブジェクトに変換（開始日は0:00、終了日は23:59:59）
    const startDate = new Date(startDateStr);
    startDate.setHours(0, 0, 0, 0);
    
    const endDate = new Date(endDateStr);
    endDate.setHours(23, 59, 59, 999);
    
    return records.filter(record => {
        if (!record.datetimeIso) return false;
        const recordDate = new Date(record.datetimeIso);
        return recordDate >= startDate && recordDate <= endDate;
    });
}

/**
 * 日付キー（YYYY-MM-DD）を生成（ローカルタイム）
 * @param {Date} date - 日付オブジェクト
 * @returns {string} 日付キー
 */
function getDateKey(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

/**
 * 日付キーを表示用ラベル（MM/DD）に変換
 * @param {string} dateKey - YYYY-MM-DD形式の日付キー
 * @returns {string} MM/DD形式のラベル
 */
function formatDateLabel(dateKey) {
    const [year, month, day] = dateKey.split('-');
    return `${month}/${day}`;
}

/**
 * レコードを日付ごとにグループ化し、平均値を計算
 * @param {Array} records - レコード配列
 * @returns {Object} { dateKey: { systolic, diastolic, pulse, count, timestamp } }
 */
function groupAndAverageByDate(records) {
    const grouped = {};
    
    records.forEach(record => {
        const date = new Date(record.datetimeIso);
        const dateKey = getDateKey(date);
        
        if (!grouped[dateKey]) {
            grouped[dateKey] = {
                systolic: 0,
                diastolic: 0,
                pulse: 0,
                count: 0,
                timestamp: date.getTime()
            };
        }
        
        grouped[dateKey].systolic += record.systolic;
        grouped[dateKey].diastolic += record.diastolic;
        grouped[dateKey].pulse += record.pulse;
        grouped[dateKey].count += 1;
    });
    
    // 平均値を計算（四捨五入）
    Object.keys(grouped).forEach(dateKey => {
        const group = grouped[dateKey];
        group.systolic = Math.round(group.systolic / group.count);
        group.diastolic = Math.round(group.diastolic / group.count);
        group.pulse = Math.round(group.pulse / group.count);
    });
    
    return grouped;
}

/**
 * Chart.js用のデータ構造に変換（昇順ソート）
 * @param {Object} groupedData - 日付グループ化データ
 * @returns {Object} { labels: [], systolic: [], diastolic: [], pulse: [] }
 */
function buildChartData(groupedData) {
    // 日付の昇順にソート（古い→新しい）
    const sortedEntries = Object.entries(groupedData).sort((a, b) => {
        return a[1].timestamp - b[1].timestamp;
    });
    
    const labels = [];
    const systolic = [];
    const diastolic = [];
    const pulse = [];
    
    sortedEntries.forEach(([dateKey, data]) => {
        labels.push(formatDateLabel(dateKey));
        systolic.push(data.systolic);
        diastolic.push(data.diastolic);
        pulse.push(data.pulse);
    });
    
    return { labels, systolic, diastolic, pulse };
}

/**
 * Chart.jsでグラフを描画または更新
 * @param {Object} chartData - { labels, systolic, diastolic, pulse }
 */
function renderOrUpdateChart(chartData) {
    const canvas = document.getElementById('bpChart');
    if (!canvas) {
        console.error('Canvas要素が見つかりません');
        return;
    }
    
    // 既存のチャートを破棄
    if (bpChartInstance) {
        bpChartInstance.destroy();
        bpChartInstance = null;
    }
    
    const ctx = canvas.getContext('2d');
    
    bpChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: chartData.labels,
            datasets: [
                {
                    label: '最高血圧 (mmHg)',
                    data: chartData.systolic,
                    borderColor: 'rgb(220, 53, 69)',
                    backgroundColor: 'rgba(220, 53, 69, 0.1)',
                    tension: 0.1,
                    yAxisID: 'y'
                },
                {
                    label: '最低血圧 (mmHg)',
                    data: chartData.diastolic,
                    borderColor: 'rgb(13, 110, 253)',
                    backgroundColor: 'rgba(13, 110, 253, 0.1)',
                    tension: 0.1,
                    yAxisID: 'y'
                },
                {
                    label: '脈拍 (bpm)',
                    data: chartData.pulse,
                    borderColor: 'rgb(25, 135, 84)',
                    backgroundColor: 'rgba(25, 135, 84, 0.1)',
                    tension: 0.1,
                    yAxisID: 'y1'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false
            },
            plugins: {
                legend: {
                    display: true,
                    position: 'top',
                    labels: {
                        usePointStyle: true,
                        padding: 15,
                        font: {
                            size: 12
                        }
                    }
                },
                tooltip: {
                    enabled: true,
                    backgroundColor: 'rgba(0, 0, 0, 0.8)',
                    padding: 12,
                    titleFont: {
                        size: 13
                    },
                    bodyFont: {
                        size: 12
                    }
                }
            },
            scales: {
                x: {
                    display: true,
                    title: {
                        display: true,
                        text: '日付',
                        font: {
                            size: 12
                        }
                    },
                    grid: {
                        display: false
                    }
                },
                y: {
                    type: 'linear',
                    display: true,
                    position: 'left',
                    title: {
                        display: true,
                        text: '血圧 (mmHg)',
                        font: {
                            size: 12
                        }
                    },
                    grid: {
                        color: 'rgba(0, 0, 0, 0.1)'
                    }
                },
                y1: {
                    type: 'linear',
                    display: true,
                    position: 'right',
                    title: {
                        display: true,
                        text: '脈拍 (bpm)',
                        font: {
                            size: 12
                        }
                    },
                    grid: {
                        drawOnChartArea: false
                    }
                }
            }
        }
    });
}

/**
 * グラフUIの状態を更新（データあり/なし）
 * @param {boolean} hasData - データがあるかどうか
 */
function updateChartUIState(hasData) {
    const chartContainer = document.getElementById('chartContainer');
    const emptyMessage = document.getElementById('emptyChartMessage');
    
    if (!chartContainer || !emptyMessage) {
        console.error('グラフUI要素が見つかりません');
        return;
    }
    
    if (hasData) {
        chartContainer.style.display = 'block';
        emptyMessage.style.display = 'none';
    } else {
        chartContainer.style.display = 'none';
        emptyMessage.style.display = 'block';
        
        // データがない場合は既存チャートを破棄
        if (bpChartInstance) {
            bpChartInstance.destroy();
            bpChartInstance = null;
        }
    }
}

/**
 * グラフを再描画（データ取得→加工→描画の一連の流れ）
 */
function refreshChart() {
    // localStorage から記録を読み込み
    let allRecords = loadRecords();
    
    // グラフ用フィルター（全員/個別）
    const chartMemberFilter = document.getElementById('chartMemberFilter');
    const memberFilter = chartMemberFilter ? chartMemberFilter.value : 'all';
    
    // メンバーでフィルター
    let filtered = allRecords;
    if (memberFilter && memberFilter !== 'all') {
        filtered = allRecords.filter(r => r.member === memberFilter);
    }
    
    // 期間選択の値を取得
    const chartStartDate = document.getElementById('chartStartDate');
    const chartEndDate = document.getElementById('chartEndDate');
    
    let dateRangeRecords = filtered;
    
    // 開始日と終了日が両方とも入力されている場合のみ期間フィルターを適用
    if (chartStartDate && chartEndDate && chartStartDate.value && chartEndDate.value) {
        const startDateStr = chartStartDate.value;
        const endDateStr = chartEndDate.value;
        
        // 開始日が終了日より後の場合はエラーメッセージを表示
        if (startDateStr > endDateStr) {
            updateChartUIState(false);
            const emptyMessage = document.getElementById('emptyChartMessage');
            if (emptyMessage) {
                emptyMessage.innerHTML = '<p>開始日は終了日より前に設定してください</p>';
            }
            return;
        }
        
        dateRangeRecords = extractRecordsByDateRange(filtered, startDateStr, endDateStr);
    }
    
    // データがない場合は空表示
    if (dateRangeRecords.length === 0) {
        updateChartUIState(false);
        const emptyMessage = document.getElementById('emptyChartMessage');
        if (emptyMessage) {
            emptyMessage.innerHTML = '<p>選択された期間の記録がありません</p><p class="chart-empty__hint">記録が追加されると、ここにグラフが表示されます</p>';
        }
        return;
    }
    
    // 日付ごとにグループ化して平均化
    const grouped = groupAndAverageByDate(dateRangeRecords);
    
    // Chart.js用データに変換
    const chartData = buildChartData(grouped);
    
    // グラフを描画
    updateChartUIState(true);
    renderOrUpdateChart(chartData);
}

/* =========================================
   オフライン検知（PWA機能）
   ========================================= */

/**
 * オフライン検知の初期化
 * 目的: navigator.onLineとonline/offlineイベントでオフライン状態を通知する
 */
function initOfflineDetection() {
    const offlineBanner = document.getElementById('offlineBanner');
    
    if (!offlineBanner) {
        console.warn('[Offline] オフラインバナー要素が見つかりません');
        return;
    }
    
    // 初期状態を反映
    updateOfflineUI();
    
    // オンライン/オフラインイベントを監視
    window.addEventListener('online', updateOfflineUI);
    window.addEventListener('offline', updateOfflineUI);
    
    console.log('[Offline] オフライン検知を初期化しました');
}

/**
 * オフラインUIの状態を更新
 */
function updateOfflineUI() {
    const offlineBanner = document.getElementById('offlineBanner');
    
    if (!offlineBanner) return;
    
    if (navigator.onLine) {
        // オンライン時はバナーを非表示
        offlineBanner.classList.remove('offline-banner--visible');
        console.log('[Offline] オンライン状態');
    } else {
        // オフライン時はバナーを表示
        offlineBanner.classList.add('offline-banner--visible');
        console.log('[Offline] オフライン状態');
    }
}

/* =========================================
   カメラ機能 (Phase 2 Step 2-1)
   ========================================= */

/**
 * カメラ功の初期化
 */
function initCamera() {
    const btnOpenCamera = document.getElementById('btnOpenCamera');
    const btnCameraClose = document.getElementById('btnCameraClose');
    const btnCameraCapture = document.getElementById('btnCameraCapture');
    const cameraModal = document.getElementById('cameraModal');
    const cameraVideo = document.getElementById('cameraVideo');
    const cameraCanvas = document.getElementById('cameraCanvas');
    const cameraError = document.getElementById('cameraError');
    const cameraLoading = document.getElementById('cameraLoading');
    const loadingText = document.getElementById('loadingText');
    
    // Phase 2 Step 2-2: プレビュー関連要素
    const cameraPreviewContainer = document.getElementById('cameraPreviewContainer');
    const photoPreviewContainer = document.getElementById('photoPreviewContainer');
    const photoPreview = document.getElementById('photoPreview');
    const cameraActions = document.getElementById('cameraActions');
    const photoActions = document.getElementById('photoActions');
    const btnRetake = document.getElementById('btnRetake');
    const btnRotate = document.getElementById('btnRotate');
    const btnUsePhoto = document.getElementById('btnUsePhoto');
    
    if (!btnOpenCamera || !cameraModal || !cameraVideo || !cameraCanvas) {
        console.warn('[Camera] 必要なDOM要素が見つかりません');
        return;
    }
    
    // カメラモジュールの確認
    if (!window.CameraModule) {
        console.error('[Camera] CameraModule が読み込まれていません');
        return;
    }
    
    const { startCamera, stopCamera, capturePhoto, processCapturedPhoto, retakePhoto, rotatePhoto, usePhoto, clearSessionStorage } = window.CameraModule;
    
    // カメラで撮影ボタン
    btnOpenCamera.addEventListener('click', async () => {
        console.log('[Camera] カメラモーダルを開く');
        showCameraModal();
        await startCameraWithUI();
    });
    
    // 閉じるボタン
    btnCameraClose.addEventListener('click', () => {
        console.log('[Camera] カメラモーダルを閉じる');
        stopCameraWithUI();
        hideCameraModal();
    });
    
    // シャッターボタン
    btnCameraCapture.addEventListener('click', async () => {
        await capturePhotoWithUI();
    });
    
    // 再撮影ボタン (Phase 2 Step 2-2)
    if (btnRetake) {
        btnRetake.addEventListener('click', () => {
            console.log('[Camera] 再撮影');
            retakePhoto();
            switchToCameraViewMode();
        });
    }
    
    // 回転ボタン (Phase 2 Step 2-2)
    if (btnRotate) {
        btnRotate.addEventListener('click', async () => {
            console.log('[Camera] 画像を回転');
            btnRotate.disabled = true;
            const originalText = btnRotate.textContent;
            btnRotate.textContent = '🔄 回転中...';
            
            try {
                const result = await rotatePhoto({ previewImg: photoPreview });
                
                if (!result.ok) {
                    showError({ code: 'ROTATE_ERROR', message: result.error });
                }
            } finally {
                btnRotate.textContent = originalText;
                btnRotate.disabled = false;
            }
        });
    }
    
    // この画像を使うボタン (Phase 2 Step 2-2)
    if (btnUsePhoto) {
        btnUsePhoto.addEventListener('click', async () => {
            console.log('[Camera] 画像を採用');
            btnUsePhoto.disabled = true;
            const originalText = btnUsePhoto.textContent;
            btnUsePhoto.textContent = '✓ 保存中...';
            
            try {
                const result = await usePhoto();
                
                if (result.ok) {
                    console.log('[Camera] 画像をsessionStorageに保存成功');
                    
                    // カメラを閉じる
                    stopCameraWithUI();
                    hideCameraModal();
                    
                    // メッセージはapp.jsの画像選択イベントハンドラで表示される
                } else {
                    showError({ code: 'SAVE_ERROR', message: result.error });
                }
            } finally {
                btnUsePhoto.textContent = originalText;
                btnUsePhoto.disabled = false;
            }
        });
    }
    
    // モーダル背景クリックで閉じる
    cameraModal.addEventListener('click', (e) => {
        if (e.target === cameraModal) {
            console.log('[Camera] モーダル背景クリックで閉じる');
            stopCameraWithUI();
            hideCameraModal();
        }
    });
    
    // ページ非表示時にカメラを停止（掴みっぱなし防止）
    document.addEventListener('visibilitychange', () => {
        if (document.hidden && cameraModal.style.display !== 'none') {
            console.log('[Camera] ページ非表示のためカメラを停止');
            stopCameraWithUI();
        }
    });
    
    window.addEventListener('pagehide', () => {
        console.log('[Camera] pagehideイベントでカメラを停止');
        stopCameraWithUI();
    });
    
    // Escキーで閉じる
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && cameraModal.style.display !== 'none') {
            console.log('[Camera] Escキーでカメラを閉じる');
            stopCameraWithUI();
            hideCameraModal();
        }
    });
    
    console.log('[Camera] カメラ機能を初期化しました');
    
    /**
     * カメラモーダルを表示
     */
    function showCameraModal() {
        cameraModal.style.display = 'flex';
        cameraError.style.display = 'none';
        cameraError.textContent = '';
        switchToCameraViewMode(); // 初期はカメラプレビュー
        btnCameraClose.focus(); // 初期フォーカスを閉じるボタンへ
    }
    
    /**
     * カメラモーダルを非表示
     */
    function hideCameraModal() {
        cameraModal.style.display = 'none';
        cameraLoading.style.display = 'none';
        cameraError.style.display = 'none';
        btnOpenCamera.focus(); // フォーカスを戻す
    }
    
    /**
     * カメラプレビュー表示モードに切り替え
     */
    function switchToCameraViewMode() {
        if (cameraPreviewContainer) cameraPreviewContainer.style.display = 'flex';
        if (photoPreviewContainer) photoPreviewContainer.style.display = 'none';
        if (cameraActions) cameraActions.style.display = 'flex';
        if (photoActions) photoActions.style.display = 'none';
    }
    
    /**
     * 写真プレビュー表示モードに切り替え
     */
    function switchToPhotoViewMode() {
        if (cameraPreviewContainer) cameraPreviewContainer.style.display = 'none';
        if (photoPreviewContainer) photoPreviewContainer.style.display = 'flex';
        if (cameraActions) cameraActions.style.display = 'none';
        if (photoActions) photoActions.style.display = 'flex';
    }
    
    /**
     * カメラを起動してUIを更新
     */
    async function startCameraWithUI() {
        // ローディング表示
        cameraLoading.style.display = 'flex';
        if (loadingText) loadingText.textContent = 'カメラを起動中...';
        cameraError.style.display = 'none';
        btnCameraCapture.disabled = true;
        
        try {
            const result = await startCamera({ videoEl: cameraVideo });
            
            if (result.ok) {
                console.log('[Camera] カメラ起動成功');
                cameraLoading.style.display = 'none';
                
                // videoがreadyになるまで待つ
                await waitForVideoReady(cameraVideo);
                
                btnCameraCapture.disabled = false;
                
                // Phase 2 Step 2-3: ガイドオーバーレイを表示
                initGuide();
            } else {
                console.error('[Camera] カメラ起動失敗', result.error);
                cameraLoading.style.display = 'none';
                showError(result.error);
                btnCameraCapture.disabled = true;
            }
        } catch (err) {
            console.error('[Camera] カメラ起動中に例外', err);
            cameraLoading.style.display = 'none';
            showError({
                code: 'UNKNOWN',
                message: `エラーが発生しました: ${err.message}`
            });
            btnCameraCapture.disabled = true;
        }
    }
    
    /**
     * カメラを停止
     */
    function stopCameraWithUI() {
        stopCamera();
        btnCameraCapture.disabled = true;
    }
    
    /**
     * 静止画をキャプチャしてプレビュー表示 (Phase 2 Step 2-2)
     */
    async function capturePhotoWithUI() {
        console.log('[Camera] 静止画をキャプチャ');
        
        // 連打防止
        btnCameraCapture.disabled = true;
        const originalText = btnCameraCapture.textContent;
        btnCameraCapture.textContent = '📸 撮影中...';
        
        // ローディング表示
        cameraLoading.style.display = 'flex';
        if (loadingText) loadingText.textContent = '画像を処理中...';
        cameraError.style.display = 'none';
        
        try {
            // Step 1: 撮影
            const captureResult = await capturePhoto({
                videoEl: cameraVideo,
                canvasEl: cameraCanvas
            });
            
            console.log('[Camera] キャプチャ成功', captureResult);
            
            // Step 2: 画像処理（縮小・圧縮・向き補正）
            const processResult = await processCapturedPhoto({
                capturedBlob: captureResult.blob,
                previewImg: photoPreview
            });
            
            cameraLoading.style.display = 'none';
            
            if (processResult.ok) {
                console.log('[Camera] 画像処理成功');
                
                // プレビュー表示モードに切り替え
                switchToPhotoViewMode();
            } else {
                console.error('[Camera] 画像処理失敗', processResult.error);
                showError({
                    code: 'PROCESS_ERROR',
                    message: processResult.error
                });
            }
            
        } catch (err) {
            console.error('[Camera] キャプチャ失敗', err);
            cameraLoading.style.display = 'none';
            showError({
                code: 'CAPTURE_ERROR',
                message: `撮影に失敗しました: ${err.message}`
            });
        } finally {
            btnCameraCapture.textContent = originalText;
            btnCameraCapture.disabled = false;
        }
    }
    
    /**
     * エラーを表示
     */
    function showError(error) {
        cameraError.innerHTML = `<strong>エラー: ${error.code}</strong>${error.message}`;
        cameraError.style.display = 'block';
    }
    
    /**
     * video要素が準備完了するまで待機
     */
    function waitForVideoReady(videoEl) {
        return new Promise((resolve) => {
            if (videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
                resolve();
                return;
            }
            
            const onReady = () => {
                if (videoEl.videoWidth > 0) {
                    videoEl.removeEventListener('loadedmetadata', onReady);
                    videoEl.removeEventListener('canplay', onReady);
                    resolve();
                }
            };
            
            videoEl.addEventListener('loadedmetadata', onReady);
            videoEl.addEventListener('canplay', onReady);
        });
    }
    
    /**
     * 撮影ガイドを初期化 (Phase 2 Step 2-3)
     */
    function initGuide() {
        const { createGuideOverlay, startGuideResizeTracking } = window.CameraModule;
        
        if (!createGuideOverlay || !startGuideResizeTracking) {
            console.warn('[Camera] ガイド機能が利用できません');
            return;
        }
        
        try {
            // プレビューコンテナを取得
            const previewContainer = document.getElementById('cameraPreviewContainer');
            
            if (!previewContainer) {
                console.error('[Camera] プレビューコンテナが見つかりません');
                return;
            }
            
            // ガイドオーバーレイを生成
            createGuideOverlay(previewContainer);
            
            // リサイズ追従を開始
            startGuideResizeTracking(previewContainer);
            
            console.log('[Camera] ガイドを初期化しました');
        } catch (err) {
            console.error('[Camera] ガイド初期化エラー', err);
        }
    }
}

/* =========================================
   Phase 2 Step 2-4: 画像プレビュー機能
   ========================================= */

/**
 * 画像プレビュー機能の初期化
 * 目的: カメラから撮影した画像を入力フォーム上で表示・管理する
 */
function initImagePreview() {
    console.log('[ImagePreview] 初期化開始');
    
    // DOM要素の取得
    const imagePreviewSection = document.getElementById('imagePreviewSection');
    const previewImage = document.getElementById('previewImage');
    const btnRemoveImage = document.getElementById('btnRemoveImage');
    const imageZoomModal = document.getElementById('imageZoomModal');
    const zoomImage = document.getElementById('zoomImage');
    const btnCloseZoom = document.getElementById('btnCloseZoom');
    
    if (!imagePreviewSection || !previewImage || !btnRemoveImage) {
        console.warn('[ImagePreview] 必要なDOM要素が見つかりません');
        return;
    }
    
    // カメラからの画像選択イベントをリスン
    document.addEventListener('bp:image:selected', handleImageSelected);
    
    // 画像削除ボタン
    btnRemoveImage.addEventListener('click', handleRemoveImage);
    
    // 画像タップで拡大表示
    previewImage.addEventListener('click', handleImageClick);
    
    // 拡大モーダルの閉じるボタン
    if (btnCloseZoom) {
        btnCloseZoom.addEventListener('click', closeImageZoom);
    }
    
    // モーダル背景クリックで閉じる
    if (imageZoomModal) {
        imageZoomModal.addEventListener('click', (e) => {
            if (e.target === imageZoomModal || e.target.classList.contains('image-zoom-modal__overlay')) {
                closeImageZoom();
            }
        });
    }
    
    // Escキーで拡大モーダルを閉じる
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && imageZoomModal && imageZoomModal.style.display !== 'none') {
            closeImageZoom();
        }
    });
    
    // sessionStorageから既存画像を復元（ページリロード対応）
    restoreImageFromSessionStorage();
    
    console.log('[ImagePreview] 初期化完了');
}

/**
 * カメラからの画像選択イベントハンドラ
 * @param {CustomEvent} event - 画像選択イベント
 */
function handleImageSelected(event) {
    console.log('[ImagePreview] 画像選択イベント受信', event.detail);
    
    const imageData = event.detail;
    
    if (!imageData || !imageData.base64) {
        console.error('[ImagePreview] 無効な画像データ');
        return;
    }
    
    // 画像データを保存
    currentSelectedImage = {
        base64: imageData.base64,
        width: imageData.width,
        height: imageData.height,
        mime: imageData.mime || 'image/jpeg',
        createdAt: imageData.createdAt || new Date().toISOString(),
        rotation: imageData.rotation || 0
    };
    
    // プレビュー表示
    showImagePreview();
    
    // 成功メッセージを表示
    showMessage('success', '画像を読み込みました。画像を見ながら血圧値を入力してください。');
    
    // Phase 3 Step 3-4: OCRを自動開始
    startOcrForCurrentImage();
    
    console.log('[ImagePreview] 画像プレビュー表示完了');
}

/**
 * 画像プレビューを表示
 */
function showImagePreview() {
    const imagePreviewSection = document.getElementById('imagePreviewSection');
    const previewImage = document.getElementById('previewImage');
    
    if (!imagePreviewSection || !previewImage || !currentSelectedImage) {
        return;
    }
    
    // 画像を表示
    previewImage.src = currentSelectedImage.base64;
    imagePreviewSection.style.display = 'block';
    
    // 入力フィールドのプレースホルダーを更新
    updateFormPlaceholders(true);
    
    console.log('[ImagePreview] プレビュー表示');
}

/**
 * 画像プレビューを非表示
 */
function hideImagePreview() {
    const imagePreviewSection = document.getElementById('imagePreviewSection');
    const previewImage = document.getElementById('previewImage');
    
    if (!imagePreviewSection || !previewImage) {
        return;
    }
    
    // 画像を非表示
    imagePreviewSection.style.display = 'none';
    previewImage.src = '';
    
    // 入力フィールドのプレースホルダーを元に戻す
    updateFormPlaceholders(false);
    
    console.log('[ImagePreview] プレビュー非表示');
}

/**
 * 画像削除ハンドラ
 */
function handleRemoveImage() {
    console.log('[ImagePreview] 画像削除');
    
    // 画像データをクリア
    currentSelectedImage = null;
    
    // sessionStorageから削除
    if (window.CameraModule && window.CameraModule.clearSessionStorage) {
        window.CameraModule.clearSessionStorage();
    }
    
    // プレビュー非表示
    hideImagePreview();
    
    // Phase 3 Step 3-4: OCR状態をリセット
    resetOcrState();
    
    // 拡大モーダルも閉じる（開いている場合）
    closeImageZoom();
    
    console.log('[ImagePreview] 画像削除完了');
}

/**
 * 画像クリックハンドラ（拡大表示）
 */
function handleImageClick() {
    console.log('[ImagePreview] 画像クリック - 拡大表示');
    
    if (!currentSelectedImage) {
        return;
    }
    
    const imageZoomModal = document.getElementById('imageZoomModal');
    const zoomImage = document.getElementById('zoomImage');
    
    if (!imageZoomModal || !zoomImage) {
        console.warn('[ImagePreview] 拡大モーダル要素が見つかりません');
        return;
    }
    
    // 拡大画像を設定
    zoomImage.src = currentSelectedImage.base64;
    
    // モーダルを表示
    imageZoomModal.style.display = 'flex';
    
    // 背面スクロールを固定
    document.body.style.overflow = 'hidden';
    
    // フォーカスを閉じるボタンへ
    const btnCloseZoom = document.getElementById('btnCloseZoom');
    if (btnCloseZoom) {
        setTimeout(() => btnCloseZoom.focus(), 100);
    }
    
    console.log('[ImagePreview] 拡大モーダル表示');
}

/**
 * 拡大表示を閉じる
 */
function closeImageZoom() {
    const imageZoomModal = document.getElementById('imageZoomModal');
    const zoomImage = document.getElementById('zoomImage');
    
    if (!imageZoomModal) {
        return;
    }
    
    // モーダルを非表示
    imageZoomModal.style.display = 'none';
    
    // 画像をクリア
    if (zoomImage) {
        zoomImage.src = '';
    }
    
    // 背面スクロールを復元
    document.body.style.overflow = '';
    
    // フォーカスをプレビュー画像に戻す
    const previewImage = document.getElementById('previewImage');
    if (previewImage) {
        setTimeout(() => previewImage.focus(), 100);
    }
    
    console.log('[ImagePreview] 拡大モーダル閉じる');
}

/**
 * sessionStorageから画像を復元
 */
function restoreImageFromSessionStorage() {
    if (!window.CameraModule || !window.CameraModule.CAMERA_STORAGE_KEY) {
        return;
    }
    
    try {
        const storageKey = window.CameraModule.CAMERA_STORAGE_KEY;
        const json = sessionStorage.getItem(storageKey);
        
        if (!json) {
            return;
        }
        
        const imageData = JSON.parse(json);
        
        if (imageData && imageData.base64) {
            currentSelectedImage = {
                base64: imageData.base64,
                width: imageData.width,
                height: imageData.height,
                mime: imageData.mime || 'image/jpeg',
                createdAt: imageData.createdAt || new Date().toISOString(),
                rotation: imageData.rotation || 0
            };
            
            showImagePreview();
            console.log('[ImagePreview] sessionStorageから画像を復元しました');
        }
    } catch (err) {
        console.error('[ImagePreview] sessionStorageからの復元失敗', err);
    }
}

/**
 * フォームのプレースホルダーを更新
 * @param {boolean} hasImage - 画像がある場合true
 */
function updateFormPlaceholders(hasImage) {
    const systolicInput = document.getElementById('systolic');
    const diastolicInput = document.getElementById('diastolic');
    const pulseInput = document.getElementById('pulse');
    
    if (hasImage) {
        if (systolicInput) {
            systolicInput.placeholder = '画像を見ながら入力';
        }
        if (diastolicInput) {
            diastolicInput.placeholder = '画像を見ながら入力';
        }
        if (pulseInput) {
            pulseInput.placeholder = '画像を見ながら入力';
        }
    } else {
        if (systolicInput) {
            systolicInput.placeholder = '50〜250';
        }
        if (diastolicInput) {
            diastolicInput.placeholder = '30〜150';
        }
        if (pulseInput) {
            pulseInput.placeholder = '40〜200';
        }
    }
}

/**
 * 記録保存成功後に画像をクリア
 */
function clearImageAfterSave() {
    if (currentSelectedImage) {
        console.log('[ImagePreview] 保存完了 - 画像をクリア');
        handleRemoveImage();
    }
}

/* =========================================
   Phase 3 Step 3-1: OCRテスト機能（開発時のみ）
   ========================================= */

/**
 * OCRテスト機能の初期化
 * 目的: URLパラメータ ?debug=1 でOCRテストボタンを表示し、疎通確認を行う
 */
function initOcrTest() {
    // URLパラメータをチェック
    const urlParams = new URLSearchParams(window.location.search);
    const isDebugMode = urlParams.get('debug') === '1';
    
    if (!isDebugMode) {
        console.log('[OCR Test] デバッグモードではありません（URLに ?debug=1 を追加すると有効化されます）');
        return;
    }
    
    console.log('[OCR Test] デバッグモード有効 - OCRテストボタンを表示します');
    
    const btnOcrTest = document.getElementById('btnOcrTest');
    if (!btnOcrTest) {
        console.warn('[OCR Test] OCRテストボタンが見つかりません');
        return;
    }
    
    // ボタンを表示
    btnOcrTest.style.display = 'inline-block';
    
    // クリックイベントを追加
    btnOcrTest.addEventListener('click', handleOcrTest);
    
    console.log('[OCR Test] 初期化完了');
}

/**
 * OCRテストハンドラ
 */
async function handleOcrTest() {
    console.log('[OCR Test] テスト開始');
    
    // OCRモジュールの確認
    if (!window.OCR) {
        alert('OCRモジュールが読み込まれていません');
        console.error('[OCR Test] window.OCR が存在しません');
        return;
    }
    
    const { recognizeText } = window.OCR;
    
    // 現在選択中の画像があるかチェック
    if (currentSelectedImage && currentSelectedImage.base64) {
        await testOcrWithImage(currentSelectedImage.base64);
    } else {
        // テスト用のサンプル画像を生成（数字を描画したcanvas）
        await testOcrWithSampleImage();
    }
}

/**
 * 画像を使ってOCRをテスト
 * @param {string} imageBase64 - Base64エンコードされた画像
 */
async function testOcrWithImage(imageBase64) {
    console.log('[OCR Test] 画像を使用してOCRテスト');
    
    const btnOcrTest = document.getElementById('btnOcrTest');
    const originalText = btnOcrTest ? btnOcrTest.textContent : '';
    const urlParams = new URLSearchParams(window.location.search);
    const isDebugMode = urlParams.get('debug') === '1';
    
    try {
        if (btnOcrTest) {
            btnOcrTest.disabled = true;
            btnOcrTest.textContent = '🔍 認識中...';
        }
        
        showMessage('success', 'OCR処理を開始しています...');
        
        const startTime = performance.now();
        
        const ocrOptions = {
            onProgress: (info) => {
                console.log(`[OCR Test] 進捗: ${info.status} - ${Math.round(info.progress * 100)}%`);
            },
            preprocessOptions: {},
            debugPreprocess: isDebugMode
        };
        if (isDebugMode) {
            ocrOptions.preprocessOptions.debug = { enabled: true, maxKeep: 5 };
        }
        
        const result = await window.OCR.recognizeText(imageBase64, ocrOptions);
        
        const elapsedTime = Math.round(performance.now() - startTime);
        
        console.log('[OCR Test] 認識結果:', result);
        console.log(`[OCR Test] 処理時間: ${elapsedTime}ms`);
        
        if (isDebugMode && result.preprocessMeta) {
            showPreprocessDebugPanel(result.preprocessMeta);
        } else {
            hidePreprocessDebugPanel();
        }
        
        let message = `【OCR認識結果】\n` +
                       `認識テキスト: "${result.rawText.trim()}"\n` +
                       `信頼度: ${Math.round(result.confidence)}%\n` +
                       `処理時間: ${elapsedTime}ms`;
        if (result.preprocessMeta && result.preprocessMeta.timingsMs) {
            message += `\n前処理: ${result.preprocessMeta.timingsMs.total}ms`;
        }
        
        alert(message);
        showMessage('success', 'OCR認識が完了しました');
        
    } catch (error) {
        console.error('[OCR Test] エラー:', error);
        alert(`OCR認識に失敗しました\n${error.message}`);
        showMessage('error', 'OCR認識に失敗しました');
        hidePreprocessDebugPanel();
    } finally {
        if (btnOcrTest) {
            btnOcrTest.textContent = originalText;
            btnOcrTest.disabled = false;
        }
    }
}

function showPreprocessDebugPanel(meta) {
    const panel = document.getElementById('preprocessDebugPanel');
    const content = document.getElementById('preprocessDebugContent');
    const metaEl = document.getElementById('preprocessDebugMeta');
    if (!panel || !content || !metaEl) return;
    content.innerHTML = '';
    if (meta.debugCanvases && meta.debugCanvases.length > 0) {
        meta.debugCanvases.forEach(function(item) {
            const wrap = document.createElement('div');
            wrap.className = 'preprocess-debug__item';
            const label = document.createElement('span');
            label.textContent = item.label;
            label.style.display = 'block';
            wrap.appendChild(label);
            const c = document.createElement('canvas');
            c.width = item.canvas.width;
            c.height = item.canvas.height;
            c.getContext('2d').drawImage(item.canvas, 0, 0);
            c.style.maxWidth = '120px';
            c.style.maxHeight = '80px';
            wrap.appendChild(c);
            content.appendChild(wrap);
        });
    }
    let metaText = '';
    if (meta.roi) metaText += 'ROI: ' + JSON.stringify(meta.roi) + '\n';
    if (meta.threshold) metaText += '閾値: ' + JSON.stringify(meta.threshold) + '\n';
    if (meta.timingsMs && meta.timingsMs.steps) metaText += 'ステップ(ms): ' + JSON.stringify(meta.timingsMs.steps) + '\n';
    if (meta.warnings && meta.warnings.length) metaText += 'warnings: ' + meta.warnings.join(', ');
    metaEl.textContent = metaText || '(なし)';
    panel.style.display = 'block';
    panel.setAttribute('aria-hidden', 'false');
}

function hidePreprocessDebugPanel() {
    const panel = document.getElementById('preprocessDebugPanel');
    if (panel) {
        panel.style.display = 'none';
        panel.setAttribute('aria-hidden', 'true');
    }
}

/**
 * サンプル画像を生成してOCRをテスト
 */
async function testOcrWithSampleImage() {
    console.log('[OCR Test] サンプル画像を生成してOCRテスト');
    
    // canvasにテスト用の数字を描画
    const canvas = document.createElement('canvas');
    canvas.width = 400;
    canvas.height = 200;
    const ctx = canvas.getContext('2d');
    
    // 背景を白に
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    
    // 血圧計風の数字を描画
    ctx.fillStyle = '#000000';
    ctx.font = 'bold 48px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    
    ctx.fillText('120 / 80', canvas.width / 2, canvas.height / 2 - 30);
    ctx.fillText('75', canvas.width / 2, canvas.height / 2 + 30);
    
    // canvasをBase64に変換
    const imageBase64 = canvas.toDataURL('image/png');
    
    console.log('[OCR Test] サンプル画像生成完了');
    
    // OCRテスト実行
    await testOcrWithImage(imageBase64);
}

/* =========================================
   Phase 3 Step 3-4: OCR自動入力と確認UI
   ========================================= */

/**
 * OCR確認UIのイベントを初期化
 * 目的: バナーのアクションボタンと各inputの編集イベントを結線する
 */
function initOcrAutoRun() {
    const btnOcrSave        = document.getElementById('btnOcrSave');
    const btnOcrEdit        = document.getElementById('btnOcrEdit');
    const btnOcrRetry       = document.getElementById('btnOcrRetry');
    const btnOcrRetryFailed = document.getElementById('btnOcrRetryFailed');

    if (btnOcrSave)        btnOcrSave.addEventListener('click', handleOcrSave);
    if (btnOcrEdit)        btnOcrEdit.addEventListener('click', handleOcrEdit);
    if (btnOcrRetry)       btnOcrRetry.addEventListener('click', handleOcrRetry);
    if (btnOcrRetryFailed) btnOcrRetryFailed.addEventListener('click', handleOcrRetry);

    // 各inputを編集したら自動入力マークを解除
    ['systolic', 'diastolic', 'pulse'].forEach(fieldName => {
        const input = document.getElementById(fieldName);
        if (input) {
            input.addEventListener('input', () => clearOcrAutoFill(fieldName));
        }
    });

    console.log('[OCR AutoRun] 初期化完了');
}

/**
 * 現在の画像でOCRを開始するエントリポイント
 * 目的: handleImageSelected から呼ばれ、imageToken をリセットして runOcr を起動する
 */
async function startOcrForCurrentImage() {
    if (!currentSelectedImage || !currentSelectedImage.base64) {
        return;
    }
    if (!window.OCR || typeof window.OCR.recognizeText !== 'function') {
        console.warn('[OCR AutoRun] OCRモジュールが読み込まれていません');
        return;
    }
    if (ocrStatus === 'running') {
        return;
    }

    const token = String(Date.now());
    imageToken = token;
    ocrRetryCount = 0;

    await runOcr(token);
}

/**
 * OCR実行（認識→抽出→フォーム反映→UI更新）
 * 目的: ocrStatus を管理しながら OCR 処理の一連を実行する
 * @param {string} token - 現在の imageToken（古い結果を破棄するため）
 */
async function runOcr(token) {
    if (!currentSelectedImage || !currentSelectedImage.base64) {
        return;
    }

    ocrStatus = 'running';
    ocrError  = null;
    ocrResult = null;
    renderOcrUI();

    const startTime = performance.now();
    console.log('[OCR AutoRun] OCR開始');

    try {
        // DOM描画を先に済ませてからOCRを開始（UIフリーズ防止）
        await new Promise(resolve => setTimeout(resolve, 0));

        if (imageToken !== token) {
            console.log('[OCR AutoRun] トークン不一致のため中断（起動前）');
            return;
        }

        const image = currentSelectedImage.base64;
        const ocrRaw = await window.OCR.recognizeText(image);

        if (imageToken !== token) {
            console.log('[OCR AutoRun] OCR完了したが画像が変わったため結果を破棄');
            return;
        }

        const elapsed = Math.round(performance.now() - startTime);
        console.log(`[OCR AutoRun] 認識完了 (${elapsed}ms)`);

        const vitals = window.OCR.extractVitalsFromOcr({ data: ocrRaw.data });
        console.log('[OCR AutoRun] 抽出結果:', {
            systolic: vitals.systolic,
            diastolic: vitals.diastolic,
            pulse: vitals.pulse,
            confidence: vitals.confidence
        });

        // systolic・diastolic が両方 null の場合は失敗扱い
        if (vitals.systolic === null && vitals.diastolic === null) {
            ocrStatus = 'failed';
            ocrError  = { message: '血圧値を認識できませんでした', code: 'BP_PAIR_NOT_FOUND' };
            ocrResult = null;
        } else {
            ocrStatus = 'success';
            ocrResult = {
                systolic:   vitals.systolic,
                diastolic:  vitals.diastolic,
                pulse:      vitals.pulse,
                confidence: vitals.confidence,
                fieldConf:  vitals.fieldConfidence,
                rawText:    vitals.rawText,
                warnings:   vitals.warnings
            };
            applyOcrResultToForm(ocrResult);
        }

    } catch (error) {
        if (imageToken !== token) return;

        console.error('[OCR AutoRun] 失敗:', error);
        ocrStatus = 'failed';
        ocrError  = { message: error.message, code: 'OCR_ERROR' };
        ocrResult = null;
    }

    renderOcrUI();
}

/**
 * OCR状態に応じてバナーとボタンを更新（UIの唯一の更新口）
 * 目的: 状態変数 ocrStatus を見てDOMを一括更新する
 */
function renderOcrUI() {
    const banner            = document.getElementById('ocrBanner');
    const runningSection    = document.getElementById('ocrBannerRunning');
    const successSection    = document.getElementById('ocrBannerSuccess');
    const failedSection     = document.getElementById('ocrBannerFailed');
    const btnOcrRetry       = document.getElementById('btnOcrRetry');
    const btnOcrRetryFailed = document.getElementById('btnOcrRetryFailed');
    const btnOcrSave        = document.getElementById('btnOcrSave');
    const btnSubmit         = document.getElementById('btnSubmit');

    if (!banner) return;

    // 全セクションを一旦非表示
    if (runningSection) runningSection.style.display = 'none';
    if (successSection) successSection.style.display = 'none';
    if (failedSection)  failedSection.style.display  = 'none';

    if (ocrStatus === 'idle') {
        banner.style.display = 'none';
        if (btnSubmit) btnSubmit.disabled = false;
        return;
    }

    banner.style.display = 'block';

    if (ocrStatus === 'running') {
        if (runningSection) runningSection.style.display = 'flex';
        if (btnSubmit) btnSubmit.disabled = true;
        if (btnOcrSave) btnOcrSave.disabled = true;

    } else if (ocrStatus === 'success') {
        if (successSection) successSection.style.display = 'block';
        if (btnSubmit)  btnSubmit.disabled  = false;
        if (btnOcrSave) btnOcrSave.disabled = false;

        // 低信頼度（<70）なら再試行ボタンを表示しメッセージを変更
        const hasLowConf = ocrResult && ocrResult.confidence < OCR_CONFIDENCE_MID;
        if (btnOcrRetry) {
            btnOcrRetry.style.display = hasLowConf ? 'inline-block' : 'none';
            btnOcrRetry.disabled = ocrRetryCount >= OCR_RETRY_LIMIT;
        }

        const successMsg = document.getElementById('ocrBannerSuccessMsg');
        if (successMsg) {
            successMsg.textContent = hasLowConf
                ? '! 信頼度が低い項目があります。内容を確認してください'
                : '✓ 認識結果を確認してください';
        }

        // 信頼度バッジを更新
        if (ocrResult && ocrResult.fieldConf) {
            updateConfidenceBadge('systolic',  ocrResult.fieldConf.systolic,  ocrResult.systolic);
            updateConfidenceBadge('diastolic', ocrResult.fieldConf.diastolic, ocrResult.diastolic);
            updateConfidenceBadge('pulse',     ocrResult.fieldConf.pulse,     ocrResult.pulse);
        }

    } else if (ocrStatus === 'failed') {
        if (failedSection) failedSection.style.display = 'block';
        if (btnSubmit) btnSubmit.disabled = false;

        // 失敗メッセージを状態に合わせて更新
        const failedMsg = document.getElementById('ocrBannerFailedMsg');
        if (failedMsg && ocrError) {
            if (ocrError.code === 'BP_PAIR_NOT_FOUND') {
                failedMsg.textContent = '✕ 血圧値を認識できませんでした。手動で入力するか再試行してください';
            } else {
                failedMsg.textContent = '✕ 自動読み取りに失敗しました。手動で入力するか再試行してください';
            }
        }

        // 再試行回数が上限を超えた場合はボタンを変更
        if (btnOcrRetryFailed) {
            if (ocrRetryCount >= OCR_RETRY_LIMIT) {
                btnOcrRetryFailed.disabled = true;
                btnOcrRetryFailed.textContent = '再試行の上限に達しました（撮り直してください）';
            } else {
                btnOcrRetryFailed.disabled = false;
                btnOcrRetryFailed.textContent = '再試行';
            }
        }
    }
}

/**
 * OCR結果をフォームへ自動入力
 * 目的: 抽出した血圧値をinputに反映し、data-autofilled を付与する
 * @param {Object} result - ocrResult（systolic/diastolic/pulse/fieldConf）
 */
function applyOcrResultToForm(result) {
    ['systolic', 'diastolic', 'pulse'].forEach(fieldName => {
        const input = document.getElementById(fieldName);
        if (!input) return;

        const value = result[fieldName];
        if (value !== null && value !== undefined) {
            input.value = String(value);
            input.dataset.autofilled = 'true';
            const conf = result.fieldConf ? result.fieldConf[fieldName] : result.confidence;
            input.dataset.confidence = String(Math.round(conf || 0));
        } else {
            // null の場合はフィールドをクリアして自動入力マークを外す
            input.value = '';
            delete input.dataset.autofilled;
            delete input.dataset.confidence;
        }
    });
}

/**
 * 信頼度バッジを更新
 * 目的: フィールドごとの信頼度に応じてバッジの文言・色クラスを切り替える
 * @param {string} fieldName  - 'systolic' | 'diastolic' | 'pulse'
 * @param {number} confidence - 0-100
 * @param {number|null} value - OCR抽出値（null ならバッジを非表示）
 */
function updateConfidenceBadge(fieldName, confidence, value) {
    const badge = document.getElementById(`${fieldName}-conf-badge`);
    const input = document.getElementById(fieldName);

    if (!badge) return;

    const autofilledClasses = [
        'form-field__input--autofilled-high',
        'form-field__input--autofilled-mid',
        'form-field__input--autofilled-low'
    ];
    const badgeClasses = [
        'ocr-confidence-badge--high',
        'ocr-confidence-badge--mid',
        'ocr-confidence-badge--low',
        'ocr-confidence-badge--edited'
    ];

    // 値が null なら非表示
    if (value === null || value === undefined) {
        badge.style.display = 'none';
        badge.setAttribute('aria-hidden', 'true');
        if (input) {
            input.classList.remove(...autofilledClasses);
        }
        return;
    }

    badge.style.display = 'inline-flex';
    badge.removeAttribute('aria-hidden');
    badge.classList.remove(...badgeClasses);
    if (input) input.classList.remove(...autofilledClasses);

    // 編集済みの場合
    const isEdited = input && input.dataset.autofilled !== 'true';
    if (isEdited) {
        badge.textContent = '✎ 編集済';
        badge.classList.add('ocr-confidence-badge--edited');
        return;
    }

    const pct = Math.round(confidence);
    if (confidence > OCR_CONFIDENCE_HIGH) {
        badge.textContent = `✓ ${pct}%`;
        badge.classList.add('ocr-confidence-badge--high');
        if (input) input.classList.add('form-field__input--autofilled-high');
    } else if (confidence >= OCR_CONFIDENCE_MID) {
        badge.textContent = `! ${pct}%`;
        badge.classList.add('ocr-confidence-badge--mid');
        if (input) input.classList.add('form-field__input--autofilled-mid');
    } else {
        badge.textContent = `✕ ${pct}%`;
        badge.classList.add('ocr-confidence-badge--low');
        if (input) input.classList.add('form-field__input--autofilled-low');
    }
}

/**
 * 手動編集時に該当フィールドの自動入力マークを解除
 * 目的: input イベントで呼ばれ、自動入力装飾を通常状態へ戻す
 * @param {string} fieldName - 'systolic' | 'diastolic' | 'pulse'
 */
function clearOcrAutoFill(fieldName) {
    const input = document.getElementById(fieldName);
    if (!input || input.dataset.autofilled !== 'true') return;

    // 自動入力マークを解除
    delete input.dataset.autofilled;
    input.classList.remove(
        'form-field__input--autofilled-high',
        'form-field__input--autofilled-mid',
        'form-field__input--autofilled-low'
    );

    // バッジを「編集済」に更新
    if (ocrStatus === 'success' && ocrResult) {
        const conf = ocrResult.fieldConf ? ocrResult.fieldConf[fieldName] : ocrResult.confidence;
        updateConfidenceBadge(fieldName, conf, ocrResult[fieldName]);
    }
}

/**
 * OCR状態・フォームの自動入力装飾・バッジを全リセット
 * 目的: 画像削除・撮り直し時に古いOCR結果を完全に消去する
 */
function resetOcrState() {
    // 実行中のOCR結果を無効化するためトークンを更新
    imageToken = String(Date.now());

    ocrStatus     = 'idle';
    ocrResult     = null;
    ocrError      = null;
    ocrProgress   = null;
    ocrRetryCount = 0;

    ['systolic', 'diastolic', 'pulse'].forEach(fieldName => {
        const input = document.getElementById(fieldName);
        if (input) {
            delete input.dataset.autofilled;
            delete input.dataset.confidence;
            input.classList.remove(
                'form-field__input--autofilled-high',
                'form-field__input--autofilled-mid',
                'form-field__input--autofilled-low'
            );
        }
        const badge = document.getElementById(`${fieldName}-conf-badge`);
        if (badge) {
            badge.style.display = 'none';
            badge.textContent = '';
            badge.setAttribute('aria-hidden', 'true');
        }
    });

    renderOcrUI();
}

/**
 * 「そのまま記録」ボタン処理
 * 目的: OCR実行中でなければ既存の記録ボタンをクリックして保存へ進む
 */
function handleOcrSave() {
    if (ocrStatus === 'running') {
        showMessage('warn', 'OCR処理中です。完了後に記録してください。');
        return;
    }
    const btnSubmit = document.getElementById('btnSubmit');
    if (btnSubmit) {
        btnSubmit.click();
    }
}

/**
 * 「修正する」ボタン処理
 * 目的: 最初の入力フィールドへフォーカスしてキーボードを誘導する
 */
function handleOcrEdit() {
    const systolicInput = document.getElementById('systolic');
    if (systolicInput) {
        systolicInput.focus();
        systolicInput.select();
    }
}

/**
 * 「再試行」ボタン処理
 * 目的: 未編集フィールドのみクリアして OCR を再実行する
 */
async function handleOcrRetry() {
    if (ocrStatus === 'running') return;

    if (ocrRetryCount >= OCR_RETRY_LIMIT) {
        showMessage('warn', `再試行の上限（${OCR_RETRY_LIMIT}回）に達しました。撮り直してください。`);
        return;
    }

    if (!currentSelectedImage || !currentSelectedImage.base64) {
        showMessage('warn', '画像がありません。再撮影してください。');
        return;
    }

    ocrRetryCount++;

    // 未編集（data-autofilled が残っている）フィールドのみクリア
    ['systolic', 'diastolic', 'pulse'].forEach(fieldName => {
        const input = document.getElementById(fieldName);
        if (input && input.dataset.autofilled === 'true') {
            input.value = '';
            delete input.dataset.autofilled;
            delete input.dataset.confidence;
            input.classList.remove(
                'form-field__input--autofilled-high',
                'form-field__input--autofilled-mid',
                'form-field__input--autofilled-low'
            );
        }
        const badge = document.getElementById(`${fieldName}-conf-badge`);
        if (badge) badge.style.display = 'none';
    });

    const token = String(Date.now());
    imageToken = token;

    await runOcr(token);
}

// アプリ初期化時にOCRテストを初期化（既存のinit関数に追加）
document.addEventListener('DOMContentLoaded', () => {
    // 既存の初期化の後にOCRテストを初期化
    // init() は既に呼ばれているので、ここでは追加分のみ
    initOcrTest();
});

