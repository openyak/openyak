#!/usr/bin/env node
/**
 * Generate a SHA-256 checksum table for release artifacts, formatted as
 * Markdown ready to append to GitHub release notes. Power users (package
 * maintainers, security researchers, enterprise IT) get a verifiable
 * anchor; normal users ignore it. The signed Tauri auto-updater handles
 * day-to-day integrity, so this is the "trust but verify" affordance for
 * the first install only.
 *
 * Usage:
 *   node scripts/generate-checksums.mjs <artifacts-dir> [out-file]
 *
 * If out-file is omitted, writes Markdown to stdout.
 */

import { createReadStream, readdirSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { argv, exit, stdout } from "node:process";

const root = argv[2];
const out = argv[3];
if (!root) {
  console.error("usage: generate-checksums.mjs <artifacts-dir> [out-file]");
  exit(2);
}

const INSTALLER_RE = /\.(exe|dmg|deb|rpm|tar\.gz)$/i;
const SIG_RE = /\.sig$/i;

function* walk(dir) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

async function sha256(file) {
  const h = createHash("sha256");
  for await (const chunk of createReadStream(file)) h.update(chunk);
  return h.digest("hex");
}

const rows = [];
for (const path of walk(root)) {
  const name = basename(path);
  if (SIG_RE.test(name) || !INSTALLER_RE.test(name)) continue;
  rows.push({ name, hex: await sha256(path), size: statSync(path).size });
}
rows.sort((a, b) => a.name.localeCompare(b.name));

if (rows.length === 0) {
  console.error(`[generate-checksums] no installer artifacts found under ${root}`);
  exit(1);
}

const md = [
  "## SHA-256 Checksums",
  "",
  "Verify your download by comparing its SHA-256 against the table below.",
  "On Linux: `sha256sum <file>`. On macOS: `shasum -a 256 <file>`.",
  "On Windows (PowerShell): `Get-FileHash -Algorithm SHA256 <file>`.",
  "",
  "| File | SHA-256 | Size |",
  "|------|---------|------|",
  ...rows.map(
    (r) => `| \`${r.name}\` | \`${r.hex}\` | ${(r.size / 1024 / 1024).toFixed(1)} MB |`,
  ),
  "",
].join("\n");

if (out) {
  writeFileSync(out, md);
  console.error(`[generate-checksums] wrote ${rows.length} entries to ${out}`);
} else {
  stdout.write(md);
}
