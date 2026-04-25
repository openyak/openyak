/**
 * Dev launcher for browser-based frontend + backend work.
 *
 * The backend requires a per-run bearer token for every /api request.
 * Tauri obtains that token through IPC, but plain `next dev` has no shell
 * bridge. For browser dev, generate one fresh token and give it to both
 * processes: backend accepts it only in debug mode, and Next rewrites add it
 * to proxied /api requests.
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";

const token = `openyak_st_${randomBytes(32).toString("base64url")}`;

const env = {
  ...process.env,
  OPENYAK_ALLOW_DEV_SESSION_TOKEN: "true",
  OPENYAK_DEV_SESSION_TOKEN: token,
  NEXT_PUBLIC_OPENYAK_DEV_SESSION_TOKEN: token,
  NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000",
};

const cmd = [
  "npx concurrently -k",
  "-n backend,frontend",
  "-c blue,green",
  "\"npm run dev:backend\"",
  "\"npm run dev:frontend\"",
].join(" ");

const proc = spawn(cmd, [], { stdio: "inherit", shell: true, env });

proc.on("exit", (code) => process.exit(code ?? 1));
