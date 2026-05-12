import { expect, test, type Page } from "@playwright/test";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import { createServer, type ServerResponse, type Server } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { mockOpenYakApi, seedOpenYakStorage } from "./fixtures/openyak-api";

const execFile = promisify(execFileCallback);

const repoRoot = path.resolve(__dirname, "../../..");
const artifactRoot = path.join(repoRoot, ".codex-artifacts", "openyak-readme-media-20260511");
const frameRoot = path.join(artifactRoot, "frames");
const stillRoot = path.join(artifactRoot, "stills");
const readmeMediaRoot = path.join(repoRoot, "docs", "readme");
let slowStreamServer: Server | undefined;
let slowStreamPort: number | undefined;

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

const gifs = [
  ["workflow-artifacts", "openyak-workflow-artifacts.gif"],
  ["memo-to-brief", "openyak-memo-to-brief.gif"],
  ["auto-compress", "openyak-auto-compress.gif"],
] as const;

const stills = [
  "openyak-artifact-panel.png",
  "openyak-budget-analysis.png",
  "openyak-docx-brief.png",
  "openyak-long-context.png",
] as const;

test.describe("OpenYak README media capture", () => {
  test.describe.configure({ mode: "serial", timeout: 900_000 });
  test.skip(
    process.env.OPENYAK_CAPTURE_README_MEDIA !== "true",
    "README media capture is an explicit documentation asset generation workflow.",
  );

  test.use({
    viewport: { width: 1800, height: 1100 },
    deviceScaleFactor: 1,
    colorScheme: "light",
  });

  test.beforeAll(async () => {
    await fs.rm(artifactRoot, { recursive: true, force: true });
    await fs.mkdir(frameRoot, { recursive: true });
    await fs.mkdir(stillRoot, { recursive: true });
    const started = await startSlowStreamServer();
    slowStreamServer = started.server;
    slowStreamPort = started.port;
  });

  test.afterAll(async () => {
    for (const [frameDirName, filename] of gifs) {
      await renderGif(path.join(frameRoot, frameDirName), path.join(readmeMediaRoot, filename));
    }

    for (const filename of stills) {
      await fs.copyFile(path.join(stillRoot, filename), path.join(readmeMediaRoot, filename));
    }

    await new Promise<void>((resolve) => slowStreamServer?.close(() => resolve()) ?? resolve());
  });

  test("record multi-file artifact workflow", async ({ page }) => {
    await setupCleanLightApp(page);
    await page.goto("/c/new");
    await expectHome(page);

    const recorder = await startRecorder(page, "workflow-artifacts");
    await uploadFiles(page, [files.launchMemo, files.launchBudget, files.launchDeck, files.vendorTerms]);
    await typePromptWithMotion(
      page,
      "I am preparing a launch readiness review. Read these files together and create a board-ready brief with decisions, open risks, owners, and a workflow artifact.",
    );
    await pauseForCapture(page, 300);

    recorder.pause();
    await submitCurrentPrompt(page);
    recorder.resume();
    await expect(page.getByText("Thinking").last()).toBeVisible({ timeout: 10_000 });
    await pauseForCapture(page, 900);
    await expect(page.locator("#main-content").getByText("Board-ready launch brief", { exact: true }).last()).toBeVisible({
      timeout: 25_000,
    });
    await page.mouse.wheel(0, 520);
    await pauseForCapture(page, 500);

    await openArtifactPanel(page);
    await pauseForCapture(page, 1_000);
    await recorder.stop();

    await saveStill(page, "openyak-artifact-panel.png");
  });

  test("record memo-to-brief workflow", async ({ page }) => {
    await setupCleanLightApp(page);
    await page.goto("/c/new");
    await expectHome(page);

    const recorder = await startRecorder(page, "memo-to-brief");
    await uploadFiles(page, [files.feedbackDoc]);
    await typePromptWithMotion(
      page,
      "Turn the attached customer feedback notes into a VP-ready memo with the top three themes, revenue risk, owners, next actions, and a send-ready email.",
    );
    await pauseForCapture(page, 300);

    recorder.pause();
    await submitCurrentPrompt(page);
    recorder.resume();
    await expect(page.getByText("Thinking").last()).toBeVisible({ timeout: 10_000 });
    await pauseForCapture(page, 900);
    await expect(page.locator("#main-content").getByText("VP-ready customer feedback memo").last()).toBeVisible({
      timeout: 25_000,
    });
    await page.mouse.wheel(0, 360);
    await pauseForCapture(page, 800);
    await recorder.stop();

    await saveStill(page, "openyak-docx-brief.png");
  });

  test("record spreadsheet analysis still", async ({ page }) => {
    await setupCleanLightApp(page);
    await page.goto("/c/new");
    await expectHome(page);
    await uploadFiles(page, [files.budgetSheet]);
    await typePromptWithMotion(
      page,
      "Review this launch budget workbook like Finance would: compare budget, actuals, and forecast, call out the biggest variance, and give owner-level actions.",
      1,
    );
    await submitCurrentPrompt(page);
    await expect(page.locator("#main-content").getByText("Finance workbook review").last()).toBeVisible({ timeout: 25_000 });
    await page.mouse.wheel(0, 280);
    await saveStill(page, "openyak-budget-analysis.png");
  });

  test("record long-context still", async ({ page }) => {
    await setupCleanLightApp(page);
    await page.goto("/c/session-long");
    await expect(page.getByText("Long conversation load test").first()).toBeVisible();
    await expect(page.getByText("Final version: launch is approved with conditions.")).toBeVisible();
    await saveStill(page, "openyak-long-context.png");
  });

  test("record auto-compress workflow", async ({ page }) => {
    await setupCleanLightApp(page);
    await page.goto("/c/new");
    await expectHome(page);
    const recorder = await startRecorder(page, "auto-compress");
    await typePromptWithMotion(
      page,
      "Auto compress this long launch review thread, then summarize the owners, deadlines, risks, and next decision without losing the context.",
    );
    await pauseForCapture(page, 300);
    recorder.pause();
    await submitCurrentPrompt(page);
    recorder.resume();
    await expect(page.getByText("Thinking").last()).toBeVisible({ timeout: 10_000 });
    await pauseForCapture(page, 900);
    await expect(page.locator("#main-content").getByText("Auto compacted answer persisted after compression.").last()).toBeVisible({
      timeout: 25_000,
    });
    await expect(page.getByText("Context compressed to save tokens")).toBeVisible();
    await pauseForCapture(page, 1_000);
    await recorder.stop();
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
        body > [class*="fixed"][class*="top-0"][class*="left-0"][class*="right-0"][class*="h-[2px]"] {
          display: none !important;
        }
      `;
      document.documentElement.appendChild(style);
    };
    if (document.documentElement) inject();
    else document.addEventListener("DOMContentLoaded", inject, { once: true });
  });
  await mockOpenYakApi(page, options);
  if (slowStreamPort) {
    await page.route("**/api/chat/stream/**", async (route) => {
      const original = new URL(route.request().url());
      await route.continue({
        url: `http://127.0.0.1:${slowStreamPort}${original.pathname}${original.search}`,
      });
    });
  }
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
  await pauseForCapture(page, 450);
}

async function typePromptWithMotion(page: Page, prompt: string, delay = 8) {
  const composer = page.getByPlaceholder(/Describe the result you want/i);
  await composer.click();
  await page.keyboard.type(prompt, { delay });
  await expect(composer).toHaveValue(prompt);
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

async function saveStill(page: Page, filename: string) {
  await pauseForCapture(page, 700);
  await page.screenshot({ path: path.join(stillRoot, filename), fullPage: false });
}

async function pauseForCapture(page: Page, milliseconds: number) {
  await page.waitForTimeout(milliseconds);
}

async function startRecorder(page: Page, name: string) {
  const dir = path.join(frameRoot, name);
  await fs.mkdir(dir, { recursive: true });
  let index = 0;
  let active = true;
  let paused = false;
  let chain = Promise.resolve();

  const capture = () => {
    if (!active) return;
    if (paused) {
      setTimeout(capture, 120);
      return;
    }
    const filename = `${String(index).padStart(5, "0")}.png`;
    index += 1;
    chain = chain
      .then(() => page.screenshot({ path: path.join(dir, filename), fullPage: false }))
      .catch(() => undefined);
    setTimeout(capture, 120);
  };

  capture();

  return {
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    async stop() {
      active = false;
      await chain;
    },
  };
}

async function renderGif(frameDir: string, outputPath: string) {
  const frames = await fs.readdir(frameDir);
  const pngFrames = frames.filter((filename) => filename.endsWith(".png")).sort();
  if (pngFrames.length < 2) {
    throw new Error(`Not enough frames to render ${outputPath}`);
  }

  await execFile("ffmpeg", [
    "-y",
    "-framerate",
    "10",
    "-i",
    path.join(frameDir, "%05d.png"),
    "-vf",
    "fps=10,scale=900:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=single:max_colors=256[p];[s1][p]paletteuse=new=1:dither=bayer:bayer_scale=3",
    "-gifflags",
    "-offsetting",
    outputPath,
  ]);
}

function startSlowStreamServer() {
  return new Promise<{ server: Server; port: number }>((resolve) => {
    const server = createServer(async (request, response) => {
      if (!request.url?.includes("/api/chat/stream/")) {
        response.writeHead(404);
        response.end();
        return;
      }
      const streamId = decodeURIComponent(request.url.split("/").pop()?.split("?")[0] ?? "stream-ui-1");
      response.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      await writeSlowStream(response, streamId);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Could not start README media stream server");
      }
      resolve({ server, port: address.port });
    });
  });
}

async function writeSlowStream(response: ServerResponse, streamId: string) {
  let eventId = 1;
  const write = async (event: string, data: Record<string, unknown>, delay = 280) => {
    response.write(`id: ${eventId}\n`);
    response.write(`event: ${event}\n`);
    response.write(`data: ${JSON.stringify(data)}\n\n`);
    eventId += 1;
    await delayMs(delay);
  };

  await write("model-loading", { model: "GPT-5.5" }, 850);
  await write("step-start", { step: 1 }, 300);

  if (streamId === "stream-auto-compact") {
    await write("text-delta", { text: "I am checking the long context before answering." }, 650);
    await write("compaction-start", { phases: ["prune", "summarize"] }, 450);
    await write("compaction-phase", { phase: "prune", status: "started" }, 350);
    await write("compaction-phase", { phase: "prune", status: "completed" }, 350);
    await write("compaction-phase", { phase: "summarize", status: "started" }, 350);
    await write("compaction-progress", { phase: "summarize", chars: 2200 }, 450);
    await write("compaction-phase", { phase: "summarize", status: "completed" }, 350);
    await write("compacted", { summary_created: true }, 550);
    await streamText(write, autoCompactStreamingText());
    await write("step-finish", { reason: "stop", tokens: { input: 24000, output: 220, reasoning: 20 }, cost: 0 }, 350);
    await write("done", { session_id: "session-new", finish_reason: "stop" }, 0);
    response.end();
    return;
  }

  const kind = streamId.slice("stream-natural-".length);
  await streamText(write, naturalStreamingText(kind));
  if (kind === "board") {
    await write("tool-call", {
      call_id: "artifact-natural-board-md",
      tool: "artifact",
      status: "completed",
      title: "Board-ready Launch Brief",
    }, 450);
    await write("tool-call", {
      call_id: "artifact-natural-board-mermaid",
      tool: "artifact",
      status: "completed",
      title: "Launch Decision Workflow",
    }, 450);
  }
  await write("step-finish", { reason: "stop", tokens: { input: 4200, output: 620, reasoning: 80 }, cost: 0 }, 350);
  await write("done", { session_id: "session-new", finish_reason: "stop" }, 0);
  response.end();
}

async function streamText(
  write: (event: string, data: Record<string, unknown>, delay?: number) => Promise<void>,
  text: string,
) {
  for (const chunk of chunkText(text, 90)) {
    await write("text-delta", { text: chunk }, 160);
  }
}

function chunkText(text: string, targetLength: number) {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= targetLength) {
      chunks.push(remaining);
      break;
    }
    const slice = remaining.slice(0, targetLength);
    const breakAt = Math.max(slice.lastIndexOf(" "), slice.lastIndexOf("\n"));
    const end = breakAt > 40 ? breakAt + 1 : targetLength;
    chunks.push(remaining.slice(0, end));
    remaining = remaining.slice(end);
  }
  return chunks;
}

function naturalStreamingText(kind: string) {
  if (kind === "board") {
    return "Board-ready launch brief\n\nExecutive summary: launch readiness is green on product scope, yellow on budget variance, and yellow on vendor renewal risk. The launch can proceed if Finance locks the contractor run-rate, Product closes onboarding gaps, and Legal confirms the renewal notice window before the board packet is finalized.\n\nDecision required\n\nApprove launch with three operating conditions:\n\n1. Finance confirms the contractor exit date and revised support run-rate.\n2. Product closes the onboarding checklist for enterprise accounts.\n3. Legal and Security complete vendor renewal review before procurement approval.\n\n| Risk | Owner | Severity | Next step |\n| --- | --- | --- | --- |\n| Support contractor variance | Finance | Yellow | Confirm exit date and savings model |\n| Enterprise onboarding readiness | Product | Yellow | Close remaining checklist items |\n| Vendor renewal notice window | Legal | Yellow | Lock renewal date and redline cutoff |\n| Customer communication | CS | Green | Send launch guidance to account owners |\n\nArtifacts prepared: a Markdown launch brief and a Mermaid decision workflow are attached for the meeting packet.";
  }

  return "VP-ready customer feedback memo\n\nExecutive readout: the feedback points to a fixable revenue risk, not a product-market problem. Customers still value the workflow, but onboarding, pricing language, and support ownership are creating avoidable friction before expansion conversations.\n\nTop three themes\n\n| Theme | Signal from notes | Business impact | Owner |\n| --- | --- | --- | --- |\n| Onboarding friction | New teams need repeated setup help | Delays first successful project | Growth Ops |\n| Pricing confusion | Buyers ask when usage becomes billable | Slows procurement and expansion | Finance |\n| Support handoff gaps | Tickets bounce between CS and Support | Creates executive escalation risk | Support Ops |\n\nRecommended actions\n\n1. Publish a one-page pricing FAQ by Friday.\n2. Assign one owner for onboarding follow-up on every strategic account.\n3. Review the SLA dashboard in next week's staff meeting.";
}

function autoCompactStreamingText() {
  return " Auto compacted answer persisted after compression.\n\nContext checkpoint\n\nOpenYak preserved the launch-review thread, compressed older turns, and kept the active decision context available for the next reply.\n\n| Area | Preserved detail | Next action |\n| --- | --- | --- |\n| Owners | Product, CS, Finance, Legal, Security | Confirm one accountable owner per risk |\n| Deadlines | Board packet, renewal window, automation savings date | Keep the critical dates in the active summary |\n| Risks | Budget variance, onboarding readiness, vendor renewal | Use the compressed summary for follow-up planning |";
}

function delayMs(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
