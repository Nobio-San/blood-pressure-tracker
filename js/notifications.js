/**
 * 通知モジュール（Phase 4 Step 4-4）
 * 目的: 通知表示（SW経由）、許可状態判定、フォールバック
 */

const NC = window.NOTIFICATION_CONSTANTS || {};

/**
 * 通知が利用可能かどうかを判定
 * @returns {boolean}
 */
function isNotificationSupported() {
    return typeof Notification !== 'undefined';
}

/**
 * 現在の通知許可状態を取得
 * @returns {'granted'|'denied'|'default'}
 */
function getNotificationPermission() {
    if (!isNotificationSupported()) return 'denied';
    return Notification.permission;
}

/**
 * 通知許可を要求する（ユーザー操作イベント内で呼ぶこと）
 * @returns {Promise<boolean>} 許可されたらtrue
 */
async function requestNotificationPermission() {
    if (!isNotificationSupported()) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;

    try {
        const result = await Notification.requestPermission();
        return result === 'granted';
    } catch (e) {
        console.warn('[notifications] 許可要求エラー:', e);
        return false;
    }
}

/**
 * 記録完了通知を表示（許可済みかつ設定ONの場合）
 * @param {Object} settings - loadNotificationSettings() の戻り値
 * @returns {Promise<boolean>} 通知を表示したらtrue
 */
async function showRecordCompleteNotification(settings) {
    if (!settings.notificationEnabled || !settings.recordCompleteEnabled) return false;
    if (getNotificationPermission() !== 'granted') return false;

    const suppressMs = NC.RECORD_COMPLETE_SUPPRESS_MS || 60000;
    const now = Date.now();
    if (settings.lastRecordCompleteNotifiedAt && (now - settings.lastRecordCompleteNotifiedAt) < suppressMs) {
        return false;
    }

    try {
        const reg = await navigator.serviceWorker?.ready;
        if (!reg) return false;

        await reg.showNotification(NC.TITLE_RECORD_COMPLETE || '記録が保存されました', {
            body: NC.BODY_RECORD_COMPLETE || '血圧の記録を保存しました',
            icon: './icons/icon-192.png',
            tag: 'record-complete',
            requireInteraction: false,
            data: { type: 'record-complete' }
        });

        if (typeof window.setLastRecordCompleteNotifiedAt === 'function') {
            window.setLastRecordCompleteNotifiedAt(now);
        }
        return true;
    } catch (e) {
        console.warn('[notifications] 記録完了通知エラー:', e);
        return false;
    }
}

/**
 * リマインダー通知を表示（SW経由）
 * @param {'morning'|'evening'} slot - 朝 or 夜
 * @returns {Promise<boolean>}
 */
async function showReminderNotification(slot) {
    if (getNotificationPermission() !== 'granted') return false;

    const title = NC.TITLE_REMINDER || '測定の時間です';
    const body = slot === 'morning'
        ? (NC.BODY_REMINDER_MORNING || '朝の血圧測定をお忘れなく')
        : (NC.BODY_REMINDER_EVENING || '夜の血圧測定をお忘れなく');

    try {
        const reg = await navigator.serviceWorker?.ready;
        if (!reg) return false;

        await reg.showNotification(title, {
            body,
            icon: './icons/icon-192.png',
            tag: `reminder-${slot}`,
            requireInteraction: false,
            data: { type: 'reminder', slot }
        });
        return true;
    } catch (e) {
        console.warn('[notifications] リマインダー通知エラー:', e);
        return false;
    }
}

/**
 * フォールバック用のリマインダー通知（次回起動時用）
 * @returns {Promise<boolean>}
 */
async function showReminderFallbackNotification() {
    if (getNotificationPermission() !== 'granted') return false;

    const title = NC.TITLE_REMINDER_FALLBACK || '血圧測定のリマインド';
    const body = NC.BODY_REMINDER_FALLBACK || '測定時刻を過ぎています。血圧を記録しましょう';

    try {
        const reg = await navigator.serviceWorker?.ready;
        if (!reg) return false;

        await reg.showNotification(title, {
            body,
            icon: './icons/icon-192.png',
            tag: 'reminder-fallback',
            requireInteraction: false,
            data: { type: 'reminder-fallback' }
        });
        return true;
    } catch (e) {
        console.warn('[notifications] フォールバック通知エラー:', e);
        return false;
    }
}

window.requestNotificationPermission = requestNotificationPermission;
window.showRecordCompleteNotification = showRecordCompleteNotification;
window.showReminderNotification = showReminderNotification;
window.showReminderFallbackNotification = showReminderFallbackNotification;
