# Blood Pressure Tracker

## 概要
血圧記録アプリ（Blood Pressure Tracker）は、日々の血圧を簡単に記録・管理できるWebアプリケーションです。

## 目的と機能
このアプリは以下の目的で開発されています：
- 血圧データの記録と管理
- 記録データの可視化
- 健康管理のサポート

### 現在の実装状況（Phase1 Step1-9）
- ✅ 基本的なファイル構造の構築
- ✅ HTML/CSS/JavaScriptの土台の準備
- ✅ レスポンシブデザインの基本設定
- ✅ 入力フォームUI作成
- ✅ ローカルストレージでのデータ保存
- ✅ 記録一覧表示機能
- ✅ Google Sheets API連携（クラウド同期）
- ✅ 基本グラフ表示機能（過去7日分の血圧推移）
- ✅ PWA対応（インストール可能・オフライン動作）

## 使用技術
- **HTML5**: セマンティックなマークアップ
- **CSS3**: モバイルファーストのレスポンシブデザイン
- **JavaScript (ES6+)**: ブラウザネイティブのJavaScript
- **localStorage**: オフライン対応のローカルデータ保存
- **Google Apps Script**: スプレッドシート連携（Webアプリ経由）
- **Chart.js**: 血圧推移グラフの描画
- **PWA (Progressive Web App)**: オフライン動作・インストール機能

## セットアップ方法

### 必要な環境
- モダンなWebブラウザ（Chrome、Firefox、Safari、Edgeなど）

### 起動手順
1. このリポジトリをクローンまたはダウンロード
2. `index.html` をWebブラウザで開く
3. ブラウザのコンソール（開発者ツール）で初期化メッセージを確認

### 開発環境での確認
```bash
# シンプルなHTTPサーバーを起動する場合（オプション）
# Python 3の場合
python -m http.server 8000

# Node.jsのhttp-serverを使用する場合
npx http-server
```

ブラウザで `http://localhost:8000` にアクセス

## プロジェクト構造
```
blood-pressure-tracker/
├── index.html              # メインHTMLファイル
├── manifest.json           # PWAマニフェスト（アプリ情報・アイコン定義）
├── service-worker.js       # Service Worker（オフライン動作）
├── css/
│   └── style.css          # スタイルシート
├── js/
│   ├── app.js             # メインアプリケーションロジック
│   └── sheets-api.js      # Google Sheets API連携モジュール
├── icons/                  # PWAアイコン
│   ├── icon-192.png       # 192x192 アイコン
│   ├── icon-512.png       # 512x512 アイコン
│   └── apple-touch-icon.png # iOS用アイコン（180x180）
├── README.md              # プロジェクト説明（このファイル）
└── .gitignore             # Git除外設定
```

## Google Sheets 連携の設定

### 前提条件
1. Google アカウント
2. Google スプレッドシートの作成
3. Google Apps Script（GAS）の設定とデプロイ

### 設定手順

#### 1. スプレッドシートの準備
1. Google スプレッドシートを新規作成
2. シート名を「血圧記録」に変更
3. 1行目に以下のヘッダーを設定：
   ```
   ID | 日時 | メンバー | 最高血圧 | 最低血圧 | 脈拍
   ```

#### 2. Google Apps Script の設定
1. スプレッドシートで「拡張機能」→「Apps Script」を開く
2. 以下のコードを貼り付け：

```javascript
// doPost: データを受信してシートに追記
function doPost(e) {
  try {
    const data = JSON.parse(e.postData.contents);
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('血圧記録');
    
    if (!sheet) {
      return ContentService.createTextOutput(JSON.stringify({
        status: 'error',
        message: 'シート「血圧記録」が見つかりません'
      })).setMimeType(ContentService.MimeType.JSON);
    }
    
    // 重複チェック（任意）
    const existingData = sheet.getDataRange().getValues();
    for (let i = 1; i < existingData.length; i++) {
      if (existingData[i][0] === data.id) {
        return ContentService.createTextOutput(JSON.stringify({
          status: 'success',
          message: '既に登録済みです'
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }
    
    // データを追記
    sheet.appendRow([
      data.id,
      data.datetime,
      data.member,
      data.systolic,
      data.diastolic,
      data.pulse
    ]);
    
    return ContentService.createTextOutput(JSON.stringify({
      status: 'success',
      message: 'データを保存しました'
    })).setMimeType(ContentService.MimeType.JSON);
    
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify({
      status: 'error',
      message: 'エラーが発生しました',
      detail: error.toString()
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

// doGet: データを取得
function doGet(e) {
  try {
    const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('血圧記録');
    
    if (!sheet) {
      return ContentService.createTextOutput(JSON.stringify([]))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    const data = sheet.getDataRange().getValues();
    const headers = data[0];
    const rows = data.slice(1);
    
    const result = rows.map(row => {
      const obj = {};
      headers.forEach((header, index) => {
        obj[header] = row[index];
      });
      return obj;
    });
    
    return ContentService.createTextOutput(JSON.stringify(result))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (error) {
    return ContentService.createTextOutput(JSON.stringify([]))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
```

3. 「デプロイ」→「新しいデプロイ」を選択
4. 種類：「ウェブアプリ」を選択
5. 設定：
   - 説明: 任意（例：血圧記録API）
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**（注：家族内共有の場合）
6. 「デプロイ」をクリック
7. **WebアプリのURL** をコピー（例：`https://script.google.com/macros/s/...../exec`）

#### 3. アプリ側の設定
1. `js/sheets-api.js` を開く
2. 冒頭の `SCRIPT_URL` に、コピーしたWebアプリのURLを設定：

```javascript
const SCRIPT_URL = 'https://script.google.com/macros/s/YOUR_SCRIPT_ID/exec';
```

3. ファイルを保存

### 動作確認
1. アプリを開いて血圧を記録
2. 「ローカルに保存し、クラウドに同期しました」と表示されることを確認
3. Google スプレッドシートに1行追加されていることを確認
4. オフライン状態で記録し、「未同期を再送」ボタンが表示されることを確認
5. オンライン復帰後に「未同期を再送」ボタンをクリックし、同期されることを確認

## トラブルシュート

### 同期が失敗する場合

#### 1. ネットワークエラー
- **症状**: 「ネットワークエラー：オンライン状態を確認してください」
- **対処**: 
  - インターネット接続を確認
  - ブラウザがオフラインモードになっていないか確認
  - ローカルには保存されているため、後で「未同期を再送」で同期可能

#### 2. URLが未設定
- **症状**: 「SCRIPT_URL が設定されていません」
- **対処**: 
  - `js/sheets-api.js` の `SCRIPT_URL` を確認
  - Google Apps Script のWebアプリURLが正しく設定されているか確認

#### 3. CORS エラー
- **症状**: ブラウザコンソールに「CORS policy」エラー
- **対処**: 
  - Google Apps Script のデプロイ設定を確認
  - 「アクセスできるユーザー」が「全員」になっているか確認
  - 古いデプロイを削除し、新しくデプロイし直す

#### 4. HTTPエラー（401/403）
- **症状**: 「HTTP エラー: 401」または「403」
- **対処**: 
  - Google Apps Script の「次のユーザーとして実行」が「自分」になっているか確認
  - スプレッドシートへのアクセス権限を確認

#### 5. シートが見つからない
- **症状**: 「シート『血圧記録』が見つかりません」
- **対処**: 
  - スプレッドシートのシート名が「血圧記録」になっているか確認（全角）
  - シート名のタブをダブルクリックして確認

#### 6. データ形式エラー
- **症状**: 「サーバーからの応答が不正です」
- **対処**: 
  - Google Apps Script のコードが正しく保存されているか確認
  - GAS エディタの「実行ログ」でエラー内容を確認
  - ヘッダー行のスペルミスがないか確認

### デバッグ方法
1. **ブラウザの開発者ツール**を開く（F12キー）
2. **Console** タブでエラーメッセージを確認
3. **Network** タブで以下を確認：
   - リクエストが送信されているか
   - ステータスコード（200が正常）
   - レスポンスの内容
4. **Google Apps Script** 側：
   - GASエディタの「実行」→「実行ログを表示」でサーバー側のログを確認

## PWA（Progressive Web App）機能

### PWAとは
このアプリはPWA（Progressive Web App）として実装されており、以下の機能が利用できます：
- **インストール可能**: スマートフォンやPCのホーム画面に追加して、ネイティブアプリのように使用できます
- **オフライン動作**: インターネット接続がなくても、アプリの起動・データの閲覧・新規入力が可能です
- **高速起動**: キャッシュされたリソースにより、起動が高速になります

### インストール方法

#### Android（Chrome）
1. Chrome で本アプリを開く
2. アドレスバー右上のメニュー（⋮）→「ホーム画面に追加」または「アプリをインストール」を選択
3. ホーム画面にアイコンが追加されます
4. アイコンをタップすると、スタンドアロンモード（ブラウザのUIなし）で起動します

#### iOS（Safari）
1. Safari で本アプリを開く
2. 画面下部の「共有」ボタン（□↑）をタップ
3. 「ホーム画面に追加」を選択
4. 「追加」をタップ
5. ホーム画面にアイコンが追加されます

#### PC（Chrome/Edge）
1. Chrome または Edge で本アプリを開く
2. アドレスバー右側の「インストール」アイコン（⊕）をクリック
3. 「インストール」をクリック
4. デスクトップアプリとして起動できます

### オフライン機能

#### 利用可能な機能
- アプリの起動と表示
- 新規データの入力・保存（ローカルストレージ）
- 過去の記録の閲覧
- グラフ表示（ローカルデータ）
- データの削除

#### 制限される機能
- Google Sheets への同期（インターネット接続が必要）
- Chart.js の初回読み込み（CDN依存のため）

#### オフライン時の挙動
1. オフライン時に新規データを入力すると、ローカルストレージに保存されます
2. 画面上部に「⚠️ オフラインモード」のバナーが表示されます
3. Google Sheets への同期は失敗しますが、「未同期」として記録されます
4. インターネット接続が回復したら、「未同期を再送」ボタンから手動で同期できます

### PWA技術仕様（開発者向け）

#### 配信パスとスコープ
- **配信形式**: ドメイン直下またはサブパス配信の両方に対応
- **start_url**: `./` （相対パス）
- **scope**: `./` （Service Workerの制御範囲）
- **Service Worker配置**: プロジェクトルート直下（`service-worker.js`）

#### キャッシュ戦略
- **キャッシュ名**: `bp-cache-v1` （バージョン管理用）
- **プリキャッシュ対象**:
  - `index.html`
  - `css/style.css`
  - `js/app.js`
  - `js/sheets-api.js`
  - `manifest.json`
  - アイコン（192/512/apple-touch-icon）

- **キャッシュ戦略**:
  - 静的アセット（HTML/CSS/JS/画像）: **Cache First**（キャッシュ→ネットワーク→保存）
  - CDN（Chart.js）: **Network First**（ネットワーク→キャッシュフォールバック）
  - 外部API（Google Apps Script）: **Network Only**（キャッシュ対象外）

#### Service Worker更新手順
1. `service-worker.js` を編集
2. キャッシュ名のバージョンを上げる（例：`v1` → `v2`）
   ```javascript
   const CACHE_VERSION = 'v2';
   ```
3. ファイルを保存してデプロイ
4. ユーザーがアプリを再読み込みすると、新しいService Workerが登録されます
5. 既存のブラウザタブを閉じて再度開くと、新しいバージョンが有効化されます

#### DevToolsでの確認方法
1. Chrome DevTools を開く（F12）
2. **Application** タブを選択
3. 以下を確認：
   - **Manifest**: エラーがないか、アイコンが表示されるか
   - **Service Workers**: 登録済みか、scopeが正しいか
   - **Cache Storage**: `bp-cache-v1` にファイルが格納されているか
4. **Network** タブで「Offline」にチェックを入れて、オフライン動作を確認

#### 開発時の注意点
- **HTTPS必須**: Service Workerは `localhost` または HTTPS でのみ動作します
- **キャッシュ更新**: 開発時にキャッシュが残る場合は、DevTools > Application > Storage > "Clear site data" で削除
- **Hard Reload**: Ctrl+Shift+R（Mac: Cmd+Shift+R）でキャッシュを無視した再読み込みが可能
- **Unregister**: DevTools > Application > Service Workers > "Unregister" で登録解除できます

## セキュリティについて

### 注意事項
- Google Apps Script を「全員アクセス可」でデプロイすると、URLを知っている人は誰でもアクセス可能になります
- 家族内での利用を想定した簡易的な実装です
- 機密性の高いデータの場合は、OAuth認証などより強固な認証方式の導入を検討してください

### 簡易的な対策（任意）
`js/sheets-api.js` と Google Apps Script の両方でトークン認証を実装することで、最低限の防御が可能です。詳細は計画書を参照してください。

## 今後の開発予定
- カメラ撮影機能
- OCR自動入力機能
- データ分析機能（統計情報、異常値検知など）
- 通知機能（測定時刻リマインダー）
- PWA高度化（バックグラウンド同期、プッシュ通知など）

## ライセンス
このプロジェクトは個人用途での使用を想定しています。

## 貢献
バグ報告や機能提案は、Issueでお知らせください。
