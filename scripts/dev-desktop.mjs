/**
 * Dev launcher that auto-picks a free port for the frontend,
 * then passes it to both Next.js (--port) and Tauri (TAURI_CONFIG override).
 */
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

async function findFreePort(preferred = 3000, host = "0.0.0.0") {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(preferred, host, () => {
      server.close(() => resolve(preferred));
    });
    server.on("error", () => {
      // preferred port busy — let OS assign one
      const s = createServer();
      s.listen(0, host, () => {
        const port = s.address().port;
        s.close(() => resolve(port));
      });
    });
  });
}

const port = await findFreePort(3000);
const backendHost = "127.0.0.1";
const backendPort = await findFreePort(8000, backendHost);
console.log(`\x1b[33m[dev-desktop] Using frontend port: ${port}\x1b[0m`);
console.log(`\x1b[33m[dev-desktop] Using backend port: ${backendPort}\x1b[0m`);

const env = {
  ...process.env,
  DEV_BACKEND_PORT: String(backendPort),
  // Dev backend writes session_token.json under backend/data/ (cwd=backend).
  // Pin the absolute path so the Tauri dev binary reads the same token
  // regardless of where `cargo tauri dev` is invoked from.
  DEV_BACKEND_DATA_DIR: resolve(process.cwd(), "backend", "data"),
  // The backend default (``session_token.json``) assumes the prod
  // ``run.py`` has chdired into ``--data-dir``. Dev runs uvicorn from
  // ``backend/`` directly (no chdir), so override the path to keep the
  // file under ``backend/data/`` where ``DEV_BACKEND_DATA_DIR`` says
  // Tauri will poll for it.
  OPENYAK_SESSION_TOKEN_PATH: "data/session_token.json",
  NEXT_PUBLIC_API_URL: `http://${backendHost}:${backendPort}`,
  // Tauri merges TAURI_CONFIG JSON into tauri.conf.json at runtime
  TAURI_CONFIG: JSON.stringify({
    build: { devUrl: `http://localhost:${port}` },
  }),
};

const cmd = [
  "npx concurrently -k",
  "-n backend,frontend,tauri",
  "-c blue,green,yellow",
  `"cd backend && venv/bin/python -m uvicorn app.main:create_app --factory --reload --reload-dir app --host ${backendHost} --port ${backendPort}"`,
  `"cd frontend && npx next dev --turbopack --port ${port}"`,
  `"cd desktop-tauri && cargo tauri dev"`,
].join(" ");

const proc = spawn(cmd, [], { stdio: "inherit", shell: true, env });

proc.on("exit", (code) => process.exit(code ?? 1));
