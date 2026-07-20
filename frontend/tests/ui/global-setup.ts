import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

/**
 * The PDF renderer loads its worker from /pdf.worker.min.mjs, which the
 * production `build` script copies out of pdfjs-dist into public/. `next dev`
 * (what the Playwright webServer runs) skips that copy, so the office-artifact
 * test's PDF pane renders no <canvas> and the suite is red for an environment
 * reason, not a product one. Stage the worker (and the cmaps/fonts the same
 * build step copies) before the dev server starts so the test is reliable in
 * CI and locally, regardless of whether a prior `next build` happened to leave
 * the asset behind.
 */
export default function globalSetup() {
  const root = resolve(__dirname, "..", "..");
  const pub = resolve(root, "public");
  const dist = resolve(root, "node_modules", "pdfjs-dist");

  const worker = resolve(pub, "pdf.worker.min.mjs");
  const src = resolve(dist, "build", "pdf.worker.min.mjs");
  if (!existsSync(worker) && existsSync(src)) {
    mkdirSync(dirname(worker), { recursive: true });
    cpSync(src, worker);
  }

  for (const dir of ["cmaps", "standard_fonts"]) {
    const dest = resolve(pub, dir);
    const from = resolve(dist, dir);
    if (!existsSync(dest) && existsSync(from)) {
      cpSync(from, dest, { recursive: true });
    }
  }
}
