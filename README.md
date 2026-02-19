# Blood Pressure Tracker

## 概要
血圧記録アプリ（Blood Pressure Tracker）は、日々の血圧を簡単に記録・管理できるWebアプリケーションです。

## 目的と機能
このアプリは以下の目的で開発されています：
- 血圧データの記録と管理
- 記録データの可視化
- 健康管理のサポート

### 現在の実装状況
- ✅ 基本的なファイル構造の構築
- ✅ HTML/CSS/JavaScriptの土台の準備
- ✅ レスポンシブデザインの基本設定
- ✅ 入力フォームUI作成
- ✅ ローカルストレージでのデータ保存
- ✅ 記録一覧表示機能
- ✅ Google Sheets API連携（クラウド同期）
- ✅ 基本グラフ表示機能（過去7日分の血圧推移）
- ✅ PWA対応（インストール可能・オフライン動作）
- ✅ カメラ撮影・画像プレビュー機能（Phase 2）
- ✅ OCR文字認識機能・画像前処理（Phase 3 Step 3-1〜3-3）
- ✅ OCR結果の自動入力・確認UI（Phase 3 Step 3-4）

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
- ✅ カメラ撮影機能（Phase 2 完了）
- ✅ OCR自動入力機能（Phase 3 Step 3-4 完了）
- OCR精度のさらなる最適化（言語データのローカル配置・PSM調整）
- データ分析機能（統計情報、異常値検知など）
- 通知機能（測定時刻リマインダー）
- PWA高度化（バックグラウンド同期、プッシュ通知など）

## Phase 3: OCR機能（Tesseract.js）

### 概要
血圧計の画面を撮影した画像から、数値を自動的に読み取るOCR（光学文字認識）機能を導入しました。

### 技術仕様
- **OCRエンジン**: Tesseract.js v5.0.3（CDN経由）
- **認識言語**: 日本語 + 英語（`jpn+eng`）
- **認識対象文字**: 数字とスラッシュ（`0123456789/`）
- **PSM（Page Segmentation Mode）**: 6（一様なテキストブロック）

### ファイル構成
- `js/ocr.js` - OCRモジュール（Tesseract.js wrapper）
  - `window.OCR.initOcr()` - ワーカー初期化
  - `window.OCR.recognizeText(image, options)` - OCR実行（前処理あり）
  - `window.OCR.terminateOcr()` - ワーカー破棄
  - `window.OCR.preprocessImage` - 画像前処理（ROI/グレースケール/二値化）
- `js/image-preprocess.js` - 画像前処理モジュール（Phase 3 Step 3-2）
- `js/constants.js` - 前処理デフォルト値（ROIマージン、閾値方式など）

### 使用方法

#### 基本的な使い方
```javascript
// 1. 初期化（自動実行されるため、通常は不要）
await window.OCR.initOcr();

// 2. OCR実行
const result = await window.OCR.recognizeText(imageBase64);
console.log('認識テキスト:', result.rawText);
console.log('信頼度:', result.confidence);

// 3. 終了（メモリ解放）
await window.OCR.terminateOcr();
```

#### 進捗表示付きでOCRを実行
```javascript
const result = await window.OCR.recognizeText(imageBase64, {
    onProgress: (info) => {
        console.log(`${info.status}: ${Math.round(info.progress * 100)}%`);
    }
});
```

### 疎通テスト手順

#### 1. デバッグモードの有効化
アプリのURLに `?debug=1` パラメータを追加してアクセス：
```
http://localhost:8000/?debug=1
```

#### 2. OCRテストボタンの表示
デバッグモードでは「🔍 OCRテスト」ボタンが表示されます。

#### 3. テスト実行
- **画像がある場合**: 撮影済みの画像に対してOCRを実行
- **画像がない場合**: サンプル画像（`120 / 80` と `75`）を自動生成してOCRを実行

#### 4. 結果確認
- アラートで認識結果が表示されます
- コンソールに詳細ログが出力されます
- **前処理デバッグ**（`?debug=1` 時）: 画面下部に前処理の各段階（ROI後・グレースケール・二値化）のプレビューと、閾値・処理時間が表示されます

### 画像前処理（Phase 3 Step 3-2）

OCR精度向上のため、認識前に以下の前処理を適用します（失敗時は前処理をスキップして継続）。
1. **ROI切り抜き** - ガイド枠に合わせた領域、未指定時は中央固定比率
2. **長辺縮小** - 端末負荷軽減（デフォルト長辺 960px）
3. **グレースケール** - 輝度変換
4. **二値化** - Otsu 閾値（または Adaptive / auto）
5. （任意）メディアンフィルタ・モルフォロジー

**回帰確認の足場**: 代表画像を 5〜10 枚（良条件 2 枚以上・悪条件 3 枚以上）手元に用意し、`?debug=1` で「OCRテスト」実行後に前処理プレビューと認識結果を目視確認する手順を推奨します。個人情報が写る画像は保存先・共有範囲に注意してください。

### トラブルシュート

#### 初回ロードが遅い
- **症状**: OCR初回実行時に時間がかかる
- **原因**: 言語データ（`jpn.traineddata` / `eng.traineddata`）のダウンロード
- **対処**: 
  - 初回のみ数秒〜十数秒かかります（通信速度に依存）
  - 2回目以降はブラウザキャッシュが使用され、高速化されます

#### CORS エラー
- **症状**: コンソールに「CORS policy」エラー
- **対処**: 
  - Tesseract.js はCDN（jsDelivr）から配信されているため、通常は発生しません
  - ローカルファイルで開いている場合は、HTTPサーバー経由でアクセスしてください

#### ワーカーが初期化できない
- **症状**: 「OCRワーカーの初期化に失敗しました」エラー
- **対処**: 
  - ブラウザのコンソールで詳細なエラーメッセージを確認
  - ネットワーク接続を確認
  - ブラウザキャッシュをクリアして再試行

#### 認識精度が低い
- **原因**: 
  - 画像の解像度が低い
  - 文字が小さい、または不鮮明
  - 照明条件が悪い
- **対処**: 
  - 撮影時に血圧計の画面をできるだけ大きく撮影
  - 十分な明るさで撮影
  - 画像前処理（ROI・グレースケール・二値化）は自動適用されています。`?debug=1` で前処理プレビューを確認してチューニング可能

### 技術的な詳細

#### ワーカーのシングルトン管理
OCRワーカーは重い処理のため、シングルトンとして管理されます：
- 初回 `recognizeText()` 呼び出し時に自動的に初期化
- 2回目以降は既存のワーカーを再利用
- 多重初期化は防止されます

#### メモリ管理
長時間使用時のメモリリーク対策：
- `terminateOcr()` でワーカーを破棄できます
- ページリロード時、ワーカーは自動的に破棄されます
- 今後、一定時間アイドル後の自動破棄も検討

#### 設定のカスタマイズ
`js/ocr.js` の `CONFIG` オブジェクトで設定を変更できます：
```javascript
const CONFIG = {
    lang: 'jpn+eng',                              // 認識言語
    langPath: 'https://cdn.jsdelivr.net/...',    // 言語データ配置先
    tesseractConfig: {
        tessedit_char_whitelist: '0123456789/',  // 認識対象文字
        psm: 6                                    // ページ分割モード
    }
};
```

---

### OCR結果の自動入力と確認UI（Phase 3 Step 3-4）

#### 機能概要
血圧計の写真を撮影し「この画像を使う」を押すと、OCRが自動で文字を読み取り、入力フォームへ数値を自動入力します。  
認識結果の信頼度（精度）が色とアイコンで表示され、内容を確認・修正してから記録できます。

| 信頼度 | バッジ表示 | 意味 |
|---|---|---|
| 90%超 | 🟢 `✓ XX%` | 認識精度が高い（そのまま記録を推奨） |
| 70〜90% | 🟡 `! XX%` | やや不確か（目視で確認してください） |
| 70%未満 | 🔴 `✕ XX%` | 精度が低い（手動で確認・修正してください） |

---

#### 動作確認手順（初心者向け）

以下の手順を1つずつ試してください。各ステップで何が起きるかを合わせて説明します。

---

##### ステップ1：アプリをHTTPS経由で開く

カメラ機能はHTTPS（またはlocalhost）でしか動作しません。以下のいずれかで起動してください。

```bash
# 方法A: 付属の簡易HTTPSサーバーを使う（おすすめ）
python https_server.py
# → https://localhost:4443 でアクセス

# 方法B: Pythonの標準HTTPサーバーを使う（localhostのみ可）
python -m http.server 8000
# → http://localhost:8000 でアクセス
```

> **注意**: 自己署名証明書の警告が出た場合は「詳細設定」→「安全でないサイトへ進む」をクリックしてください。

---

##### ステップ2：カメラで血圧計を撮影する

1. 「📷 カメラで撮影」ボタンをタップ
2. カメラが起動したら、血圧計の画面がガイド枠内に入るように調整
3. 「📸 シャッター」をタップして撮影
4. 撮影された画像がプレビューに表示される

> **撮影のコツ**:
> - 血圧計の数字がガイド枠の中央に来るように持つ
> - 画面に反射・光が映り込まないようにする
> - なるべく明るい場所で撮影する

---

##### ステップ3：画像を確定する

プレビューを確認して、以下のボタンを操作します。

| ボタン | 操作 |
|---|---|
| 「✓ この画像を使う」 | 画像を確定してOCRを開始する |
| 「🔄 回転」 | 画像の向きを90度回転する |
| 「🔄 再撮影」 | 撮り直す |

「この画像を使う」をタップすると、カメラが閉じて **OCRが自動で開始**されます。

---

##### ステップ4：OCR処理中の表示を確認する

画像プレビューの下に **青いバナー** が表示されます。

```
⟳ 読み取り中…
```

> OCRの処理には**初回5〜20秒程度**かかります（言語データのダウンロードのため）。  
> 2回目以降はキャッシュが効いて速くなります。処理中は他の操作をせずお待ちください。

---

##### ステップ5：認識結果を確認する

処理が完了すると、バナーの内容が切り替わります。

**【成功した場合】** 緑のバナーが表示される

```
✓ 認識結果を確認してください

[そのまま記録]  [修正する]  ([再試行] ※低信頼度の場合のみ)
```

フォームの「最高血圧」「最低血圧」「脈拍」に数値が自動入力され、各フィールドの横に信頼度バッジが表示されます。

**【失敗した場合】** 赤いバナーが表示される

```
✕ 自動読み取りに失敗しました。手動で入力するか再試行してください

[再試行]
```

フォームには値が入力されませんが、手動で直接入力できます。

---

##### ステップ6：内容を確認・修正する

自動入力された値を目視で確認します。信頼度バッジの色に注目してください。

- **緑（✓）のフィールド**: そのままで問題ないと思われます
- **黄（!）のフィールド**: 念のため画像と比較して確認してください
- **赤（✕）のフィールド**: 誤認識の可能性が高いため、手動で修正してください

フィールドの値を**手動で書き換えると**、バッジが `✎ 編集済` に変わり、手動入力した値が保存されます。

> 「修正する」ボタンを押すと、最高血圧のフィールドにカーソルが移動して入力しやすくなります。

---

##### ステップ7：記録する

確認・修正が完了したら、いずれかの方法で記録できます。

| 操作 | 説明 |
|---|---|
| バナーの「**そのまま記録**」ボタン | OCR結果（または編集済みの値）を記録する |
| フォーム下の「**記録する**」ボタン | 同じく記録する（どちらを使っても同じ） |

記録が成功すると、画像プレビューとOCRバナーが消え、記録一覧に追加されます。

---

#### シナリオ別テスト手順

実装の品質を確認するため、以下のシナリオも順番に試してみてください。

##### シナリオA：成功〜そのまま記録

1. 血圧計を撮影 → 「この画像を使う」
2. OCRが完了し、フォームに値が入力されることを確認
3. 信頼度バッジが表示されることを確認
4. バナーの「そのまま記録」をタップ
5. 記録一覧に追加されることを確認

##### シナリオB：成功〜一部修正して記録

1. 血圧計を撮影 → OCR完了
2. 「最高血圧」フィールドの値を手動で書き換える
3. そのフィールドのバッジが「✎ 編集済」に変わることを確認
4. 他のフィールドのバッジは変わっていないことを確認
5. 「そのまま記録」または「記録する」で保存
6. 記録一覧の値が**手動で入力した値**になっていることを確認

##### シナリオC：失敗〜再試行〜成功

1. 真っ暗な場所や、血圧計が映っていない画像で試す
2. 「✕ 失敗」バナーが表示されることを確認
3. 「再試行」ボタンをタップ
4. OCRが再実行されることを確認（再試行は最大3回まで）
5. 3回失敗したら「再試行の上限に達しました」と表示されることを確認

##### シナリオD：失敗〜手動入力で記録

1. OCRが失敗しても、フォームに手動で値を入力できることを確認
2. 「記録する」ボタンで通常通り保存できることを確認

##### シナリオE：画像削除でリセットされる

1. OCR完了後（バナー表示中）に、画像プレビューの「✕」ボタンで画像を削除
2. OCRバナーが消えることを確認
3. フォームの自動入力が消え、信頼度バッジも非表示になることを確認

---

#### デバッグモードでのテスト

URLに `?debug=1` を追加すると、OCRの詳細情報を開発者ツールで確認できます。

```
http://localhost:8000/?debug=1
```

ブラウザの開発者ツール（F12）→ **Console** タブで以下のようなログが確認できます。

```
[OCR AutoRun] OCR開始
[OCR AutoRun] 認識完了 (8432ms)
[OCR AutoRun] 抽出結果: { systolic: 120, diastolic: 78, pulse: 65, confidence: 87 }
```

---

#### よくある問題と対処法

| 症状 | 原因 | 対処法 |
|---|---|---|
| バナーが表示されない | 画像未選択またはOCRモジュール未読込 | ページをリロードして再試行 |
| 数値が明らかに間違っている | 照明不足・反射・画角のずれ | 再撮影して照明を改善する |
| 処理が長い（30秒以上） | 言語データのダウンロード中 | 通信環境を確認してそのまま待つ |
| OCR中に操作できない | 意図的な制御（多重実行防止） | 処理完了まで待つ |
| 「再試行の上限」と表示される | 3回連続して失敗した | 「📷 カメラで撮影」から撮り直す |

---

### 今後の予定（Phase 3 後続Step）
- 画像前処理のさらなる最適化（ガイド枠→ROI連携の強化、Adaptive/auto 閾値のチューニング）
- 血圧値の構造化抽出（SYS/DIA/PULSE の自動特定）
- ✅ 認識結果の自動入力（フォームへの値のセット）← Step 3-4 で完了
- 言語データのローカル配置（オフライン最適化）
- PSMの最適化（血圧計レイアウトに応じた調整）

## ライセンス
このプロジェクトは個人用途での使用を想定しています。

## 貢献
バグ報告や機能提案は、Issueでお知らせください。
