import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.OPENYAK_UI_TEST_PORT ?? 3317);
const baseURL = `http://127.0.0.1:${PORT}`;
const headless =
  process.env.OPENYAK_UI_HEADLESS !== undefined
    ? process.env.OPENYAK_UI_HEADLESS === "true"
    : Boolean(process.env.CI);
const workers = Number(process.env.OPENYAK_UI_WORKERS ?? 2);

export default defineConfig({
  testDir: "./tests/ui",
  globalSetup: "./tests/ui/global-setup.ts",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers,
  reporter: process.env.CI ? [["dot"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    headless,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: `npm run dev -- --hostname 127.0.0.1 --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 960 } },
    },
    {
      name: "mobile-chromium",
      use: { ...devices["Pixel 7"] },
    },
  ],
});
