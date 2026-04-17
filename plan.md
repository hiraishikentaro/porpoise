# MySQL GUI クライアント開発プラン (Tauri + Rust + React)

TablePlus ライクな軽量 MySQL GUI クライアントを Tauri + Rust + React で構築するための開発計画。

---

## 1. プロダクトゴール

- **軽量**: バンドル 20MB 以下、起動 1 秒以内、アイドル時メモリ 100MB 以下
- **高速**: 100 万行クラスの結果セットでもスクロールがカクつかない
- **実用**: MVP 段階でインライン編集 + SQL エディタが実務で使えるレベル
- **安全**: 接続情報は OS キーチェーンに保存、SQL 実行には差分プレビューを挟む

## 2. 技術スタック

### フロントエンド (webview 側)

- **React 18 + TypeScript** — UI 層
- **Vite** — ビルド
- **TanStack Query** — Rust コマンド呼び出しのキャッシュ/再取得管理
- **Zustand** — クライアント状態(タブ、接続状態、UI設定)
- **TanStack Table + TanStack Virtual** — テーブル仮想スクロール(10万行 + でも滑らか)
- **CodeMirror 6** — SQL エディタ本体(Monaco より軽量で Tauri 向き)
  - `@codemirror/lang-sql`, `@codemirror/autocomplete`
- **Tailwind CSS + shadcn/ui** — スタイリングと基本コンポーネント
- **react-arborist** — 左サイドバーのDB/テーブルツリー

### バックエンド (Rust 側)

- **Tauri 2.x** — アプリケーションフレームワーク
- **sqlx** (MySQL feature, runtime-tokio) — MySQL ドライバ。型安全・非同期・コネクションプール内蔵
- **tokio** — 非同期ランタイム
- **serde / serde_json** — フロントとのデータ受け渡し
- **keyring** crate — OS キーチェーン(macOS Keychain / Windows Credential Manager / Secret Service)
- **russh** or **ssh2** — SSH トンネル(bastion経由接続用、Phase 2 以降)
- **rusqlite** — ローカル設定・クエリ履歴の保存(アプリ内DB)
- **tracing** — 構造化ログ

### 配布

- **tauri-action** (GitHub Actions) — macOS (.dmg) / Windows (.msi) / Linux (.AppImage, .deb) ビルド
- **Tauri Updater plugin** — 自動アップデート
- コード署名: macOS は Apple Developer 証明書、Windows は EV証明書(後回し可)

## 3. アーキテクチャ

```
┌─────────────────────────────────────────────┐
│  React (webview)                            │
│  ├─ ConnectionManager  ├─ TabManager        │
│  ├─ TableView (仮想スクロール + 編集)         │
│  ├─ SqlEditor (CodeMirror)                  │
│  └─ QueryHistory                            │
│            ↕  Tauri invoke / event          │
├─────────────────────────────────────────────┤
│  Rust (Tauri core)                          │
│  ├─ commands/     ← #[tauri::command] 関数   │
│  │   ├─ connection.rs                       │
│  │   ├─ query.rs                            │
│  │   ├─ schema.rs                           │
│  │   └─ history.rs                          │
│  ├─ db/                                     │
│  │   ├─ pool_manager.rs  (接続プール管理)    │
│  │   ├─ mysql_client.rs  (sqlx wrapper)     │
│  │   └─ ssh_tunnel.rs    (Phase 2)          │
│  ├─ storage/                                │
│  │   ├─ keychain.rs      (認証情報)          │
│  │   └─ local_db.rs      (sqlite, 履歴等)    │
│  └─ state.rs       (AppState: Mutex/RwLock) │
└─────────────────────────────────────────────┘
```

### 重要な設計判断

**接続プールはRust側で一元管理する**。フロントは `connection_id` (UUID) だけ持ち、毎回のクエリはそのIDで Rust に投げる。sqlx の `Pool<MySql>` を `HashMap<ConnectionId, Pool>` で保持。

**大きな結果セットはストリーム + ページング**。`LIMIT/OFFSET` ではなく、Rust 側でカーソルを保持してフロントから `fetch_more(cursor_id, 1000)` を呼ぶ形にする。全行をメモリに載せない。

**インライン編集は WHERE句の一意性チェック必須**。主キー or 一意インデックスが特定できない行は編集不可にする(編集時に意図しない複数行更新を防ぐため)。TablePlus も同じ挙動。

**SQL実行はプレビュー → コミットの2段階**。UPDATE/DELETE は影響行数を先に見せてから実行。TablePlus の「Commit」ボタン相当。

## 4. フェーズ別マイルストーン

### Phase 0: 土台 (1週間)

- [ ] `pnpm create tauri-app` でプロジェクト初期化
- [ ] TypeScript + Tailwind + shadcn/ui セットアップ
- [ ] Rust 側: sqlx、tokio、keyring、rusqlite、tracing 導入
- [ ] 最小の invoke 通信 (フロント → Rust → "hello") 動作確認
- [ ] GitHub Actions で macOS/Windows ビルドが通る状態に
- [ ] Biome (または ESLint + Prettier) + clippy + rustfmt を CI に組み込み

### Phase 1: MVP — 接続と閲覧 (2〜3週間)

接続できてテーブルが見えるところまで。

- [ ] **接続フォーム**: host / port / user / password / database, SSL 有無
- [ ] **接続テスト**: `SELECT 1` で疎通確認
- [ ] **認証情報の保存**: keyring に保存、接続一覧は rusqlite
- [ ] **接続確立**: sqlx `MySqlPool` を作って AppState に登録
- [ ] **スキーマツリー**: DB一覧 → テーブル一覧 → カラム情報を左サイドバーに表示
- [ ] **テーブル閲覧**: `SELECT * FROM {table} LIMIT 1000` を TanStack Table で表示
- [ ] **仮想スクロール**: 1000行以上でもスムーズに
- [ ] **ページング**: 下スクロールで追加ロード

### Phase 2: インライン編集 (2週間) ★最優先機能

- [ ] セルダブルクリックで編集モード
- [ ] 型別エディタ: int/decimal/datetime/json/enum などで適切な入力UI
- [ ] **編集バッファ**: 変更を即DBに流さず、フロントでdirty状態を保持
- [ ] **差分プレビューモーダル**: "3行更新します" の形で変更内容のSQLを表示
- [ ] **一意性チェック**: 主キー or 一意インデックスがない行は編集不可
- [ ] NULL の明示的な入力、`DEFAULT` の扱い
- [ ] 行の追加・削除
- [ ] トランザクションでまとめて commit / rollback

### Phase 3: SQLエディタ (2週間) ★第2優先

- [ ] CodeMirror 6 + SQL 言語モード
- [ ] シンタックスハイライト、括弧マッチ、行番号
- [ ] **補完**: テーブル名・カラム名をスキーマ情報から
- [ ] キーワード補完(SELECT/FROM/JOIN etc.)
- [ ] 複数ステートメント対応 (`;` 区切り、カーソル位置の1文だけ実行)
- [ ] `Cmd/Ctrl + Enter` で実行、`Cmd/Ctrl + Shift + Enter` で全実行
- [ ] 実行結果を下ペインにテーブル表示(Phase 1 のテーブルビューを流用)
- [ ] エラー時の行ハイライト
- [ ] EXPLAIN 実行のショートカット

### Phase 4: クエリ履歴・保存 (1週間) ★第3優先

- [ ] rusqlite に全実行クエリを自動保存 (query, connection_id, executed_at, duration_ms, row_count)
- [ ] 履歴一覧UI + 検索
- [ ] 「スニペット」として名前付けて保存
- [ ] 履歴からエディタへ復元
- [ ] プライバシー設定: 履歴を保存しない接続の指定

### Phase 5: タブ管理 (1週間) ★第4優先

- [ ] 複数DBへの同時接続 → それぞれタブとして保持
- [ ] タブごとに独立したエディタ + 結果セット
- [ ] タブのドラッグ並び替え、複製、分割
- [ ] タブ状態の永続化(再起動で復元)
- [ ] 接続カラーラベル(本番=赤など、誤爆防止)

### Phase 6: Import/Export (1〜2週間) ★第5優先

- [ ] **エクスポート**: 結果セットを CSV / JSON / SQL INSERT 文 で書き出し
- [ ] 大量データのストリーム書き出し(全部メモリに載せない)
- [ ] **インポート**: CSV → 既存テーブルへ INSERT / UPSERT
- [ ] カラムマッピングUI
- [ ] dry-run モード

### Phase 7: ER図・スキーマ可視化 (2〜3週間) ★最後

- [ ] `INFORMATION_SCHEMA` から FK 情報を取得
- [ ] **React Flow** でノード(テーブル) + エッジ(FK)を描画
- [ ] 自動レイアウト(dagre or ELK)
- [ ] ズーム/パン、PNG/SVG エクスポート
- [ ] テーブルクリックで詳細(カラム、インデックス)表示

### Phase 8: 仕上げ (継続)

- [ ] 自動アップデーター
- [ ] コード署名
- [ ] ダーク/ライトテーマ
- [ ] キーボードショートカット一覧
- [ ] 設定画面(フォント、タブ幅、確認ダイアログの挙動)
- [ ] SSH トンネル対応
- [ ] SSL証明書ファイル指定対応

## 5. リスクと対策

| リスク                                | 影響         | 対策                                                                                  |
| ------------------------------------- | ------------ | ------------------------------------------------------------------------------------- |
| Rust学習コスト                        | 開発速度低下 | Phase 0-1 は小さく始めて型とborrowに慣れる。`anyhow`/`thiserror` でエラー処理を簡素化 |
| webview差分 (WebKit vs WebView2)      | UIバグ       | CI で両OSの e2e テスト (Playwright)。複雑なCSSは避ける                                |
| 大量データでの OOM                    | クラッシュ   | 結果セットは必ずカーソル/ストリーム。フロントに渡す行数上限を設ける                   |
| 誤UPDATE/DELETE                       | データ破壊   | 差分プレビュー必須、本番接続は赤ラベル、`LIMIT` なしの UPDATE/DELETE に警告           |
| sqlx のコンパイル時チェックが使えない | 型安全性低下 | 動的SQLが主なのでランタイム型のまま。ただしスキーマ取得部分は型付けで堅く             |
| Tauri v2 の情報の古さ                 | 実装の遠回り | 公式ドキュメント最優先。ブログ記事は日付確認                                          |

## 6. 開発環境

- **エディタ**: VS Code + rust-analyzer + Tauri拡張
- **Ruby開発者向けメモ**:
  - `cargo` = `bundler`, `Cargo.toml` = `Gemfile`
  - `impl`/`trait` ≒ モジュール/インターフェース
  - `Result<T, E>` を常に意識(Rails の例外的な流れは書けない)
  - 非同期は `async/await` で書くが、`tokio::spawn` の所有権に注意

## 7. 初週のタスク

1. Rust + Node.js 環境整備 (`rustup`, `pnpm`)
2. `pnpm create tauri-app` で React + TS テンプレを選択
3. `cargo add sqlx --features "mysql runtime-tokio rustls"` などで主要crate追加
4. ダミーのMySQL (docker-compose で起動) に対して `SELECT 1` がフロントまで返ってくるところまで
5. この時点で GitHub Actions で macOS ビルドが成功することを確認

---

**想定合計期間**: フルタイム換算で 3〜4 ヶ月で Phase 5 まで、6 ヶ月で Phase 7 まで到達できる規模感。
