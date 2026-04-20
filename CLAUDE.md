# Porpoise — Claude guide

Quick reference for future Claude sessions working on this repo. Keep it up to date when the architecture shifts.

## What this is

**Porpoise** is a lightweight, TablePlus-style MySQL GUI client built on Tauri 2 + Rust + React 19 + TypeScript. It targets macOS (primary) and Windows (CI builds both). Goals: fast, keyboard-first, feel like a native desktop tool rather than an Electron wrapper.

## Stack

- **Frontend**: React 19, Vite 7, Tailwind v4 (`@theme inline` + CSS vars), shadcn/ui (new-york, zinc base — but the palette is overridden to **Tokyo Night**)
- **Editor**: CodeMirror 6 (`@codemirror/lang-sql` MySQL dialect) with autocomplete, custom linter, formatter (`sql-formatter`)
- **Virtualisation**: `@tanstack/react-virtual` — used in both TableView and SqlEditor result grid
- **Backend**: Tauri 2.10, `mysql_async` 0.34, tokio, `tauri-plugin-dialog`, `tauri-plugin-opener`
- **State persistence**: `rusqlite` (local settings db) + `keyring` (passwords)
- **Linter/formatter**: Biome (single source of truth; do not add ESLint/Prettier)

## Environment (critical)

- **Rust must come from rustup**, not Homebrew. The Homebrew `rustc 1.86` fails dependency resolution; rustup ships 1.92+.
  ```bash
  PATH="$HOME/.cargo/bin:$PATH" pnpm tauri dev
  ```
- **Node**: 22 (via `pnpm`), **pnpm**: 9.x
- **macOS**: Darwin 25+ (Tahoe). Icon bundle uses Icon Composer `.icon` format; Tauri reads `icons/icon.icns` / `icons/icon.ico`.

## Top-level layout

```
src/                      React app
├── App.tsx               Main: tab orchestration, shortcuts, command palette, overlays
├── components/
│   ├── CommandPalette.tsx     ⌘K palette — actions / connections / tables
│   ├── ConnectingOverlay.tsx  Blocking modal during open_connection
│   ├── ConnectionForm.tsx     New/edit connection form (SSH, SSL, Cleartext)
│   ├── DatabaseBrowser.tsx    Sidebar: databases + tables, embedded TableDetail
│   ├── EditorPanes.tsx        Split-pane layout for SQL editor tabs
│   ├── SavedConnections.tsx   Sidebar connection list (skeletons, open/close, indeterminate bar)
│   ├── ShortcutsModal.tsx     ⌘/ help
│   ├── SettingsModal.tsx      ⌘, — theme / font / language / tab width
│   ├── SqlEditor.tsx          CodeMirror + streaming results + virtualised grid
│   ├── StatusBar.tsx          Bottom bar: conn color, host, version, db, rows, ms, pending
│   ├── TabBar.tsx             Top tab strip (drag-reorder, drag-into-pane)
│   ├── TableDetail.tsx        Data/Structure tabs around TableView
│   ├── TableView.tsx          Virtualised editable grid (filter, sort, copy, commit)
│   └── ui/                    Primitives: empty-state, kbd-hint, skeleton, shadcn input
├── lib/
│   ├── fuzzy.ts               Shared fuzzy matcher for palettes
│   ├── i18n.tsx               en / ja dictionary + useT / useLocale hooks
│   ├── row-format.ts          TSV/CSV/JSON/SQL INSERT serialisers
│   ├── settings.tsx           SettingsProvider (theme, fontScale, tabWidth, locale, confirmDestructive)
│   ├── sql-lint.ts            CodeMirror linter: unclosed quotes / unbalanced parens / block comments
│   ├── status-color.ts        Connection colour palette (Tokyo Night)
│   ├── tab-status.tsx         Per-tab status publish context (rows, elapsedMs, pending)
│   └── tauri.ts               Typed invoke wrappers incl. executeQueryStream
├── main.tsx                   Root: SettingsProvider > I18nProvider > TabStatusProvider > App
└── index.css                  Tokyo Night tokens (dark + light), body styles, indeterminate keyframe

src-tauri/                Rust side
├── src/commands/
│   ├── connection.rs     open/close/list/save; SSH tunnel orchestration
│   ├── schema.rs         list_*, describe_table, select_table_rows,
│   │                     execute_query, execute_query_stream, cancel_query, commit_changes
│   ├── export.rs         CSV/TSV/JSON/SQL export
│   ├── import.rs         CSV import
│   ├── history.rs        Per-connection query history
│   └── snippets.rs       Saved SQL snippets
├── src/state.rs          AppState: pools, local_db, running_queries (for cancel)
├── src/db/ssh_tunnel.rs  russh-based SSH tunnel
└── tauri.conf.json       App identifier, window config, bundle icons

scripts/sync-version.mjs  Tag → tauri.conf.json / Cargo.toml [package] / package.json
.github/workflows/release.yml  macOS arm64/x64 + Windows x64 dmg/msi build on v* tag
```

## Architecture notes

### Tab model (App.tsx)
- `Tab = ConnectionTab | TableTab | EditorTab`. EditorTab holds `panes: EditorPane[]` (SQL split panes).
- Persisted to `localStorage` key `porpoise.tabs.v2` (debounced 500ms).
- **Always mounted** per `activeIds` — switching tabs only toggles `hidden`, so SqlEditor's run state / filters / pane widths survive.
- Drag a tab onto the editor area → merges as a pane (same-connection only).

### SQL execution flow
- `SqlEditor.runOneStreaming` → `executeQueryStream` → Tauri invokes `execute_query_stream` → Rust `run_stream_inner` streams `query_iter` in `STREAM_BATCH_ROWS=500` chunks via Tauri `emit`:
  - `query:{request_id}:columns` (first)
  - `query:{request_id}:rows` (each batch with running `fetched`)
  - `query:{request_id}:done` or `:affected` (final)
  - `query:{request_id}:error` (caught; command itself returns Ok to avoid double-throw)
- Rows are **accumulated in a ref**, only `fetched` count goes to state — keeps React re-render small even for 100k+ rows.
- **Cancel**: every in-flight query registers `(tauri_conn_id, mysql_thread_id)` in `AppState.running_queries`. `cancel_query(request_id)` opens a side pool conn and runs `KILL QUERY {thread_id}`. Wired to `⌘.` + Cancel button.

### Settings + i18n
- `SettingsProvider` (localStorage `porpoise.settings.v1`) → `I18nProvider` resolves `auto` locale from `navigator.language` → `useT()` typed hook.
- Dictionary literals in `src/lib/i18n.tsx`. Dynamic strings use function values: `"status.rows": (n) => ...`.

### Status bar
- `TabStatusContext` lets each tab publish `{ rows, fetched?, elapsedMs?, pending?, database? }` keyed by tabId.
- `<StatusBar>` reads the active tab's status; shows connection color dot, host:port, `MySQL {version}`, `db`, `table`, live counts.

### Theme
- `.dark` / `.light` classes on `html` with full Tokyo Night palette (see `index.css`). Accent is blue `#7aa2f7` (dark) / `#2e5cc5` (light). Light theme uses near-black text (user requested), not Tokyo Night Day's blue fg.

### Filters (TableView)
- TablePlus-style: per-row checkbox + per-row Apply button, plus toolbar Apply All (checked filters, implicit AND).
- Right-click a cell → Quick filter (=/≠/LIKE %…% / IS NULL / IS NOT NULL) against that cell's value.
- Right-click a column header → "Filter with this column…".

## Dev workflow

```bash
# Run the full desktop app
PATH="$HOME/.cargo/bin:$PATH" pnpm tauri dev

# Type + lint before pushing (CI runs biome ci + tsc + cargo fmt --check)
pnpm tsc --noEmit
pnpm biome ci .
cargo fmt --all --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings

# Release: tag vX.Y.Z, push, workflow builds dmg/msi
# scripts/sync-version.mjs rewrites the 3 version files from the tag
git tag -a v0.3.0 -m "v0.3.0" && git push origin v0.3.0
```

## CI and conventions

- **Branch → PR**: direct pushes to `main` are blocked. Always `git checkout -b feat/...` then `gh pr create`.
- **`gh pr create` auth**: works under the personal `hiraishikentaro` account (EMU blocks the `hiraishi_sansan` account). Use `gh auth switch -u hiraishikentaro` before creating.
- **Biome is authoritative**: run `pnpm biome format --write` on failures. CI is `pnpm biome ci .`.
- **Rust fmt + clippy**: CI runs `cargo fmt --check` and `cargo clippy -D warnings`. When touching Rust, run fmt locally.
- **Commit style**: conventional-commit-ish (`feat(ui):` / `fix(editor):` / `perf:` / `ci(release):`). Include the `Co-Authored-By: Claude Opus ... <noreply@anthropic.com>` trailer.
- **Never amend merged/pushed commits.** Create new commits.

## User preferences to keep

- Japanese first-language; replies in Japanese unless the user switches. Keep technical terms in English.
- Prefer **minimal, production-quality** diffs over speculative refactors. No feature flags or "future-proof" abstractions.
- No emojis in code or comments. In chat, match the user's tone.
- Comments in code: only when the *why* is non-obvious. Don't narrate *what*.
- Ask before destructive ops (force push, tag overwrite, dropping tables). Local branches and tests are free to experiment with.

## Known gotchas

- **WKWebView autocorrect**: `App.tsx` has a global `MutationObserver` that stamps `autocomplete=off autocorrect=off autocapitalize=off spellcheck=false` on every non-password input. Don't remove it — macOS otherwise shows the predictive "Eig"-style chips in the command palette.
- **`<col>` dynamic width is unreliable in WKWebView**. The SQL result grid uses `width/minWidth/maxWidth` directly on `<th>` (not `<colgroup>`).
- **Skeletons flicker on fast loads**. TableView gates the loading skeleton behind a 180ms timer so short loads (<180ms) skip the skeleton entirely.
- **`request_id` must be UUID v4** for `execute_query` / `cancel_query`. The frontend uses `crypto.randomUUID()` with a fallback.
- **Tauri's `State<'_, AppState>` can't cross every await** — dereference to the inner `Mutex` up-front when possible.
- **Odd row stripe vs selection**: `odd:bg-*` has higher specificity than a plain utility. Apply them mutually exclusive (selected XOR stripe).
