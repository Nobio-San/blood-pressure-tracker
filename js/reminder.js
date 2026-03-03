/**
 * リマインダースケジューラ（Phase 4 Step 4-4）
 * 目的: 次回時刻計算、setTimeout予約、二重通知防止
 */

const NC = window.NOTIFICATION_CONSTANTS || {};

let reminderTimeoutId = null;

/**
 * HH:mm を今日のDateに変換
 * @param {string} timeStr - "07:00" 形式
 * @param {Date} base - 基準日
 * @returns {Date}
 */
function parseTimeToDate(timeStr, base) {
    const [h, m] = (timeStr || '07:00').split(':').map(Number);
    const d = new Date(base);
    d.setHours(h || 0, m || 0, 0, 0);
    return d;
}

/**
 * 頻度に該当する日かどうか
 * @param {Date} date
 * @param {string} frequency - 'daily'|'weekdays'|'weekends'
 * @returns {boolean}
 */
function isTargetDay(date, frequency) {
    if (frequency === 'daily') return true;
    const dow = date.getDay();
    if (frequency === 'weekdays') return dow >= 1 && dow <= 5;
    if (frequency === 'weekends') return dow === 0 || dow === 6;
    return true;
}

/**
 * YYYY-MM-DD 形式で日付を返す
 * @param {Date} d
 * @returns {string}
 */
function toDateString(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

/**
 * 次回リマインダー時刻を計算（純粋関数）
 * @param {Date} now - 現在日時
 * @param {string} morningTime - "07:00"
 * @param {string} eveningTime - "21:00"
 * @param {Object} lastReminderSent - { morning: "YYYY-MM-DD"|null, evening: "YYYY-MM-DD"|null }
 * @param {string} frequency - 'daily'|'weekdays'|'weekends'
 * @returns {{ next: Date|null, slot: 'morning'|'evening'|null }}
 */
function getNextReminderTime(now, morningTime, eveningTime, lastReminderSent, frequency) {
    const today = toDateString(now);
    const morningDate = parseTimeToDate(morningTime, now);
    const eveningDate = parseTimeToDate(eveningTime, now);

    if (eveningDate <= morningDate) {
        eveningDate.setDate(eveningDate.getDate() + 1);
    }

    const sentMorning = lastReminderSent?.morning === today;
    const sentEvening = lastReminderSent?.evening === today;

    const candidates = [];

    if (!sentMorning && isTargetDay(now, frequency)) {
        if (morningDate > now) {
            candidates.push({ next: morningDate, slot: 'morning' });
        }
    }
    if (!sentEvening && isTargetDay(now, frequency)) {
        if (eveningDate > now) {
            candidates.push({ next: eveningDate, slot: 'evening' });
        }
    }

    if (candidates.length === 0) {
        const tomorrow = new Date(now);
        tomorrow.setDate(tomorrow.getDate() + 1);
        const tomorrowStr = toDateString(tomorrow);
        const morningTomorrow = parseTimeToDate(morningTime, tomorrow);
        const eveningTomorrow = parseTimeToDate(eveningTime, tomorrow);
        if (eveningTomorrow <= morningTomorrow) {
            eveningTomorrow.setDate(eveningTomorrow.getDate() + 1);
        }

        if (!sentMorning && !sentEvening) {
            if (morningDate > now && isTargetDay(now, frequency)) {
                return { next: morningDate, slot: 'morning' };
            }
            if (eveningDate > now && isTargetDay(now, frequency)) {
                return { next: eveningDate, slot: 'evening' };
            }
        }

        if (isTargetDay(tomorrow, frequency)) {
            return { next: morningTomorrow, slot: 'morning' };
        }
        let d = new Date(tomorrow);
        for (let i = 0; i < 7; i++) {
            if (isTargetDay(d, frequency)) {
                return { next: parseTimeToDate(morningTime, d), slot: 'morning' };
            }
            d.setDate(d.getDate() + 1);
        }
        return { next: null, slot: null };
    }

    candidates.sort((a, b) => a.next.getTime() - b.next.getTime());
    return candidates[0];
}

/**
 * リマインダーをスケジュール（既存予約を解除して再計算）
 */
function rescheduleReminder() {
    if (reminderTimeoutId) {
        clearTimeout(reminderTimeoutId);
        reminderTimeoutId = null;
    }

    const settings = typeof window.loadNotificationSettings === 'function'
        ? window.loadNotificationSettings()
        : null;
    if (!settings || !settings.notificationEnabled) return;

    if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') return;

    const now = new Date();
    const { next, slot } = getNextReminderTime(
        now,
        settings.morningTime,
        settings.eveningTime,
        settings.lastReminderSent,
        settings.frequency
    );

    if (!next || !slot) return;

    const delay = Math.max(0, next.getTime() - now.getTime());

    reminderTimeoutId = setTimeout(async () => {
        reminderTimeoutId = null;
        const s = typeof window.loadNotificationSettings === 'function'
            ? window.loadNotificationSettings()
            : null;
        if (!s || !s.notificationEnabled) return;

        const today = toDateString(new Date());
        if (typeof window.showReminderNotification === 'function') {
            await window.showReminderNotification(slot);
        }
        if (typeof window.setLastReminderSent === 'function') {
            window.setLastReminderSent(slot, today);
        }
        rescheduleReminder();
    }, delay);
}

/**
 * 起動時に未送信のリマインダーがあればフォールバック通知を表示
 */
async function checkReminderFallbackOnStartup() {
    const settings = typeof window.loadNotificationSettings === 'function'
        ? window.loadNotificationSettings()
        : null;
    if (!settings || !settings.notificationEnabled) return;
    if (typeof Notification !== 'undefined' && Notification.permission !== 'granted') return;

    const now = new Date();
    const today = toDateString(now);
    const sentMorning = settings.lastReminderSent?.morning === today;
    const sentEvening = settings.lastReminderSent?.evening === today;

    const morningDate = parseTimeToDate(settings.morningTime, now);
    const eveningDate = parseTimeToDate(settings.eveningTime, now);
    if (eveningDate <= morningDate) {
        eveningDate.setDate(eveningDate.getDate() + 1);
    }

    const morningPassed = now > morningDate && !sentMorning && isTargetDay(now, settings.frequency);
    const eveningPassed = now > eveningDate && !sentEvening && isTargetDay(now, settings.frequency);

    if (morningPassed || eveningPassed) {
        if (typeof window.showReminderFallbackNotification === 'function') {
            await window.showReminderFallbackNotification();
        }
    }
}

window.getNextReminderTime = getNextReminderTime;
window.rescheduleReminder = rescheduleReminder;
window.checkReminderFallbackOnStartup = checkReminderFallbackOnStartup;
