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
    
    // オフライン検知の初期化
    initOfflineDetection();
    
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
 * クリアボタン処理（フォームリセット＋日時再セット＋メッセージクリア＋フォーカス戻し）
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
   Chart.js グラフ表示（過去7日分の血圧推移）
   ========================================= */

/**
 * 過去7日分のレコードを抽出（今日を含む直近7日）
 * @param {Array} records - 全レコード配列
 * @returns {Array} 7日範囲内のレコード
 */
function extractLast7DaysRecords(records) {
    // 今日の0:00を基準とする
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startDate = new Date(today);
    startDate.setDate(startDate.getDate() - (CHART_DAYS - 1));
    
    return records.filter(record => {
        if (!record.datetimeIso) return false;
        const recordDate = new Date(record.datetimeIso);
        return recordDate >= startDate && recordDate <= now;
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
    
    // 過去7日分を抽出
    const last7Days = extractLast7DaysRecords(filtered);
    
    // データがない場合は空表示
    if (last7Days.length === 0) {
        updateChartUIState(false);
        return;
    }
    
    // 日付ごとにグループ化して平均化
    const grouped = groupAndAverageByDate(last7Days);
    
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
