# Phase1 Step1-1: プロジェクト初期設定

## 概要
血圧記録アプリの基本的なファイル構造を作成し、HTML/CSS/JavaScriptのベースとなるファイルを準備します。

## 作成するファイル構造

```
blood-pressure-tracker/
├── index.html          # メインHTMLファイル
├── css/
│   └── style.css      # スタイルシート
├── js/
│   └── app.js         # メインJavaScript
├── README.md          # プロジェクト説明
└── .gitignore         # Git除外設定
```

## 実装内容

### 1. ディレクトリ構造の作成
- `css/`フォルダと`js/`フォルダを作成

### 2. `index.html`の作成
- HTML5のDOCTYPE宣言
- `<meta name="viewport">`でモバイル対応の設定
- UTF-8文字エンコーディング
- タイトル: "血圧記録アプリ"
- `css/style.css`の読み込み
- `js/app.js`の読み込み（defer属性付き）
- シンプルなヘッダーセクション（アプリタイトル表示）
- メインコンテナ（id="app"）

### 3. `css/style.css`の作成
- リセットCSS（基本的なマージン・パディング設定）
- モバイルファーストの基本スタイル
- レスポンシブデザインのための基本設定

### 4. `js/app.js`の作成
- DOMContentLoadedイベントリスナー
- 初期化関数の骨組み
- コンソールログでの動作確認メッセージ

### 5. `README.md`の作成
- プロジェクト名: Blood Pressure Tracker
- 概要説明
- 目的と機能
- 使用技術
- セットアップ方法

### 6. `.gitignore`の作成
- `node_modules/`
- `.DS_Store`
- `*.log`
- その他の一般的な除外ファイル

## 確認事項
- [ ] すべてのファイルが正しい場所に作成されているか
- [ ] `index.html`をブラウザで開いて、タイトルとヘッダーが表示されるか
- [ ] ブラウザのコンソールに初期化メッセージが表示されるか
- [ ] モバイルビューで適切に表示されるか（開発者ツールで確認）

## 所要時間
約30分

## 次のステップ
Phase1 Step1-2: 入力フォームUI作成
