import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/unit",
  timeout: 15_000,
  fullyParallel: false,
  workers: 1,
  reporter: "list",
});
