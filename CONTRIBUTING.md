# Contributing

The short version: branch, push, PR. No direct commits to `main`.

Deeper architectural notes live in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) and [`CLAUDE.md`](./CLAUDE.md).

## Toolchain prerequisites

- **Rust via rustup** (stable, 1.88+). Homebrew's `rust` (1.86) fails Tauri 2.10's dependency resolution — make sure `~/.cargo/bin` is on `PATH` first.
- **Node 22+** via `pnpm 9+`
- **macOS**: Xcode Command Line Tools

```bash
# single-shot prefix if your PATH is polluted
PATH="$HOME/.cargo/bin:$PATH" pnpm tauri dev
```

## Branch / PR workflow

1. Start from a clean `main`:
   ```bash
   git checkout main && git pull --ff-only origin main
   ```
2. Branch with a **typed prefix**: `feat/*`, `fix/*`, `perf/*`, `ci/*`, `docs/*`, `style/*`, `refactor/*`.
3. Push the branch and open a PR. Direct pushes to `main` are blocked.
4. The PR template in [`.github/pull_request_template.md`](./.github/pull_request_template.md) is populated automatically — fill **Summary / Changes / Test plan**.

### GitHub auth caveat (EMU)

`gh pr create` with the work account (`hiraishi_sansan`) is blocked by Enterprise Managed User policy. Switch to the personal account before creating PRs:

```bash
gh auth switch -u hiraishikentaro
gh pr create ...
```

The shared SSH remote URL (`github.com.personal:hiraishikentaro/porpoise.git`) is already configured.

### Stacked PRs

When a feature depends on an open PR, branch off that PR's head and set `--base` explicitly:

```bash
git checkout feat/foundation
git checkout -b feat/on-top-of-foundation
# ... commits ...
gh pr create --head feat/on-top-of-foundation --base feat/foundation
```

When the base PR merges, GitHub auto-retargets the stacked one to `main`. A local `git rebase origin/main` afterwards keeps the branch clean.

## Commit style

Conventional-commits-ish. Examples:

- `feat(ui): hover keyboard hint chips`
- `fix(editor): request_id must be UUIDv4`
- `perf: virtualise SqlEditor result grid`
- `ci(release): sync version from tag before tauri-action build`
- `docs: add CLAUDE.md`

**Always** include the co-author trailer when Claude contributed:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

Create **new** commits to fix lint / type errors — don't amend pushed commits.

## Pre-push checklist

Run locally before pushing. CI enforces the same:

```bash
pnpm tsc --noEmit
pnpm biome ci .
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets -- -D warnings
```

Fixers:

```bash
pnpm biome format --write <path>               # import order + whitespace
pnpm biome check --write <path>                # safe lint fixes
cargo fmt --all --manifest-path src-tauri/Cargo.toml
```

Biome is the **single source of truth**. Do not add ESLint / Prettier.

## Release

- Tag `vX.Y.Z` and push. The release workflow builds macOS (arm64 + x64) and Windows (x64) artifacts into a Draft Release.
- `scripts/sync-version.mjs` rewrites version in `tauri.conf.json`, `Cargo.toml` (`[package]` only), and `package.json` from the tag name. This must run before tauri-action or the artifact filenames stay at `0.1.0`.

```bash
git tag -a v0.3.0 -m "v0.3.0"
git push origin v0.3.0
```

## Testing the app locally

```bash
PATH="$HOME/.cargo/bin:$PATH" pnpm tauri dev
```

HMR runs for frontend (React/CSS). Rust changes trigger a cargo rebuild + relaunch — the dev command handles it.

For UI features, verify the behaviour in a real window. Claude agents cannot drive the WKWebView, so type-checking is not a substitute for a browser pass.
