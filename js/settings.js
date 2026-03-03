/**
 * 通知設定モジュール（Phase 4 Step 4-4）
 * 目的: 設定の読み書き・UI⇄状態同期・localStorage永続化
 */

const NC = window.NOTIFICATION_CONSTANTS || {};

/**
 * デフォルト設定を返す
 * @returns {Object} 通知設定オブジェクト
 */
function getDefaultSettings() {
    return {
        schemaVersion: NC.SCHEMA_VERSION || 1,
        notificationEnabled: false,
        recordCompleteEnabled: true,
        morningTime: NC.DEFAULT_MORNING_TIME || '07:00',
        eveningTime: NC.DEFAULT_EVENING_TIME || '21:00',
        frequency: NC.FREQUENCY_DAILY || 'daily',
        lastReminderSent: { morning: null, evening: null },
        lastRecordCompleteNotifiedAt: null
    };
}

/**
 * localStorageから設定を読み込み
 * @returns {Object} 通知設定オブジェクト
 */
function loadNotificationSettings() {
    try {
        const json = localStorage.getItem(NC.STORAGE_KEY || 'bp_settings');
        if (!json) return getDefaultSettings();

        const data = JSON.parse(json);
        const defaults = getDefaultSettings();

        return {
            schemaVersion: data.schemaVersion ?? defaults.schemaVersion,
            notificationEnabled: Boolean(data.notificationEnabled),
            recordCompleteEnabled: data.recordCompleteEnabled !== false,
            morningTime: data.morningTime || defaults.morningTime,
            eveningTime: data.eveningTime || defaults.eveningTime,
            frequency: ['daily', 'weekdays', 'weekends'].includes(data.frequency)
                ? data.frequency
                : defaults.frequency,
            lastReminderSent: {
                morning: data.lastReminderSent?.morning ?? null,
                evening: data.lastReminderSent?.evening ?? null
            },
            lastRecordCompleteNotifiedAt: data.lastRecordCompleteNotifiedAt ?? null
        };
    } catch (e) {
        console.warn('[settings] 読み込みエラー:', e);
        return getDefaultSettings();
    }
}

/**
 * 設定をlocalStorageに保存
 * @param {Object} settings - 通知設定オブジェクト
 * @returns {boolean} 保存成功ならtrue
 */
function saveNotificationSettings(settings) {
    try {
        localStorage.setItem(NC.STORAGE_KEY || 'bp_settings', JSON.stringify(settings));
        return true;
    } catch (e) {
        console.warn('[settings] 保存エラー:', e);
        return false;
    }
}

/**
 * 設定UIを初期化し、イベントを紐付ける
 * @param {Function} onSettingsChange - 設定変更時のコールバック（reschedule用）
 * @param {Function} onPermissionRequest - 通知ON時に許可要求するコールバック
 */
function initNotificationSettingsUI(onSettingsChange, onPermissionRequest) {
    const toggleEl = document.getElementById('notificationToggle');
    const morningInput = document.getElementById('notificationMorningTime');
    const eveningInput = document.getElementById('notificationEveningTime');
    const frequencySelect = document.getElementById('notificationFrequency');
    const helpBlock = document.getElementById('notificationHelp');

    if (!toggleEl) return;

    const settings = loadNotificationSettings();
    applySettingsToUI(settings);

    toggleEl.addEventListener('change', async (e) => {
        const checked = e.target.checked;
        if (checked) {
            const granted = await onPermissionRequest();
            if (!granted) {
                toggleEl.checked = false;
                if (helpBlock) helpBlock.classList.add('notification-help--visible');
                return;
            }
            if (helpBlock) helpBlock.classList.remove('notification-help--visible');
        }

        const next = loadNotificationSettings();
        next.notificationEnabled = checked;
        saveNotificationSettings(next);
        onSettingsChange();
    });

    if (morningInput) {
        morningInput.addEventListener('change', () => {
            const next = loadNotificationSettings();
            next.morningTime = morningInput.value || NC.DEFAULT_MORNING_TIME;
            saveNotificationSettings(next);
            onSettingsChange();
        });
    }
    if (eveningInput) {
        eveningInput.addEventListener('change', () => {
            const next = loadNotificationSettings();
            next.eveningTime = eveningInput.value || NC.DEFAULT_EVENING_TIME;
            saveNotificationSettings(next);
            onSettingsChange();
        });
    }
    if (frequencySelect) {
        frequencySelect.addEventListener('change', () => {
            const next = loadNotificationSettings();
            next.frequency = frequencySelect.value || NC.FREQUENCY_DAILY;
            saveNotificationSettings(next);
            onSettingsChange();
        });
    }
}

/**
 * 設定をUIに反映
 * @param {Object} settings - 通知設定オブジェクト
 */
function applySettingsToUI(settings) {
    const toggleEl = document.getElementById('notificationToggle');
    const morningInput = document.getElementById('notificationMorningTime');
    const eveningInput = document.getElementById('notificationEveningTime');
    const frequencySelect = document.getElementById('notificationFrequency');

    if (toggleEl) {
        toggleEl.checked = settings.notificationEnabled;
        toggleEl.setAttribute('aria-checked', String(settings.notificationEnabled));
    }
    if (morningInput) morningInput.value = settings.morningTime;
    if (eveningInput) eveningInput.value = settings.eveningTime;
    if (frequencySelect) frequencySelect.value = settings.frequency;
}

/**
 * 記録完了通知の送信済み時刻を更新
 * @param {number} timestamp - ミリ秒
 */
function setLastRecordCompleteNotifiedAt(timestamp) {
    const s = loadNotificationSettings();
    s.lastRecordCompleteNotifiedAt = timestamp;
    saveNotificationSettings(s);
}

/**
 * リマインダー送信済み日を更新
 * @param {'morning'|'evening'} slot - 朝 or 夜
 * @param {string} dateStr - YYYY-MM-DD
 */
function setLastReminderSent(slot, dateStr) {
    const s = loadNotificationSettings();
    if (!s.lastReminderSent) s.lastReminderSent = { morning: null, evening: null };
    s.lastReminderSent[slot] = dateStr;
    saveNotificationSettings(s);
}

window.loadNotificationSettings = loadNotificationSettings;
window.saveNotificationSettings = saveNotificationSettings;
window.setLastRecordCompleteNotifiedAt = setLastRecordCompleteNotifiedAt;
window.setLastReminderSent = setLastReminderSent;
window.initNotificationSettingsUI = initNotificationSettingsUI;
