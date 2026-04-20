# Architecture

CLAUDE.md のサマリより一段深い資料。コードを読み解く時の省エネに。

## 1. プロセスモデル

Tauri 2 なので 1 window = 2 プロセス:

- **Frontend (WebView)**: React + Vite ビルドを WKWebView (macOS) / WebView2 (Windows) でホスト
- **Core (Rust)**: Tauri runtime が `src-tauri/src/lib.rs` の `run()` を起動。`AppState` を管理し、コマンド経由で frontend に機能を提供

Frontend → Core は `invoke("command_name", args)`。逆向きは `app.emit("event", payload)` を frontend の `listen("event", cb)` が拾う。

## 2. 状態とライフサイクル

### AppState (Rust)

```rust
pub struct AppState {
    pub local_db: Mutex<rusqlite::Connection>,            // 保存設定
    pub pools: Mutex<HashMap<Uuid, ActiveConnection>>,    // MySQL プール (tauri 接続 id → Pool + SSH tunnel)
    pub running_queries: Mutex<HashMap<Uuid, RunningQuery>>, // cancel_query 用の thread id 台帳
}
```

### React 側 Providers (main.tsx)

```
<SettingsProvider>          // theme / font / locale / tabWidth / confirmDestructive
  <I18nProvider>            // en / ja 辞書 + useT
    <TabStatusProvider>     // 各タブが rows/elapsedMs/pending を publish
      <App />
    </TabStatusProvider>
  </I18nProvider>
</SettingsProvider>
```

### タブの永続化 (App.tsx)

- `Tab = ConnectionTab | TableTab | EditorTab`。EditorTab は `panes: EditorPane[]`
- `localStorage` の `porpoise.tabs.v2` に **500ms debounce** で serialize
- **全タブは常時 DOM にマウント**し、非アクティブは `hidden` で隠すだけ。これで SqlEditor の入力 / 結果 / ペイン幅 / TableView のフィルタや編集バッファがタブ切替で飛ばない

## 3. クエリ実行パス (Streaming)

```
┌─────────── SqlEditor ────────────┐                ┌────────── Rust ──────────┐
│                                  │                │                          │
│  newRequestId()                  │                │                          │
│  runOneStreaming(stmt)           │                │                          │
│       │                          │                │                          │
│       ▼                          │                │                          │
│  executeQueryStream(conn, sql,   │  listen(…)     │                          │
│     db, requestId, handlers)  ───┼───────────────▶│  execute_query_stream    │
│                                  │  invoke        │   └ stream_query_body    │
│                                  │                │      │                   │
│                                  │                │      ├ pool.get_conn()   │
│                                  │                │      ├ running_queries   │
│                                  │                │      │    .insert(rid)   │
│                                  │                │      ├ USE db            │
│                                  │                │      ├ query_iter(sql)   │
│                                  │                │      │                   │
│  onColumns(cols) ◀───────────────┼─ query:{rid}:columns ─┤                   │
│                                  │                │      │                   │
│  onRows(batch, fetched) ◀────────┼─ query:{rid}:rows ────┤ (500 行ごと)      │
│  (rowsRef.current.push(...))     │                │      │                   │
│  setState({fetched}) // カウンタ │                │      │                   │
│                                  │                │      ├ drop_result       │
│                                  │                │      │                   │
│  resolve({returned, elapsedMs})◀─┼─ query:{rid}:done ────┤                   │
│                                  │                │      ▼                   │
│  setRunState({kind:"done", tabs})│                │   running_queries.remove │
│                                  │                │                          │
└──────────────────────────────────┘                └──────────────────────────┘
```

**なぜ rowsRef を使うのか**: 1 バッチ 500 行 × setState では、10 万行で 200 回の再レンダーが走る。state は `fetched` だけに絞り、rows は ref に蓄積して virtualizer から直接参照。React の reconcile 負荷を最小化。

## 4. クエリキャンセル (KILL QUERY)

```
┌────── Frontend ──────┐       ┌────────── Rust ──────────┐
│                      │       │                          │
│  ⌘. / Cancel ボタン  │       │                          │
│  cancelActive()      │       │                          │
│       │              │       │                          │
│       ▼              │       │                          │
│  cancelQuery(rid) ───┼──────▶│  cancel_query(rid)       │
│                      │       │    ├ running[rid] lookup │
│                      │       │    ├ 別 conn = get_conn  │
│                      │       │    └ KILL QUERY {thread} │
│                      │       │                          │
│                      │       │  実行中の query_iter が  │
│                      │       │  エラーで戻る → error    │
│                      │       │  イベント発火            │
│                      │       │                          │
│  onError ◀───────────┼─ query:{rid}:error ──────────────┤
│                      │       │                          │
└──────────────────────┘       └──────────────────────────┘
```

**副 conn 必須**: 実行中 conn は busy なので、別コネクションを pool から取って KILL を撃つ。pool が飽和している場合は拡張される。

## 5. SSH トンネル (`src-tauri/src/db/ssh_tunnel.rs`)

```
open_connection(saved)
   │
   ├─ ssh=false → mysql_async::Pool::from_url("mysql://user:pass@host:port/db")
   │
   └─ ssh=true
         ├─ SshTunnel::open(ssh_host, ssh_user, key / password)
         │     ├ russh::client::connect
         │     ├ authenticate
         │     ├ local_port = bind 127.0.0.1:0
         │     └ spawn forward task (local → remote)
         │
         └─ Pool::from_url("mysql://user:pass@127.0.0.1:{local_port}")
         └─ ActiveConnection { pool, tunnel: Some(tunnel) }

close_connection:
   ActiveConnection.shutdown().await
   → pool.disconnect() → tunnel.shutdown() (task 停止 + local_port 解放)
```

タイムアウトは `russh` 側の TCP connect で判定。10 秒で落ちるのはここ。ConnectingOverlay (ブロッキングモーダル) が出ている間はこのパスを走っている。

## 6. Tauri ↔ TypeScript 型同期マップ

Rust の型を変える時は **frontend 側の対応型も一緒に更新**する。

| 概念             | Rust                                                | TypeScript                                         |
| ---------------- | --------------------------------------------------- | -------------------------------------------------- |
| 保存接続         | `commands::connection::SavedConnection`             | `lib/tauri.ts` `SavedConnection`                   |
| カラムメタ       | `commands::schema::ColumnInfo`                      | `lib/tauri.ts` `ColumnInfo`                        |
| テーブル一覧     | `TableInfo { name, kind: TableKind }`               | 同名 `TableInfo` / `TableKind = "table" \| "view"` |
| クエリ結果       | `QueryResult { Select{...}, Affected{...} }`        | `QueryResult` discriminated union                  |
| ストリーム進捗   | `ColumnsPayload` / `RowsPayload` / `DonePayload` 等 | `executeQueryStream` の handlers 引数              |
| Filter / Sort    | `Filter`, `SortKey`, `FilterMatch`                  | 同名 (スネークケース op は一致)                    |
| 接続色ラベル     | 文字列 (`"gray" \| "blue" \| ...`)                  | `StatusColor` (`lib/status-color.ts`)              |
| 実行時リクエスト | `Uuid` (commands 引数)                              | `crypto.randomUUID()` で生成した UUIDv4 文字列     |

**命名規則**: Rust 側はすべて `#[serde(rename_all = "snake_case")]` を基本にしている。TypeScript 側の `QueryResult` は `elapsed_ms` のような snake_case フィールドをそのまま受ける。タブが streaming の時だけ `elapsedMs` に rename している (`executeQueryStream` wrapper 内で行う)。

## 7. 設定 / i18n フロー

- `SettingsProvider` が `localStorage` (`porpoise.settings.v1`) を読む
- `I18nProvider` が `settings.locale` を見て `en` / `ja` を解決 (`auto` なら `navigator.language`)
- `useT("key")` は型付き。辞書定義は `src/lib/i18n.tsx` の `Messages` 型に従う (**キーの追加は en / ja 両方必要**)
- 動的文字列は関数値:
  ```ts
  "status.rows": (n: number) => `${n.toLocaleString("en-US")} rows`
  ```

## 8. テーマ

`src/index.css` の `:root, .dark` と `.light` に Tokyo Night の全トークンが定義されている。`settings.theme` の変化で `html` の class が差し替わる。

- Dark accent: `#7aa2f7` (Tokyo Night blue)
- Light accent: `#2e5cc5` / 本文色は near-black `#1a1b26` (ユーザ要望。Tokyo Night Day 標準の青文字は採用していない)

## 9. Biome / cargo 運用

- **単一ソース・オブ・トゥルース**: Biome (`biome.json`)。ESLint / Prettier は入れない
- CI (`.github/workflows/ci.yml`):
  - `pnpm biome ci .`
  - `pnpm tsc --noEmit`
  - `cargo fmt --check`
  - `cargo clippy -D warnings`
- 全部 push 前にローカルで通すこと (CLAUDE.md の pre-push ブロック参照)

## 10. リリース

- `v*` タグを push → `.github/workflows/release.yml` が macOS arm64/x64 + Windows x64 の dmg/msi を Draft Release に積む
- `scripts/sync-version.mjs` が tag 名 (`v1.2.3` → `1.2.3`) を `tauri.conf.json` / `Cargo.toml` ([package] のみ) / `package.json` に書き戻してから tauri-action を実行 — これを忘れると dmg のファイル名が固定 `0.1.0` になる
