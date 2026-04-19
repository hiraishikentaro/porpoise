#!/usr/bin/env node
// 指定 version を src-tauri/tauri.conf.json, src-tauri/Cargo.toml ([package] のみ),
// package.json の 3 箇所に書き戻す。
// Release ワークフローで tag → dmg / msi のファイル名を正しくするために使う。
//
// 使い方:  node scripts/sync-version.mjs 1.2.3

import { readFileSync, writeFileSync } from "node:fs";

const version = process.argv[2]?.trim();
if (!version || /^\d+\.\d+\.\d+([-+].*)?$/.test(version) === false) {
  console.error(`Usage: node scripts/sync-version.mjs <semver>  (got: ${JSON.stringify(version)})`);
  process.exit(1);
}

for (const f of ["src-tauri/tauri.conf.json", "package.json"]) {
  const j = JSON.parse(readFileSync(f, "utf8"));
  j.version = version;
  writeFileSync(f, `${JSON.stringify(j, null, 2)}\n`);
  console.log(`Updated ${f} → ${version}`);
}

const cargoPath = "src-tauri/Cargo.toml";
const cargo = readFileSync(cargoPath, "utf8");
// [package] セクション直下の最初の version = "..." だけを書き換える。
// 依存の version = "2" など他の値は触らない。
const updated = cargo.replace(
  /(\[package\][\s\S]*?\nversion\s*=\s*")[^"]+(")/,
  (_, a, b) => `${a}${version}${b}`,
);
if (updated === cargo) {
  console.error("Failed to find [package] version in Cargo.toml");
  process.exit(1);
}
writeFileSync(cargoPath, updated);
console.log(`Updated ${cargoPath} → ${version}`);
