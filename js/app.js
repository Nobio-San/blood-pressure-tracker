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
let imageIsGuideCropped = false; // ガイド枠クロップ済みフラグ

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
    
    // グラフ機能強化 初期化（Phase 4 Step 4-2）
    initGraphControls();
    
    // オフライン検知の初期化
    initOfflineDetection();
    
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

/* ===== graph: 状態・フィルタ・変換（Phase 4 Step 4-2） ===== */
const GRAPH_STORAGE_KEY = (typeof GRAPH_CONSTANTS !== 'undefined' && GRAPH_CONSTANTS.STORAGE_KEY) ? GRAPH_CONSTANTS.STORAGE_KEY : 'bp_graph_state_v1';

function getGraphState() {
    const chartMemberFilter = document.getElementById('chartMemberFilter');
    const memberId = chartMemberFilter ? chartMemberFilter.value : 'all';
    let rangeKey = '30d', chartType = 'line', viewMode = 'trend';
    document.querySelectorAll('.chart-control__btn[data-range]').forEach(btn => { if (btn.getAttribute('aria-pressed') === 'true') rangeKey = btn.dataset.range || '30d'; });
    document.querySelectorAll('.chart-control__btn[data-type]').forEach(btn => { if (btn.getAttribute('aria-pressed') === 'true') chartType = btn.dataset.type || 'line'; });
    document.querySelectorAll('.chart-control__btn[data-view]').forEach(btn => { if (btn.getAttribute('aria-pressed') === 'true') viewMode = btn.dataset.view || 'trend'; });
    const targetEnabledEl = document.getElementById('targetEnabled');
    const targetSysEl = document.getElementById('targetSys');
    const targetDiaEl = document.getElementById('targetDia');
    return {
        memberId,
        rangeKey,
        chartType,
        viewMode,
        targetEnabled: targetEnabledEl ? targetEnabledEl.checked : false,
        targetSys: targetSysEl && targetSysEl.value ? parseInt(targetSysEl.value, 10) : null,
        targetDia: targetDiaEl && targetDiaEl.value ? parseInt(targetDiaEl.value, 10) : null
    };
}

function setGraphStateFromDOM() {
    const state = getGraphState();
    if (isStorageAvailable()) { try { localStorage.setItem(GRAPH_STORAGE_KEY, JSON.stringify(state)); } catch (e) { console.warn('グラフ状態の保存に失敗:', e); } }
    return state;
}

function loadGraphStateFromStorage() {
    if (!isStorageAvailable()) return null;
    try { const json = localStorage.getItem(GRAPH_STORAGE_KEY); return json ? JSON.parse(json) : null; } catch (e) { return null; }
}

function getFilteredRecords(opts) {
    const { records, memberId, rangeKey, now } = opts;
    let filtered = records;
    if (memberId && memberId !== 'all') filtered = records.filter(r => r.member === memberId);
    if (rangeKey === 'all') return filtered;
    const days = (typeof GRAPH_CONSTANTS !== 'undefined' && GRAPH_CONSTANTS.RANGE_DAYS) ? GRAPH_CONSTANTS.RANGE_DAYS[rangeKey] : (rangeKey === '7d' ? 7 : rangeKey === '30d' ? 30 : 90);
    if (!days) return filtered;
    const baseDate = now || new Date();
    const startOfRange = new Date(baseDate); startOfRange.setDate(startOfRange.getDate() - days + 1); startOfRange.setHours(0, 0, 0, 0);
    const endOfRange = new Date(baseDate); endOfRange.setHours(23, 59, 59, 999);
    return filtered.filter(record => {
        const t = record.measuredAt != null ? record.measuredAt : (record.datetimeIso ? new Date(record.datetimeIso).getTime() : 0);
        return t >= startOfRange.getTime() && t <= endOfRange.getTime();
    });
}

function getDateKey(date) {
    const d = date instanceof Date ? date : new Date(date);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatDateLabel(dateKey) {
    const parts = dateKey.split('-');
    return parts.length >= 3 ? `${parts[1]}/${parts[2]}` : dateKey;
}

function transformTrendLineBar(records) {
    const grouped = {};
    records.forEach(record => {
        const dt = record.datetimeIso ? new Date(record.datetimeIso) : new Date(record.measuredAt);
        const dateKey = getDateKey(dt);
        if (!grouped[dateKey]) grouped[dateKey] = { systolic: 0, diastolic: 0, pulse: 0, count: 0, timestamp: dt.getTime() };
        grouped[dateKey].systolic += record.systolic;
        grouped[dateKey].diastolic += record.diastolic;
        grouped[dateKey].pulse += record.pulse;
        grouped[dateKey].count += 1;
    });
    Object.keys(grouped).forEach(k => {
        const g = grouped[k];
        g.systolic = Math.round(g.systolic / g.count);
        g.diastolic = Math.round(g.diastolic / g.count);
        g.pulse = Math.round(g.pulse / g.count);
    });
    const sorted = Object.entries(grouped).sort((a, b) => a[1].timestamp - b[1].timestamp);
    return { labels: sorted.map(([k]) => formatDateLabel(k)), systolic: sorted.map(([, v]) => v.systolic), diastolic: sorted.map(([, v]) => v.diastolic), pulse: sorted.map(([, v]) => v.pulse) };
}

function transformTrendScatter(records) {
    const maxDays = (typeof GRAPH_CONSTANTS !== 'undefined' && GRAPH_CONSTANTS.SCATTER_MAX_DAYS) ? GRAPH_CONSTANTS.SCATTER_MAX_DAYS : 90;
    const sorted = [...records].sort((a, b) => {
        const ta = a.measuredAt != null ? a.measuredAt : new Date(a.datetimeIso).getTime();
        const tb = b.measuredAt != null ? b.measuredAt : new Date(b.datetimeIso).getTime();
        return ta - tb;
    });
    let useRecords = sorted.length > maxDays * 5 ? sorted.filter((_, i) => i % Math.max(1, Math.ceil(sorted.length / (maxDays * 3))) === 0) : sorted;
    const sysPoints = [], diaPoints = [], pulsePoints = [];
    useRecords.forEach(r => {
        const dt = r.datetimeIso ? new Date(r.datetimeIso) : new Date(r.measuredAt);
        const lbl = dt.toLocaleString('ja-JP', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
        sysPoints.push({ x: dt.getTime(), y: r.systolic, label: lbl, member: r.member });
        diaPoints.push({ x: dt.getTime(), y: r.diastolic, label: lbl, member: r.member });
        pulsePoints.push({ x: dt.getTime(), y: r.pulse, label: lbl, member: r.member });
    });
    return { labels: useRecords.map(() => ''), sysPoints, diaPoints, pulsePoints, type: 'scatter' };
}

function getTimebandKey(hour) {
    if (hour >= 4 && hour <= 10) return 'morning';
    if (hour >= 11 && hour <= 16) return 'noon';
    return 'night';
}

function transformTimeband(records) {
    const order = ['morning', 'noon', 'night'];
    const labels = (typeof GRAPH_CONSTANTS !== 'undefined' && GRAPH_CONSTANTS.TIMEBAND) ? [GRAPH_CONSTANTS.TIMEBAND.morning.label, GRAPH_CONSTANTS.TIMEBAND.noon.label, GRAPH_CONSTANTS.TIMEBAND.night.label] : ['朝', '昼', '夜'];
    const agg = { morning: { s: 0, d: 0, p: 0, n: 0 }, noon: { s: 0, d: 0, p: 0, n: 0 }, night: { s: 0, d: 0, p: 0, n: 0 } };
    records.forEach(r => {
        const dt = r.datetimeIso ? new Date(r.datetimeIso) : new Date(r.measuredAt);
        const key = getTimebandKey(dt.getHours());
        agg[key].s += r.systolic; agg[key].d += r.diastolic; agg[key].p += r.pulse; agg[key].n += 1;
    });
    const systolic = [], diastolic = [], pulse = [];
    order.forEach(k => {
        const a = agg[k];
        systolic.push(a.n > 0 ? Math.round(a.s / a.n) : null);
        diastolic.push(a.n > 0 ? Math.round(a.d / a.n) : null);
        pulse.push(a.n > 0 ? Math.round(a.p / a.n) : null);
    });
    return { labels, systolic, diastolic, pulse, type: 'bar' };
}

function transformWeekday(records) {
    const labels = (typeof GRAPH_CONSTANTS !== 'undefined' && GRAPH_CONSTANTS.WEEKDAY_LABELS) ? [...GRAPH_CONSTANTS.WEEKDAY_LABELS] : ['月', '火', '水', '木', '金', '土', '日'];
    const agg = Array(7).fill(0).map(() => ({ s: 0, d: 0, p: 0, n: 0 }));
    records.forEach(r => {
        const dt = r.datetimeIso ? new Date(r.datetimeIso) : new Date(r.measuredAt);
        const idx = dt.getDay() === 0 ? 6 : dt.getDay() - 1;
        agg[idx].s += r.systolic; agg[idx].d += r.diastolic; agg[idx].p += r.pulse; agg[idx].n += 1;
    });
    return { labels, systolic: agg.map(a => a.n > 0 ? Math.round(a.s / a.n) : null), diastolic: agg.map(a => a.n > 0 ? Math.round(a.d / a.n) : null), pulse: agg.map(a => a.n > 0 ? Math.round(a.p / a.n) : null), type: 'bar' };
}

function calcStats(records) {
    const sysArr = records.map(r => r.systolic).filter(v => v != null && !isNaN(v));
    const diaArr = records.map(r => r.diastolic).filter(v => v != null && !isNaN(v));
    const pulseArr = records.map(r => r.pulse).filter(v => v != null && !isNaN(v));
    const avg = (arr) => arr.length === 0 ? null : arr.reduce((a, b) => a + b, 0) / arr.length;
    const std = (arr) => { if (arr.length < 2) return null; const m = avg(arr); return Math.sqrt(arr.reduce((s, x) => s + (x - m) * (x - m), 0) / arr.length); };
    return { count: records.length, systolic: { avg: avg(sysArr), min: sysArr.length ? Math.min(...sysArr) : null, max: sysArr.length ? Math.max(...sysArr) : null, std: std(sysArr) }, diastolic: { avg: avg(diaArr), min: diaArr.length ? Math.min(...diaArr) : null, max: diaArr.length ? Math.max(...diaArr) : null, std: std(diaArr) }, pulse: { avg: avg(pulseArr), min: pulseArr.length ? Math.min(...pulseArr) : null, max: pulseArr.length ? Math.max(...pulseArr) : null, std: std(pulseArr) } };
}

function buildChartDatasets(chartData, state) {
    const { targetEnabled, targetSys, targetDia, chartType, viewMode } = state;
    const datasets = [];
    const isScatter = chartType === 'scatter' && chartData.type === 'scatter';
    if (isScatter) {
        datasets.push({ label: '最高血圧 (mmHg)', data: chartData.sysPoints, borderColor: 'rgb(220, 53, 69)', backgroundColor: 'rgba(220, 53, 69, 0.4)', pointRadius: 5, pointHoverRadius: 8, yAxisID: 'y' });
        datasets.push({ label: '最低血圧 (mmHg)', data: chartData.diaPoints, borderColor: 'rgb(13, 110, 253)', backgroundColor: 'rgba(13, 110, 253, 0.4)', pointRadius: 5, pointHoverRadius: 8, yAxisID: 'y' });
        datasets.push({ label: '脈拍 (bpm)', data: chartData.pulsePoints, borderColor: 'rgb(25, 135, 84)', backgroundColor: 'rgba(25, 135, 84, 0.4)', pointRadius: 5, pointHoverRadius: 8, yAxisID: 'y1' });
    } else {
        datasets.push({ label: '最高血圧 (mmHg)', data: chartData.systolic, borderColor: 'rgb(220, 53, 69)', backgroundColor: 'rgba(220, 53, 69, 0.1)', tension: 0.1, yAxisID: 'y' });
        datasets.push({ label: '最低血圧 (mmHg)', data: chartData.diastolic, borderColor: 'rgb(13, 110, 253)', backgroundColor: 'rgba(13, 110, 253, 0.1)', tension: 0.1, yAxisID: 'y' });
        datasets.push({ label: '脈拍 (bpm)', data: chartData.pulse, borderColor: 'rgb(25, 135, 84)', backgroundColor: 'rgba(25, 135, 84, 0.1)', tension: 0.1, yAxisID: 'y1' });
    }
    const showTarget = targetEnabled && (targetSys != null || targetDia != null) && viewMode === 'trend' && !isScatter;
    const labels = chartData.labels || [];
    if (showTarget && targetSys != null) datasets.push({ label: '目標(最高)', data: labels.map(() => targetSys), borderColor: 'rgba(220, 53, 69, 0.6)', borderDash: [5, 5], borderWidth: 1, pointRadius: 0, fill: false, yAxisID: 'y' });
    if (showTarget && targetDia != null) datasets.push({ label: '目標(最低)', data: labels.map(() => targetDia), borderColor: 'rgba(13, 110, 253, 0.6)', borderDash: [5, 5], borderWidth: 1, pointRadius: 0, fill: false, yAxisID: 'y' });
    return datasets;
}

function renderOrUpdateChart(chartData, state) {
    const canvas = document.getElementById('bpChart');
    if (!canvas) return;
    if (bpChartInstance) { bpChartInstance.destroy(); bpChartInstance = null; }
    const st = state || getGraphState();
    const chartType = st.chartType || 'line';
    const viewMode = st.viewMode || 'trend';
    let type = 'line';
    if (chartData.type === 'scatter') type = 'scatter';
    else if (chartType === 'bar' || viewMode === 'timeband' || viewMode === 'weekday') type = 'bar';
    const labels = chartData.labels || [];
    const datasets = buildChartDatasets(chartData, st);
    const pointCount = (chartData.systolic && chartData.systolic.length) || (chartData.sysPoints && chartData.sysPoints.length) || 0;
    const animThreshold = (typeof GRAPH_CONSTANTS !== 'undefined' && GRAPH_CONSTANTS.ANIMATION_THRESHOLD) ? GRAPH_CONSTANTS.ANIMATION_THRESHOLD : 200;
    const animDuration = pointCount > animThreshold ? 0 : 300;
    const Y_MARGIN = 20;
    let bpValues = chartData.type === 'scatter'
        ? [...(chartData.sysPoints || []).map(p => p.y), ...(chartData.diaPoints || []).map(p => p.y)].filter(v => v != null && !isNaN(v))
        : [...(chartData.systolic || []), ...(chartData.diastolic || [])].filter(v => v != null && !isNaN(v));
    if (st.targetEnabled && st.targetSys != null) bpValues = [...bpValues, st.targetSys];
    if (st.targetEnabled && st.targetDia != null) bpValues = [...bpValues, st.targetDia];
    const pulseValues = chartData.type === 'scatter'
        ? (chartData.pulsePoints || []).map(p => p.y).filter(v => v != null && !isNaN(v))
        : (chartData.pulse || []).filter(v => v != null && !isNaN(v));
    const bpMin = bpValues.length ? Math.min(...bpValues) - Y_MARGIN : undefined;
    const bpMax = bpValues.length ? Math.max(...bpValues) + Y_MARGIN : undefined;
    const pulseMin = pulseValues.length ? Math.min(...pulseValues) - Y_MARGIN : undefined;
    const pulseMax = pulseValues.length ? Math.max(...pulseValues) + Y_MARGIN : undefined;
    const ctx = canvas.getContext('2d');
    bpChartInstance = new Chart(ctx, {
        type,
        data: { labels, datasets },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: animDuration },
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: { display: true, position: 'bottom', labels: { usePointStyle: true, padding: 12, font: { size: 11 } } },
                tooltip: {
                    enabled: true,
                    backgroundColor: 'rgba(0, 0, 0, 0.85)',
                    padding: 10,
                    titleFont: { size: 12 },
                    bodyFont: { size: 11 },
                    callbacks: {
                        label: function(ctx) {
                            const d = ctx.raw;
                            if (d && typeof d === 'object' && d.label) return `${ctx.dataset.label}: ${ctx.parsed.y} (${d.label})`;
                            return `${ctx.dataset.label}: ${ctx.parsed.y}`;
                        }
                    }
                }
            },
            scales: {
                x: { display: true, title: { display: true, text: chartData.type === 'scatter' ? '日時' : (viewMode === 'timeband' ? '時間帯' : viewMode === 'weekday' ? '曜日' : '日付'), font: { size: 11 } }, grid: { display: false } },
                y: { type: 'linear', display: true, position: 'left', min: bpMin, max: bpMax, title: { display: true, text: '血圧 (mmHg)', font: { size: 11 } }, grid: { color: 'rgba(0, 0, 0, 0.08)' } },
                y1: { type: 'linear', display: true, position: 'right', min: pulseMin, max: pulseMax, title: { display: true, text: '脈拍 (bpm)', font: { size: 11 } }, grid: { drawOnChartArea: false } }
            }
        }
    });
}

function updateChartUIState(hasData, emptyMessage) {
    const chartContainer = document.getElementById('chartContainer');
    const emptyEl = document.getElementById('emptyChartMessage');
    if (!chartContainer || !emptyEl) return;
    if (hasData) {
        chartContainer.style.display = 'block';
        emptyEl.style.display = 'none';
    } else {
        chartContainer.style.display = 'none';
        emptyEl.style.display = 'block';
        emptyEl.innerHTML = emptyMessage || '<p>選択された期間の記録がありません</p><p class="chart-empty__hint">記録が追加されると、ここにグラフが表示されます</p>';
        if (bpChartInstance) { bpChartInstance.destroy(); bpChartInstance = null; }
    }
}

function renderStatsCards(stats, count) {
    const container = document.getElementById('statsCardsContainer');
    const grid = document.getElementById('statsCardsGrid');
    const emptyMsg = document.getElementById('statsEmptyMessage');
    const countEl = document.getElementById('statsRecordCount');
    if (!container || !grid) return;
    if (!stats || count === 0) {
        container.style.display = 'none';
        if (emptyMsg) emptyMsg.style.display = 'block';
        return;
    }
    if (emptyMsg) emptyMsg.style.display = 'none';
    container.style.display = 'block';
    if (countEl) countEl.textContent = `測定回数: n=${count}`;
    const round = (v) => (v != null && !isNaN(v)) ? Math.round(v) : '—';
    const cards = [
        { label: '最高血圧 平均', value: round(stats.systolic.avg), sub: stats.systolic.min != null ? `最小${stats.systolic.min} / 最大${stats.systolic.max}` : '' },
        { label: '最低血圧 平均', value: round(stats.diastolic.avg), sub: stats.diastolic.min != null ? `最小${stats.diastolic.min} / 最大${stats.diastolic.max}` : '' },
        { label: '脈拍 平均', value: round(stats.pulse.avg), sub: stats.pulse.min != null ? `最小${stats.pulse.min} / 最大${stats.pulse.max}` : '' },
        { label: '標準偏差(最高)', value: round(stats.systolic.std), sub: '母標準偏差' },
        { label: '標準偏差(最低)', value: round(stats.diastolic.std), sub: '母標準偏差' }
    ];
    grid.innerHTML = cards.map(c => `<div class="stats-card"><div class="stats-card__label">${c.label}</div><div class="stats-card__value">${c.value}</div>${c.sub ? `<div class="stats-card__sub">${c.sub}</div>` : ''}</div>`).join('');
}

function initGraphControls() {
    const stored = loadGraphStateFromStorage();
    const chartMemberFilter = document.getElementById('chartMemberFilter');
    if (chartMemberFilter) chartMemberFilter.addEventListener('change', () => { setGraphStateFromDOM(); renderAll(); });
    document.querySelectorAll('.chart-control__btn[data-range]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.chart-control__btn[data-range]').forEach(b => b.setAttribute('aria-pressed', 'false'));
            btn.setAttribute('aria-pressed', 'true');
            setGraphStateFromDOM();
            renderAll();
        });
    });
    document.querySelectorAll('.chart-control__btn[data-view]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.chart-control__btn[data-view]').forEach(b => b.setAttribute('aria-pressed', 'false'));
            btn.setAttribute('aria-pressed', 'true');
            updateChartTypeVisibility();
            setGraphStateFromDOM();
            renderAll();
        });
    });
    document.querySelectorAll('.chart-control__btn[data-type]').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.chart-control__btn[data-type]').forEach(b => b.setAttribute('aria-pressed', 'false'));
            btn.setAttribute('aria-pressed', 'true');
            setGraphStateFromDOM();
            renderAll();
        });
    });
    const targetEnabled = document.getElementById('targetEnabled');
    const targetSys = document.getElementById('targetSys');
    const targetDia = document.getElementById('targetDia');
    if (stored) {
        if (stored.rangeKey) {
            const rBtn = document.querySelector(`.chart-control__btn[data-range="${stored.rangeKey}"]`);
            if (rBtn) { document.querySelectorAll('.chart-control__btn[data-range]').forEach(b => b.setAttribute('aria-pressed', 'false')); rBtn.setAttribute('aria-pressed', 'true'); }
        }
        if (stored.viewMode) {
            const vBtn = document.querySelector(`.chart-control__btn[data-view="${stored.viewMode}"]`);
            if (vBtn) { document.querySelectorAll('.chart-control__btn[data-view]').forEach(b => b.setAttribute('aria-pressed', 'false')); vBtn.setAttribute('aria-pressed', 'true'); }
        }
        if (stored.chartType) {
            const tBtn = document.querySelector(`.chart-control__btn[data-type="${stored.chartType}"]`);
            if (tBtn) { document.querySelectorAll('.chart-control__btn[data-type]').forEach(b => b.setAttribute('aria-pressed', 'false')); tBtn.setAttribute('aria-pressed', 'true'); }
        }
        if (stored.targetEnabled && targetEnabled) targetEnabled.checked = true;
        if (stored.targetSys != null && targetSys) targetSys.value = String(stored.targetSys);
        if (stored.targetDia != null && targetDia) targetDia.value = String(stored.targetDia);
    }
    if (targetEnabled) targetEnabled.addEventListener('change', () => { setGraphStateFromDOM(); renderAll(); });
    if (targetSys) targetSys.addEventListener('change', () => {
        const sys = targetSys.value ? parseInt(targetSys.value, 10) : null;
        const dia = targetDia && targetDia.value ? parseInt(targetDia.value, 10) : null;
        if (sys != null && dia != null && sys <= dia) { showMessage('warn', '最高血圧は最低血圧より大きい値を入力してください'); return; }
        setGraphStateFromDOM();
        renderAll();
    });
    if (targetDia) targetDia.addEventListener('change', () => {
        const sys = targetSys && targetSys.value ? parseInt(targetSys.value, 10) : null;
        const dia = targetDia.value ? parseInt(targetDia.value, 10) : null;
        if (sys != null && dia != null && sys <= dia) { showMessage('warn', '最高血圧は最低血圧より大きい値を入力してください'); return; }
        setGraphStateFromDOM();
        renderAll();
    });
    updateChartTypeVisibility();
}

function updateChartTypeVisibility() {
    let isTrend = true;
    document.querySelectorAll('.chart-control__btn[data-view]').forEach(b => { if (b.getAttribute('aria-pressed') === 'true') isTrend = b.dataset.view === 'trend'; });
    const typeField = document.getElementById('chartTypeField');
    if (typeField) typeField.classList.toggle('chart-type-field--disabled', !isTrend);
}

function renderAll() {
    const allRecords = loadRecords();
    const state = setGraphStateFromDOM();
    const filtered = getFilteredRecords({ records: allRecords, memberId: state.memberId, rangeKey: state.rangeKey, now: new Date() });
    if (filtered.length === 0) {
        updateChartUIState(false, '<p>選択された期間の記録がありません</p><p class="chart-empty__hint">記録が追加されると、ここにグラフが表示されます</p>');
        renderStatsCards(null, 0);
        return;
    }
    let chartData;
    if (state.viewMode === 'timeband') chartData = transformTimeband(filtered);
    else if (state.viewMode === 'weekday') chartData = transformWeekday(filtered);
    else {
        if (state.chartType === 'scatter') {
            const maxDays = (typeof GRAPH_CONSTANTS !== 'undefined' && GRAPH_CONSTANTS.SCATTER_MAX_DAYS) ? GRAPH_CONSTANTS.SCATTER_MAX_DAYS : 90;
            const rangeDays = state.rangeKey === 'all' ? 365 : (GRAPH_CONSTANTS && GRAPH_CONSTANTS.RANGE_DAYS && GRAPH_CONSTANTS.RANGE_DAYS[state.rangeKey]) || 30;
            if (rangeDays > maxDays) {
                const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - maxDays);
                const limited = filtered.filter(r => { const t = r.measuredAt != null ? r.measuredAt : new Date(r.datetimeIso).getTime(); return t >= cutoff.getTime(); });
                chartData = transformTrendScatter(limited.length ? limited : filtered);
            } else chartData = transformTrendScatter(filtered);
        } else chartData = transformTrendLineBar(filtered);
    }
    updateChartUIState(true);
    renderOrUpdateChart(chartData, state);
    const stats = calcStats(filtered);
    renderStatsCards(stats, filtered.length);
}

function refreshChart() {
    renderAll();
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
        const ocrDebug = window.OCR && window.OCR.isDebugMode ? window.OCR.isDebugMode() : false;
        const ocrOptions = { debug: ocrDebug };
        if (imageIsGuideCropped && currentSelectedImage.width && currentSelectedImage.height) {
            ocrOptions.roi = { x: 0, y: 0, width: currentSelectedImage.width, height: currentSelectedImage.height };
        }
        const ocrRaw = await window.OCR.recognizeText(image, ocrOptions);

        if (imageToken !== token) {
            console.log('[OCR AutoRun] OCR完了したが画像が変わったため結果を破棄');
            return;
        }

        const elapsed = ocrRaw.totalElapsedMs || Math.round(performance.now() - startTime);
        console.log(`[OCR AutoRun] 認識完了 (${elapsed}ms, attempts=${ocrRaw.attempts ? ocrRaw.attempts.length : 1})`);

        const vitals = ocrRaw.vitals || window.OCR.extractVitalsFromOcr({ data: ocrRaw.data });
        console.log('[OCR AutoRun] 抽出結果:', {
            systolic: vitals.systolic,
            diastolic: vitals.diastolic,
            pulse: vitals.pulse,
            confidence: vitals.confidence,
            confidenceLevel: vitals.confidenceLevel,
            needsReview: vitals.needsReview,
            selectedAttempt: ocrRaw.selectedAttemptId
        });

        if (ocrDebug && ocrRaw.attempts) {
            renderOcrDebugPanel(ocrRaw);
        }

        // systolic・diastolic が両方 null の場合は失敗扱い
        if (vitals.systolic === null && vitals.diastolic === null) {
            ocrStatus = 'failed';
            var failCode = (ocrRaw.errorCode === 'TIMEOUT') ? 'TIMEOUT' : 'BP_PAIR_NOT_FOUND';
            ocrError  = { message: failCode === 'TIMEOUT' ? 'タイムアウトしました' : '血圧値を認識できませんでした', code: failCode };
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
                warnings:   vitals.warnings,
                needsReview:    vitals.needsReview,
                confidenceLevel: vitals.confidenceLevel
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

        // needsReview / 低信頼度なら再試行ボタンを表示しメッセージを変更
        const showReview = ocrResult && (ocrResult.needsReview || ocrResult.confidence < OCR_CONFIDENCE_MID);
        if (btnOcrRetry) {
            btnOcrRetry.style.display = showReview ? 'inline-block' : 'none';
            btnOcrRetry.disabled = ocrRetryCount >= OCR_RETRY_LIMIT;
        }

        const successMsg = document.getElementById('ocrBannerSuccessMsg');
        if (successMsg) {
            if (ocrResult && ocrResult.confidenceLevel === 'high' && !ocrResult.needsReview) {
                successMsg.textContent = '✓ 高信頼度で認識しました。確認してください';
            } else if (showReview) {
                successMsg.textContent = '! 信頼度が低い項目があります。内容を確認してください';
            } else {
                successMsg.textContent = '✓ 認識結果を確認してください';
            }
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
            if (ocrError.code === 'TIMEOUT') {
                failedMsg.textContent = '✕ 読み取りがタイムアウトしました。撮り直すか手動で入力してください';
            } else if (ocrError.code === 'BP_PAIR_NOT_FOUND') {
                failedMsg.textContent = '✕ 血圧値を認識できませんでした。手動で入力するか再試行してください';
            } else {
                failedMsg.textContent = '✕ 自動読み取りに失敗しました。手動で入力するか再試行してください';
            }
        }

        // 撮影ヒントを表示
        var OC_HINTS = window.OCR_CONSTANTS && window.OCR_CONSTANTS.CAPTURE_HINTS;
        if (OC_HINTS && OC_HINTS.length > 0) {
            var hintEl = document.getElementById('ocrCaptureHints');
            if (hintEl) {
                hintEl.textContent = OC_HINTS[Math.floor(Math.random() * OC_HINTS.length)];
                hintEl.style.display = 'block';
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

    ocrStatus          = 'idle';
    ocrResult          = null;
    ocrError           = null;
    ocrProgress        = null;
    ocrRetryCount      = 0;
    imageIsGuideCropped = false;

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

    hideOcrDebugPanel();
    renderOcrUI();
}

/**
 * OCR多重試行のデバッグパネルを描画
 * 目的: debug=1 のとき、各attemptの前処理画像・rawText・スコアを表示する
 * @param {Object} ocrRaw - recognizeText の返却オブジェクト
 */
function renderOcrDebugPanel(ocrRaw) {
    var panel = document.getElementById('ocrDebugPanel');
    var content = document.getElementById('ocrDebugContent');
    if (!panel || !content) return;

    content.innerHTML = '';

    var summary = document.createElement('div');
    summary.className = 'ocr-debug__summary';
    summary.textContent = '試行数: ' + ocrRaw.attempts.length +
        ' / 所要時間: ' + ocrRaw.totalElapsedMs + 'ms' +
        ' / 採用: ' + (ocrRaw.selectedAttemptId || '-') +
        (ocrRaw.errorCode ? ' / エラー: ' + ocrRaw.errorCode : '');
    content.appendChild(summary);

    ocrRaw.attempts.forEach(function(attempt) {
        var card = document.createElement('div');
        card.className = 'ocr-debug__attempt';
        if (attempt.id === ocrRaw.selectedAttemptId) {
            card.classList.add('ocr-debug__attempt--selected');
        }

        var header = document.createElement('div');
        header.className = 'ocr-debug__attempt-header';
        header.textContent = attempt.id +
            ' [score=' + (attempt.totalScore || 0) + ']' +
            (attempt.error ? ' ERROR: ' + attempt.error : '') +
            ' (' + (attempt.elapsedMs || 0) + 'ms)';
        card.appendChild(header);

        if (attempt.error) {
            content.appendChild(card);
            return;
        }

        if (attempt.debugCanvas && attempt.debugCanvas instanceof HTMLCanvasElement) {
            var thumb = document.createElement('canvas');
            var tw = Math.min(200, attempt.debugCanvas.width);
            var th = Math.round(tw * attempt.debugCanvas.height / attempt.debugCanvas.width);
            thumb.width = tw;
            thumb.height = th;
            thumb.getContext('2d').drawImage(attempt.debugCanvas, 0, 0, tw, th);
            thumb.className = 'ocr-debug__thumb';
            card.appendChild(thumb);
        }

        var details = document.createElement('div');
        details.className = 'ocr-debug__details';

        var rawLine = 'raw: "' + (attempt.rawText || '').substring(0, 80) + '"';
        var scoreLine = 'OCR conf=' + (attempt.confidence || 0).toFixed(0) +
            ' / extract=' + (attempt.scoreBreakdown ? attempt.scoreBreakdown.extractScore : '-') +
            ' / total=' + (attempt.totalScore || 0);
        var vitalsLine = attempt.vitals
            ? 'SYS=' + (attempt.vitals.systolic !== null ? attempt.vitals.systolic : '-') +
              ' DIA=' + (attempt.vitals.diastolic !== null ? attempt.vitals.diastolic : '-') +
              ' PUL=' + (attempt.vitals.pulse !== null ? attempt.vitals.pulse : '-') +
              ' level=' + (attempt.vitals.confidenceLevel || '-')
            : 'vitals: -';

        details.textContent = rawLine + '\n' + scoreLine + '\n' + vitalsLine;
        card.appendChild(details);

        content.appendChild(card);
    });

    // JSONダウンロードボタン
    var dlBtn = document.createElement('button');
    dlBtn.type = 'button';
    dlBtn.className = 'btn btn--secondary btn--small';
    dlBtn.textContent = 'ログをJSON保存';
    dlBtn.addEventListener('click', function() {
        var logData = {
            timestamp: new Date().toISOString(),
            selectedAttemptId: ocrRaw.selectedAttemptId,
            totalElapsedMs: ocrRaw.totalElapsedMs,
            errorCode: ocrRaw.errorCode,
            attempts: ocrRaw.attempts.map(function(a) {
                return {
                    id: a.id, preprocessName: a.preprocessName,
                    resolutionLevel: a.resolutionLevel, tesseract: a.tesseract,
                    rawText: a.rawText, confidence: a.confidence,
                    totalScore: a.totalScore, scoreBreakdown: a.scoreBreakdown,
                    vitals: a.vitals ? {
                        systolic: a.vitals.systolic, diastolic: a.vitals.diastolic,
                        pulse: a.vitals.pulse, confidence: a.vitals.confidence,
                        confidenceLevel: a.vitals.confidenceLevel, needsReview: a.vitals.needsReview
                    } : null,
                    elapsedMs: a.elapsedMs, error: a.error || null
                };
            })
        };
        var blob = new Blob([JSON.stringify(logData, null, 2)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'ocr-debug-' + Date.now() + '.json';
        a.click();
        URL.revokeObjectURL(url);
    });
    content.appendChild(dlBtn);

    panel.style.display = 'block';
}

/**
 * OCRデバッグパネルを非表示にする
 */
function hideOcrDebugPanel() {
    var panel = document.getElementById('ocrDebugPanel');
    if (panel) {
        panel.style.display = 'none';
        var content = document.getElementById('ocrDebugContent');
        if (content) content.innerHTML = '';
    }
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

