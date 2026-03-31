/**
 * Dev launcher that auto-picks a free port for the frontend,
 * then passes it to both Next.js (--port) and Tauri (TAURI_CONFIG override).
 */
import { createServer } from "node:net";
import { spawn } from "node:child_process";

async function findFreePort(preferred = 3000) {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(preferred, "0.0.0.0", () => {
      server.close(() => resolve(preferred));
    });
    server.on("error", () => {
      // preferred port busy — let OS assign one
      const s = createServer();
      s.listen(0, "0.0.0.0", () => {
        const port = s.address().port;
        s.close(() => resolve(port));
      });
    });
  });
}

const port = await findFreePort(3000);
const backendPort = await findFreePort(8000);
console.log(`\x1b[33m[dev-desktop] Using frontend port: ${port}\x1b[0m`);
console.log(`\x1b[33m[dev-desktop] Using backend port: ${backendPort}\x1b[0m`);

const env = {
  ...process.env,
  DEV_BACKEND_PORT: String(backendPort),
  NEXT_PUBLIC_API_URL: `http://localhost:${backendPort}`,
  // Tauri merges TAURI_CONFIG JSON into tauri.conf.json at runtime
  TAURI_CONFIG: JSON.stringify({
    build: { devUrl: `http://localhost:${port}` },
  }),
};

const cmd = [
  "npx concurrently -k",
  "-n backend,frontend,tauri",
  "-c blue,green,yellow",
  `"cd backend && ./venv/bin/python -m uvicorn app.main:create_app --factory --reload --reload-dir app --host 0.0.0.0 --port ${backendPort}"`,
  `"cd frontend && npx next dev --turbopack --port ${port}"`,
  `"cd desktop-tauri && cargo tauri dev"`,
].join(" ");

const proc = spawn(cmd, [], { stdio: "inherit", shell: true, env });

proc.on("exit", (code) => process.exit(code ?? 1));
