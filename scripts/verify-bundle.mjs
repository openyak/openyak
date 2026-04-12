#!/usr/bin/env node
/**
 * Verify a PyInstaller bundle of the OpenYak backend.
 *
 * This is the single source of truth for "what must ship inside
 * backend/dist/openyak-backend/" — shared by local dev and CI so the
 * two can never drift.
 *
 * Usage:
 *   node scripts/verify-bundle.mjs [dist-dir]
 *   node scripts/verify-bundle.mjs backend/dist/openyak-backend
 *   node scripts/verify-bundle.mjs path/to/OpenYak.app/Contents/Resources/backend
 *
 * Exits non-zero (with a loud message) if anything critical is missing.
 * Why this exists: 1.0.7 shipped without `frontend_out` because the
 * PyInstaller spec silently filtered missing paths, so the mobile PWA
 * over cloudflare tunnel returned 404. Never let that happen again.
 */

import { existsSync, statSync, readdirSync, mkdtempSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { argv, env, exit, platform } from "node:process";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const distArg = argv[2] ?? "backend/dist/openyak-backend";
const dist = resolve(distArg);

if (!existsSync(dist)) {
  fail(`bundle directory does not exist: ${dist}`);
}

const internal = join(dist, "_internal");
const exeName = platform === "win32" ? "openyak-backend.exe" : "openyak-backend";

/**
 * Each entry describes one required asset. `kind` is "file" | "dir"
 * | "nonempty-dir". Add new entries as new resources are bundled —
 * CI will start failing until reality matches the contract.
 */
const required = [
  { kind: "file", path: join(dist, exeName), why: "backend launcher" },

  { kind: "dir", path: internal, why: "PyInstaller _internal/ tree" },

  // Alembic (DB migrations run at startup)
  { kind: "nonempty-dir", path: join(internal, "alembic"), why: "DB migrations" },
  { kind: "file", path: join(internal, "alembic.ini"), why: "alembic config" },

  // Agent prompt templates
  {
    kind: "nonempty-dir",
    path: join(internal, "app", "agent", "prompts"),
    why: "agent prompt templates",
  },

  // Bundled data (skills/plugins/connectors)
  {
    kind: "file",
    path: join(internal, "app", "data", "connectors.json"),
    why: "connectors registry",
  },
  {
    kind: "dir",
    path: join(internal, "app", "data", "skills"),
    why: "builtin skills",
  },
  {
    kind: "dir",
    path: join(internal, "app", "data", "plugins"),
    why: "builtin plugins",
  },

  // Frontend static export — served by FastAPI at /m for mobile PWA.
  // Without these files, cloudflare-tunnel remote access is broken
  // while the desktop UI continues to work (Tauri serves its own copy).
  {
    kind: "dir",
    path: join(internal, "frontend_out"),
    why: "mobile PWA static export (remote access over tunnel)",
  },
  {
    kind: "file",
    path: join(internal, "frontend_out", "m.html"),
    why: "mobile PWA entry point — /m over tunnel",
  },
  {
    kind: "file",
    path: join(internal, "frontend_out", "index.html"),
    why: "frontend root",
  },
  {
    kind: "nonempty-dir",
    path: join(internal, "frontend_out", "_next", "static"),
    why: "Next.js static chunks — without these the PWA won't boot",
  },

  // Critical Python packages that MUST be inside the bundle as
  // extracted top-level directories. These catch the "PyInstaller ran
  // against the wrong python env" failure mode: the spec's collect_all()
  // silently returns empty when the package isn't installed, so the
  // build technically succeeds but the backend crashes at startup with
  // "No module named 'uvicorn'". Without these checks verify-bundle
  // would happily pass a dead bundle.
  //
  // Only packages with C extensions or datas land here — pure-python
  // packages like fastapi / starlette / pydantic get packed into
  // PYZ-00.pyz and are not visible as directories. They're covered by
  // the runtime smoke test below.
  {
    kind: "nonempty-dir",
    path: join(internal, "uvicorn"),
    why: "ASGI server — has data files via collect_all",
  },
  {
    kind: "nonempty-dir",
    path: join(internal, "sqlalchemy"),
    why: "ORM — has C extensions",
  },
  {
    kind: "nonempty-dir",
    path: join(internal, "pydantic_core"),
    why: "pydantic Rust core — separate from pure-python pydantic",
  },
  {
    kind: "nonempty-dir",
    path: join(internal, "app"),
    why: "application code",
  },
];

const problems = [];
for (const req of required) {
  if (!existsSync(req.path)) {
    problems.push(`missing ${req.kind}: ${req.path}  (${req.why})`);
    continue;
  }
  const st = statSync(req.path);
  if (req.kind === "file" && !st.isFile()) {
    problems.push(`not a file: ${req.path}  (${req.why})`);
  } else if ((req.kind === "dir" || req.kind === "nonempty-dir") && !st.isDirectory()) {
    problems.push(`not a directory: ${req.path}  (${req.why})`);
  } else if (req.kind === "nonempty-dir" && readdirSync(req.path).length === 0) {
    problems.push(`empty directory: ${req.path}  (${req.why})`);
  }
}

if (problems.length > 0) {
  console.error("\n[verify-bundle] Bundle is INCOMPLETE — refusing to ship:");
  for (const p of problems) console.error(`  ✗ ${p}`);
  console.error(
    "\nThis is the guard that would have caught the 1.0.7 remote-access\n" +
      "regression. Fix the build (openyak.spec + frontend next build) and\n" +
      "re-run before uploading any artifacts.\n",
  );
  exit(1);
}

console.log(`[verify-bundle] static: ${required.length} required assets present in ${dist}`);

// ── Runtime smoke test ───────────────────────────────────────────────
//
// Static checks can't tell whether pure-python packages that live
// inside PYZ-00.pyz (fastapi, starlette, pydantic, …) made it in, nor
// whether the binary actually boots. Launch it on a throwaway port,
// probe /health and /m, then kill it. If it crashes with a missing
// import we catch it here — not in the wild.
//
// Skip with VERIFY_BUNDLE_SKIP_SMOKE=1 on hosts that can't execute
// the target binary (e.g. cross-compiled artifacts inspected on a
// different OS).

if (env.VERIFY_BUNDLE_SKIP_SMOKE === "1") {
  console.log("[verify-bundle] smoke test skipped (VERIFY_BUNDLE_SKIP_SMOKE=1)");
  exit(0);
}

const binary = join(dist, exeName);
const port = 17000 + Math.floor(Math.random() * 500);

await smokeTest(binary, port);

async function smokeTest(bin, port) {
  // Isolated data dir so the smoke test never writes into the repo.
  const dataDir = mkdtempSync(join(tmpdir(), "openyak-smoke-"));
  console.log(`[verify-bundle] smoke: launching ${bin} --port ${port} --data-dir ${dataDir}`);
  const child = spawn(bin, ["--port", String(port), "--data-dir", dataDir], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  const logs = [];
  child.stdout.on("data", (b) => logs.push(b.toString()));
  child.stderr.on("data", (b) => logs.push(b.toString()));

  let crashed = false;
  let crashCode = null;
  child.on("exit", (code) => {
    crashed = true;
    crashCode = code;
  });

  // Poll /m (mobile PWA entry) up to 30 s
  let ok = false;
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (crashed) break;
    try {
      const res = await fetch(`http://127.0.0.1:${port}/m`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.status === 200) {
        const body = await res.text();
        if (body.includes("<html") || body.includes("<!DOCTYPE")) {
          ok = true;
          break;
        }
      }
    } catch {
      // not up yet
    }
    await delay(500);
  }

  child.kill("SIGTERM");
  await delay(500);
  if (!child.killed) child.kill("SIGKILL");
  try {
    rmSync(dataDir, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }

  if (crashed && !ok) {
    console.error(
      `\n[verify-bundle] smoke FAILED: backend exited (code ${crashCode}) before serving /m`,
    );
    console.error("--- last backend output ---");
    console.error(logs.join("").slice(-4000));
    exit(1);
  }
  if (!ok) {
    console.error("\n[verify-bundle] smoke FAILED: /m never returned 200 OK");
    console.error("--- last backend output ---");
    console.error(logs.join("").slice(-4000));
    exit(1);
  }

  console.log("[verify-bundle] smoke: /m served successfully — bundle is live");
}

function fail(msg) {
  console.error(`[verify-bundle] ${msg}`);
  exit(1);
}
