import { expect, test, type Page } from "@playwright/test";
import fs from "node:fs/promises";
import path from "node:path";
import { mockOpenYakApi, seedOpenYakStorage } from "./fixtures/openyak-api";

const repoRoot = path.resolve(__dirname, "../../..");
const artifactRoot = path.join(repoRoot, ".codex-artifacts", "openyak-readme-media-clean-20260428");
const frameRoot = path.join(artifactRoot, "frames");
const stillRoot = path.join(artifactRoot, "stills");

type UploadFixture = {
  name: string;
  mimeType: string;
  body: string;
};

const files = {
  feedbackDoc: {
    name: "customer-feedback-notes.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    body: "Customer feedback notes about onboarding, pricing, and support handoffs.",
  },
  budgetSheet: {
    name: "budget-review.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    body: "Budget, actual, forecast, owner, variance.",
  },
  launchMemo: {
    name: "launch-readiness-memo.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    body: "Launch readiness memo for Product, CS, Finance, and Legal.",
  },
  launchBudget: {
    name: "launch-budget.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    body: "Launch budget with support contractor variance.",
  },
  launchDeck: {
    name: "launch-board-deck.pptx",
    mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    body: "Board deck with launch decision slides.",
  },
  vendorTerms: {
    name: "vendor-terms-summary.pdf",
    mimeType: "application/pdf",
    body: "Vendor terms summary with renewal notice and DPA clauses.",
  },
} satisfies Record<string, UploadFixture>;

test.describe("OpenYak clean light README media", () => {
  test.describe.configure({ mode: "serial", timeout: 900_000 });
  test.skip(
    process.env.OPENYAK_CAPTURE_README_MEDIA !== "true",
    "README media capture is an explicit documentation asset generation workflow.",
  );

  test.use({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 2,
    colorScheme: "light",
  });

  test.beforeAll(async () => {
    await fs.rm(artifactRoot, { recursive: true, force: true });
    await fs.mkdir(frameRoot, { recursive: true });
    await fs.mkdir(stillRoot, { recursive: true });
  });

  test("record memo-to-brief workflow", async ({ page }) => {
    await setupCleanLightApp(page);
    const recorder = await recorderFor("memo-to-brief");
    await page.goto("/c/new");
    await expectHome(page);
    await recorder.capture(page);

    await uploadFiles(page, [files.feedbackDoc]);
    await fillPrompt(
      page,
      "Can you turn the attached customer feedback notes into a VP-ready memo? I need the top three themes, revenue risk, owners, and the email I can send this afternoon.",
    );
    await recorder.capture(page);

    await submitCurrentPrompt(page);
    await expect(page.locator("#main-content").getByText("VP-ready memo").last()).toBeVisible({ timeout: 25_000 });
    await recorder.capture(page);
    await saveStill(page, "openyak-docx-brief.png", { x: 430, y: 95, width: 1120, height: 850 });
  });

  test("record budget-analysis still", async ({ page }) => {
    await setupCleanLightApp(page);
    await page.goto("/c/new");
    await expectHome(page);
    await uploadFiles(page, [files.budgetSheet]);
    await fillPrompt(
      page,
      "I attached the budget workbook. Please review it like Finance would: compare budget, actuals, and forecast, call out the biggest variance, and tell me what to ask the owners.",
    );
    await submitCurrentPrompt(page);
    await expect(page.locator("#main-content").getByText("Finance review").last()).toBeVisible({ timeout: 25_000 });
    await saveStill(page, "openyak-budget-analysis.png", { x: 430, y: 95, width: 1120, height: 850 });
  });

  test("record multi-file artifact workflow", async ({ page }) => {
    await setupCleanLightApp(page);
    const recorder = await recorderFor("workflow-artifacts");
    await page.goto("/c/new");
    await expectHome(page);
    await recorder.capture(page);

    await uploadFiles(page, [files.launchMemo, files.launchBudget, files.launchDeck, files.vendorTerms]);
    await fillPrompt(
      page,
      "I am preparing a launch readiness review. Please read these files together and create a board-ready brief with decisions, open risks, owners, and a follow-up workflow artifact.",
    );
    await recorder.capture(page);

    await submitCurrentPrompt(page);
    await expect(page.locator("#main-content").getByText("Board-ready launch brief", { exact: true }).last()).toBeVisible({
      timeout: 25_000,
    });
    await recorder.capture(page);

    await openArtifactPanel(page);
    await recorder.capture(page);
    await saveStill(page, "openyak-artifact-panel.png");
  });

  test("record long-context and auto-compress workflow", async ({ page }) => {
    await setupCleanLightApp(page);
    await page.goto("/c/session-long");
    await expect(page.getByText("Long conversation load test").first()).toBeVisible();
    await expect(page.getByText("Long assistant turn 060")).toBeVisible();
    await saveStill(page, "openyak-long-context.png");

    const recorder = await recorderFor("auto-compress");
    await page.goto("/c/new");
    await expectHome(page);
    await recorder.capture(page);
    await fillPrompt(page, "Please auto compress this long launch review thread, then summarize the owners, deadlines, risks, and next decision without losing the context.");
    await recorder.capture(page);
    await submitCurrentPrompt(page);
    await expect(page.getByText("Auto compacted answer persisted after compression.")).toBeVisible({ timeout: 25_000 });
    await expect(page.getByText("Context compressed to save tokens")).toBeVisible();
    await recorder.capture(page);
  });

  test("record upload error recovery still", async ({ page }) => {
    await setupCleanLightApp(page, { failUploads: ["broken-upload.txt"] });
    await page.goto("/c/new");
    await expectHome(page);
    await page.locator('input[type="file"]').setInputFiles({
      name: "broken-upload.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("this upload should fail"),
    });
    await expect(page.getByText("Failed to upload file")).toBeVisible();
    await expect(page.getByPlaceholder(/Describe the result you want/i)).toBeVisible();
    await saveStill(page, "openyak-error-recovery.png");
  });
});

async function setupCleanLightApp(page: Page, options?: Parameters<typeof mockOpenYakApi>[1]) {
  await seedOpenYakStorage(page, { force: true });
  await page.addInitScript(() => {
    window.localStorage.setItem("theme", "light");
    window.localStorage.setItem(
      "openyak-settings",
      JSON.stringify({
        state: {
          hasCompletedOnboarding: true,
          selectedModel: "openai-subscription/gpt-5.5",
          selectedProviderId: "openai-subscription",
          selectedAgent: "build",
          safeMode: false,
          workMode: "auto",
          reasoningEnabled: true,
          permissionPresets: { fileChanges: true, runCommands: true },
          savedPermissions: [],
          workspaceDirectory: null,
          hasSeenHints: true,
          language: "en",
          activeProvider: "chatgpt",
        },
        version: 0,
      }),
    );
  });
  await page.addInitScript(() => {
    const inject = () => {
      const style = document.createElement("style");
      style.textContent = `
        nextjs-portal,
        [data-nextjs-dev-tools-button],
        [data-nextjs-dialog-overlay],
        [data-nextjs-toast],
        [data-nextjs-dev-tools-panel] {
          display: none !important;
          opacity: 0 !important;
          pointer-events: none !important;
        }
      `;
      document.documentElement.appendChild(style);
    };
    if (document.documentElement) inject();
    else document.addEventListener("DOMContentLoaded", inject, { once: true });
  });
  await mockOpenYakApi(page, options);
}

async function expectHome(page: Page) {
  await expect(page.getByRole("heading", { name: /What should (OpenYak help you do|we do in)/i })).toBeVisible();
  await expect(page.locator("html")).not.toHaveClass(/dark/);
  await expect(page.getByText("Runtime", { exact: false })).toHaveCount(0);
  await expect(page.getByText("API 401", { exact: false })).toHaveCount(0);
}

async function uploadFiles(page: Page, uploadFixtures: UploadFixture[]) {
  await page.locator('input[type="file"]').setInputFiles(
    uploadFixtures.map((file) => ({
      name: file.name,
      mimeType: file.mimeType,
      buffer: Buffer.from(file.body),
    })),
  );
  for (const file of uploadFixtures) {
    await expect(page.getByText(file.name)).toBeVisible();
  }
}

async function fillPrompt(page: Page, prompt: string) {
  await page.getByPlaceholder(/Describe the result you want/i).fill(prompt);
}

async function submitCurrentPrompt(page: Page) {
  const sendButton = page.getByRole("button", { name: /Send message/i });
  await expect(sendButton).toBeEnabled({ timeout: 10_000 });
  const promptResponse = page.waitForResponse((res) =>
    res.url().includes("/api/chat/prompt") && res.status() === 200,
  );
  await sendButton.click();
  await promptResponse;
  try {
    await expect(page).toHaveURL(/\/c\/session-new$/, { timeout: 10_000 });
  } catch {
    await page.getByRole("option", { name: /Create a UI preflight checklist/i }).click();
    await expect(page).toHaveURL(/\/c\/session-new$/);
  }
}

async function openArtifactPanel(page: Page) {
  const artifact = page.getByText("Board-ready Launch Brief", { exact: true }).last();
  await artifact.scrollIntoViewIfNeeded();
  await artifact.click();
  await expect(page.getByText("Executive Summary").last()).toBeVisible({ timeout: 10_000 });
}

async function saveStill(
  page: Page,
  filename: string,
  clip?: { x: number; y: number; width: number; height: number },
) {
  await page.screenshot({ path: path.join(stillRoot, filename), fullPage: false, clip });
}

async function recorderFor(name: string) {
  const dir = path.join(frameRoot, name);
  await fs.mkdir(dir, { recursive: true });
  let index = 0;
  return {
    async capture(page: Page) {
      const current = index++;
      for (let repeat = 0; repeat < 10; repeat += 1) {
        await page.screenshot({
          path: path.join(dir, `${String(current * 10 + repeat).padStart(4, "0")}.png`),
          fullPage: false,
        });
      }
    },
  };
}
