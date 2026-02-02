/**
 * Google Sheets API 連携モジュール
 * 目的: Google Apps Script（Webアプリ）経由で Google スプレッドシートへの読み書きを行う
 * 副作用: fetch による外部通信
 */

/* =========================================
   設定・定数
   ========================================= */

// Google Apps Script WebアプリのURL（デプロイ後のURLに差し替えてください）
const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxbdiZ_DBHDcS5ga00CKxLewDcDNE3Nlasd9XOTYrX7kH6yxAFxJ9al9_ctL9PtSLjB/exec';

// リクエストタイムアウト（ミリ秒）
const REQUEST_TIMEOUT_MS = 15000; // 15秒

// （任意）簡易認証トークン（使用する場合はGAS側でも検証が必要）
// const API_TOKEN = 'your-secret-token-here';

/* =========================================
   内部ユーティリティ
   ========================================= */

/**
 * fetch にタイムアウトを設定して実行
 * @param {string} url - リクエスト先URL
 * @param {Object} options - fetch オプション
 * @param {number} timeoutMs - タイムアウト（ミリ秒）
 * @returns {Promise<Response>} fetch レスポンス
 * @throws {Error} タイムアウト or ネットワークエラー
 */
async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    
    try {
        const response = await fetch(url, {
            ...options,
            signal: controller.signal
        });
        clearTimeout(timeoutId);
        return response;
    } catch (error) {
        clearTimeout(timeoutId);
        
        // AbortError はタイムアウト扱い
        if (error.name === 'AbortError') {
            throw new Error('リクエストがタイムアウトしました');
        }
        
        // その他のネットワークエラー（オフライン等）
        throw new Error('ネットワークエラー：オンライン状態を確認してください');
    }
}

/**
 * SCRIPT_URL が設定されているかチェック
 * @throws {Error} 未設定の場合
 */
function checkScriptUrl() {
    if (!SCRIPT_URL || SCRIPT_URL.includes('YOUR_SCRIPT_URL_HERE')) {
        throw new Error('SCRIPT_URL が設定されていません。js/sheets-api.js で Google Apps Script WebアプリのURLを設定してください。');
    }
}

/* =========================================
   公開API
   ========================================= */

/**
 * 記録を Google Sheets に保存（GET経由、CORS回避のため）
 * @param {Object} record - 保存するレコード（id, datetime, member, systolic, diastolic, pulse を含む）
 * @returns {Promise<Object>} { ok: boolean, message?: string, error?: string }
 */
async function saveToSheets(record) {
    try {
        // URL設定チェック
        checkScriptUrl();
        
        // URLパラメータとして送信（CORS問題を回避）
        const params = new URLSearchParams({
            action: 'save',
            id: record.id,
            datetime: record.datetimeIso,
            member: record.member,
            systolic: record.systolic,
            diastolic: record.diastolic,
            pulse: record.pulse
        });
        
        const url = `${SCRIPT_URL}?${params.toString()}`;
        
        console.log('[sheets-api] GET 保存開始:', { id: record.id, datetime: record.datetimeIso });
        
        // GET リクエスト
        const response = await fetchWithTimeout(
            url,
            {
                method: 'GET',
                mode: 'no-cors',
                cache: 'no-cache'
            },
            REQUEST_TIMEOUT_MS
        );
        
        console.log('[sheets-api] レスポンス受信:', response.status, response.type);
        
        // no-cors モードの場合、レスポンスの詳細は読み取れない
        // opaque レスポンスの場合は成功と見なす
        if (response.type === 'opaque') {
            console.log('[sheets-api] no-cors モードで送信完了（レスポンス詳細不明）');
            return {
                ok: true,
                message: 'データを送信しました'
            };
        }
        
        // HTTP ステータスチェック
        if (!response.ok) {
            throw new Error(`HTTP エラー: ${response.status} ${response.statusText}`);
        }
        
        // JSON パース
        let result;
        try {
            result = await response.json();
        } catch (parseError) {
            console.warn('[sheets-api] JSON パース不可（no-corsの可能性）');
            // no-cors の場合、パースできないが送信は成功している
            return {
                ok: true,
                message: 'データを送信しました'
            };
        }
        
        console.log('[sheets-api] レスポンスボディ:', result);
        
        // アプリ層のステータス確認
        if (result.status === 'success') {
            return {
                ok: true,
                message: result.message || '保存に成功しました'
            };
        } else {
            return {
                ok: false,
                error: result.message || 'サーバー側でエラーが発生しました',
                detail: result.detail
            };
        }
        
    } catch (error) {
        console.error('[sheets-api] 保存エラー:', error);
        
        return {
            ok: false,
            error: error.message || '不明なエラーが発生しました'
        };
    }
}

/**
 * Google Sheets からデータを取得（GET）
 * 目的: デバッグ/同期基盤として使用（日常的な呼び出しは非推奨）
 * @returns {Promise<Object>} { ok: boolean, data?: Array, error?: string }
 */
async function getFromSheets() {
    try {
        // URL設定チェック
        checkScriptUrl();
        
        console.log('[sheets-api] GET データ取得開始');
        
        // action=get パラメータを追加（省略可能だが明示的に指定）
        const url = `${SCRIPT_URL}?action=get`;
        
        // GET リクエスト
        const response = await fetchWithTimeout(
            url,
            {
                method: 'GET',
                mode: 'cors',
                cache: 'no-cache'
            },
            REQUEST_TIMEOUT_MS
        );
        
        console.log('[sheets-api] レスポンス受信:', response.status);
        
        // HTTP ステータスチェック
        if (!response.ok) {
            throw new Error(`HTTP エラー: ${response.status} ${response.statusText}`);
        }
        
        // JSON パース
        let data;
        try {
            data = await response.json();
        } catch (parseError) {
            console.error('[sheets-api] JSON パースエラー:', parseError);
            throw new Error('サーバーからの応答が不正です（JSON パース失敗）');
        }
        
        console.log('[sheets-api] 取得件数:', Array.isArray(data) ? data.length : '不明');
        
        // 配列として返す（GAS 側の実装に依存）
        return {
            ok: true,
            data: Array.isArray(data) ? data : []
        };
        
    } catch (error) {
        console.error('[sheets-api] 取得エラー:', error);
        
        return {
            ok: false,
            error: error.message || '不明なエラーが発生しました'
        };
    }
}
