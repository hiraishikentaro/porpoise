# Porpoise

TablePlus ライクな軽量 MySQL GUI クライアント (Tauri + Rust + React)。

開発プラン・アーキテクチャ詳細は [`plan.md`](./plan.md) 参照。

## 前提 toolchain

- Node.js 22+ / pnpm 9+
- Rust stable (rustup 管理、rustc 1.88 以上)
  - **注意**: Homebrew で入れた `rust` (1.86) は tauri 2.10 の依存解決に失敗する。rustup で stable を入れて `~/.cargo/bin` を PATH の先頭に置くこと。
  - ワンショットで回避するなら `PATH="$HOME/.cargo/bin:$PATH" pnpm tauri dev` のようにプレフィックス
- macOS: Xcode Command Line Tools

## セットアップ

```bash
pnpm install
```

## 開発

### アプリを起動 (Vite + Rust + ウィンドウ)

```bash
pnpm tauri dev
# Homebrew rust が PATH 上位にある場合:
PATH="$HOME/.cargo/bin:$PATH" pnpm tauri dev
```

初回は Rust の依存をビルドするため数分かかる。2 回目以降はインクリメンタルで数秒〜数十秒。

### フロントエンドのみ (ブラウザで軽く確認)

```bash
pnpm dev  # http://localhost:1420
```

### プロダクションビルド

```bash
PATH="$HOME/.cargo/bin:$PATH" pnpm tauri build
```

## Lint / Format

| コマンド | 対象 |
| --- | --- |
| `pnpm check` | Biome で lint + format + import 整理を一括適用 |
| `pnpm lint` | Biome lint のみ |
| `pnpm format` | Biome format のみ |
| `cargo fmt` | Rust 整形 (`src-tauri/` 配下で、または `cd src-tauri && cargo fmt`) |
| `cargo clippy --all-targets -- -D warnings` | Rust lint |

Biome は `src/components/ui/**` (shadcn 生成物) と `src-tauri/target/**` / `dist/**` / `node_modules/**` を除外。

## ディレクトリ構成

```
src/                 React + TypeScript (Vite)
  components/ui/     shadcn/ui 生成物 (radix/nova プリセット)
  lib/utils.ts       cn() ヘルパー
src-tauri/           Rust 側 (Tauri 2)
  src/main.rs        エントリポイント
  src/lib.rs         #[tauri::command] と run()
  tauri.conf.json    Tauri 設定 (productName, windows, bundle)
plan.md              プロダクトゴール・8 Phase のロードマップ
```

## 推奨 IDE

- VS Code + [Tauri 拡張](https://marketplace.visualstudio.com/items?itemName=tauri-apps.tauri-vscode) + [rust-analyzer](https://marketplace.visualstudio.com/items?itemName=rust-lang.rust-analyzer) + [Biome 拡張](https://marketplace.visualstudio.com/items?itemName=biomejs.biome)
