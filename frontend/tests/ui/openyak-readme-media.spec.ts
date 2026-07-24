import { expect, test, type Page } from "@playwright/test";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import { createServer, type ServerResponse, type Server } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { mockOpenYakApi, seedOpenYakStorage } from "./fixtures/openyak-api";

const execFile = promisify(execFileCallback);

const repoRoot = path.resolve(__dirname, "../../..");
const artifactRoot = path.join(repoRoot, ".codex-artifacts", "openyak-readme-media");
const frameRoot = path.join(artifactRoot, "frames");
const stillRoot = path.join(artifactRoot, "stills");
const stagingRoot = path.join(artifactRoot, "staging");
const publishTransactionRoot = path.join(
  repoRoot,
  "docs",
  ".openyak-readme-media-publish",
);
const backupRoot = path.join(publishTransactionRoot, "backup");
const publishManifestPath = path.join(publishTransactionRoot, "manifest.json");
const readmeMediaRoot = path.join(repoRoot, "docs", "readme");
const captureLockPort = portForCaptureLock(repoRoot);
let slowStreamServer: Server | undefined;
let slowStreamPort: number | undefined;
let captureLockServer: Server | undefined;
let captureSucceeded = false;
let ultraCapturePhase: "initial" | "partial" | "complete" = "initial";

type CaptureRecorder = {
  pause(): void;
  resume(): void;
  stop(): Promise<void>;
};

const activeRecorders = new Set<CaptureRecorder>();

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
  ["ultra-agent-swarm", "openyak-ultra-agent-swarm.gif"],
  ["auto-compress", "openyak-auto-compress.gif"],
] as const;

const stills = [
  "openyak-artifact-panel.png",
  "openyak-budget-analysis.png",
  "openyak-docx-brief.png",
  "openyak-subagents-work-view.png",
  "openyak-long-context.png",
] as const;

const managedAssets = [
  ...gifs.map(([, filename]) => filename),
  ...stills,
] as const;

type CaptureRunStatus =
  | "pending"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled";

const captureTime = "2026-07-24T16:00:00.000Z";

function captureRun(
  id: string,
  status: CaptureRunStatus,
  title: string,
  summary: string | null,
  ordinal: number,
) {
  const active =
    status === "pending" ||
    status === "running" ||
    status === "waiting_input";
  return {
    id,
    agent_run_id: id,
    agent: "research",
    session_id: `child-${id}`,
    parent_session_id: "session-alpha",
    parent_title: "Release readiness review",
    title,
    summary,
    status,
    source: "swarm",
    swarm_id: "swarm-release-readiness",
    ordinal,
    started_at: captureTime,
    finished_at: active ? null : captureTime,
    last_message_at: captureTime,
    time_updated: captureTime,
    error: null,
  };
}

const subagentCaptureResponse = {
  active: [
    captureRun(
      "streaming-ux",
      "running",
      "Streaming UX audit",
      "Checking first-token, live Markdown, Stop, and reconnect states.",
      0,
    ),
    captureRun(
      "release-qa",
      "running",
      "Release QA",
      "Running the final desktop regression matrix.",
      1,
    ),
  ],
  done: [
    captureRun(
      "accessibility",
      "completed",
      "Accessibility review",
      "Keyboard, focus, and reduced-motion checks passed.",
      2,
    ),
    captureRun(
      "artifact-contract",
      "completed",
      "Artifact contract audit",
      "Outputs and source provenance match the task summary.",
      3,
    ),
    captureRun(
      "documentation",
      "completed",
      "Documentation refresh",
      "README media and release notes are ready.",
      4,
    ),
  ],
  counts: { active: 2, done: 3, total: 5 },
};

const ultraPrompt =
  "Coordinate focused agents to audit release quality, accessibility, and streaming UX. Bring back one verified release recommendation.";

const ultraCompletedHistory = {
  total: 2,
  offset: 0,
  messages: [
    {
      id: "readme-ultra-user",
      session_id: "session-new",
      time_created: captureTime,
      data: { role: "user", agent: "build" },
      parts: [
        {
          id: "readme-ultra-user-text",
          message_id: "readme-ultra-user",
          session_id: "session-new",
          time_created: captureTime,
          data: { type: "text", text: ultraPrompt },
        },
      ],
    },
    {
      id: "readme-ultra-assistant",
      session_id: "session-new",
      time_created: captureTime,
      data: { role: "assistant", agent: "build", finish: "stop" },
      parts: [
        {
          id: "readme-ultra-intro",
          message_id: "readme-ultra-assistant",
          session_id: "session-new",
          time_created: captureTime,
          data: {
            type: "text",
            text: "I split the release review into focused checks and waited for their evidence.",
          },
        },
        {
          id: "readme-ultra-swarm",
          message_id: "readme-ultra-assistant",
          session_id: "session-new",
          time_created: captureTime,
          data: {
            type: "swarm",
            schema_version: 1,
            swarm_id: "swarm-readme-release",
            parent_session_id: "session-new",
            revision: 3,
            status: "completed",
            strategy: "parallel",
            failure_policy: "continue",
            started_at: captureTime,
            finished_at: captureTime,
            members: [
              ["streaming-ux", "Streaming UX audit"],
              ["accessibility", "Accessibility review"],
              ["release-qa", "Release QA"],
            ].map(([id, title], ordinal) => ({
              agent_run_id: `run-${id}`,
              session_id: `child-${id}`,
              ordinal,
              title,
              agent: "research",
              depth: 1,
              status: "completed",
              started_at: captureTime,
              finished_at: captureTime,
              error: null,
              cost: 0,
              tokens: { input: 1700 + ordinal * 120, output: 280 },
            })),
          },
        },
        {
          id: "readme-ultra-result",
          message_id: "readme-ultra-assistant",
          session_id: "session-new",
          time_created: captureTime,
          data: {
            type: "text",
            text: "Release readiness synthesis\n\nAll three focused reviews are complete. Streaming, Stop and reconnect states behave consistently; keyboard focus and reduced-motion checks pass; and the desktop regression matrix is green.\n\nRecommendation: release. Every finding remains traceable to its child session.",
          },
        },
        {
          id: "readme-ultra-finish",
          message_id: "readme-ultra-assistant",
          session_id: "session-new",
          time_created: captureTime,
          data: {
            type: "step-finish",
            reason: "stop",
            tokens: {
              input: 7300,
              output: 760,
              reasoning: 140,
              cache_read: 0,
              cache_write: 0,
            },
            cost: 0,
          },
        },
      ],
    },
  ],
};

const autoCompactPrompt =
  "Auto compress this long launch review thread, then summarize the owners, deadlines, risks, and next decision without losing the context.";

const autoCompactResult =
  "Auto compacted answer persisted after compression.\n\nContext checkpoint\n\nOpenYak preserved the launch-review thread, compressed older turns, and kept the active decision context available for the next reply.\n\n| Area | Preserved detail | Next action |\n| --- | --- | --- |\n| Owners | Product, CS, Finance, Legal, Security | Confirm one accountable owner per risk |\n| Deadlines | Board packet, renewal window, automation savings date | Keep the critical dates in the active summary |\n| Risks | Budget variance, onboarding readiness, vendor renewal | Use the compressed summary for follow-up planning |\n\nNext decision: approve the launch only after Finance confirms the contractor exit date and Legal locks the vendor renewal window.\n\nSaved output: `launch-context-checkpoint.md`.";

const autoCompactCompletedHistory = {
  total: 2,
  offset: 0,
  messages: [
    {
      id: "readme-auto-user",
      session_id: "session-new",
      time_created: captureTime,
      data: { role: "user", agent: "build" },
      parts: [
        {
          id: "readme-auto-user-text",
          message_id: "readme-auto-user",
          session_id: "session-new",
          time_created: captureTime,
          data: { type: "text", text: autoCompactPrompt },
        },
      ],
    },
    {
      id: "readme-auto-assistant",
      session_id: "session-new",
      time_created: captureTime,
      data: { role: "assistant", agent: "build", finish: "stop" },
      parts: [
        {
          id: "readme-auto-compaction",
          message_id: "readme-auto-assistant",
          session_id: "session-new",
          time_created: captureTime,
          data: { type: "compaction", auto: true },
        },
        {
          id: "readme-auto-result",
          message_id: "readme-auto-assistant",
          session_id: "session-new",
          time_created: captureTime,
          data: { type: "text", text: autoCompactResult },
        },
        {
          id: "readme-auto-finish",
          message_id: "readme-auto-assistant",
          session_id: "session-new",
          time_created: captureTime,
          data: {
            type: "step-finish",
            reason: "stop",
            tokens: {
              input: 24000,
              output: 220,
              reasoning: 20,
              cache_read: 0,
              cache_write: 0,
            },
            cost: 0,
          },
        },
      ],
    },
  ],
};

const longContextCaptureHistory = {
  total: 6,
  offset: 0,
  messages: [
    {
      role: "user",
      text: "Use the launch memo, budget, and vendor notes to draft one board decision with named owners.",
    },
    {
      role: "assistant",
      text: "I kept the earlier evidence in context. The launch can proceed if Finance closes the contractor run-rate, Product closes enterprise onboarding gaps, and Legal confirms the vendor notice window.",
    },
    {
      role: "user",
      text: "Keep that context and tighten it into a decision paragraph for the pre-read.",
    },
    {
      role: "assistant",
      text: "Recommended decision: approve the launch for the board packet, conditional on Finance confirming the contractor exit date, Product closing the onboarding checklist, and Legal locking the renewal notice window before procurement approval.",
    },
    {
      role: "user",
      text: "Now give me the final version with the decision, owners, deadlines, and open risks in one place.",
    },
    {
      role: "assistant",
      text: "Final version: launch is approved with conditions.\n\nProduct closes enterprise onboarding gaps by Wednesday. Finance confirms the support contractor run-rate by Friday. Legal locks the vendor renewal window before procurement approval, and CS sends account-owner guidance after those checks are complete.\n\nOpen risks remain budget variance, onboarding readiness, and renewal timing.",
    },
  ].map(({ role, text }, index) => {
    const messageId = `readme-long-${index + 1}`;
    return {
      id: messageId,
      session_id: "session-long",
      time_created: `2026-07-24T15:${String(40 + index).padStart(2, "0")}:00.000Z`,
      data: {
        role,
        agent: "build",
        finish: role === "assistant" ? "stop" : null,
      },
      parts: [
        {
          id: `${messageId}-text`,
          message_id: messageId,
          session_id: "session-long",
          time_created: `2026-07-24T15:${String(40 + index).padStart(2, "0")}:00.000Z`,
          data: { type: "text", text },
        },
      ],
    };
  }),
};

test.describe("OpenYak README media capture", () => {
  test.describe.configure({ mode: "serial", timeout: 900_000 });
  test.skip(
    process.env.OPENYAK_CAPTURE_README_MEDIA !== "true",
    "README media capture is an explicit documentation asset generation workflow.",
  );

  test.use({
    viewport: { width: 1800, height: 1100 },
    deviceScaleFactor: 1,
    colorScheme: "dark",
  });

  test.beforeAll(async () => {
    try {
      await preflightFfmpeg();
      await acquireCaptureLock();
      await recoverInterruptedPublish();
      await fs.rm(artifactRoot, { recursive: true, force: true });
      await fs.mkdir(frameRoot, { recursive: true });
      await fs.mkdir(stillRoot, { recursive: true });
      await fs.mkdir(stagingRoot, { recursive: true });
      const started = await startSlowStreamServer();
      slowStreamServer = started.server;
      slowStreamPort = started.port;
      captureSucceeded = true;
    } catch (error) {
      captureSucceeded = false;
      await releaseCaptureLock();
      throw error;
    }
  });

  test.afterEach(async ({}, testInfo) => {
    const recorderErrors = await stopActiveRecorders();
    if (testInfo.status !== testInfo.expectedStatus) {
      captureSucceeded = false;
    }
    if (recorderErrors.length > 0) {
      captureSucceeded = false;
      if (testInfo.status === testInfo.expectedStatus) {
        throw new AggregateError(
          recorderErrors,
          "Could not cleanly stop the README media recorder.",
        );
      }
    }
  });

  test.afterAll(async () => {
    try {
      if (!captureSucceeded) {
        return;
      }

      for (const [frameDirName, filename] of gifs) {
        await renderGif(
          path.join(frameRoot, frameDirName),
          path.join(stagingRoot, filename),
        );
      }

      for (const filename of stills) {
        await fs.copyFile(
          path.join(stillRoot, filename),
          path.join(stagingRoot, filename),
        );
      }

      await validateStagedAssets();
      await publishStagedAssets();
    } finally {
      try {
        await new Promise<void>(
          (resolve) => slowStreamServer?.close(() => resolve()) ?? resolve(),
        );
      } finally {
        await releaseCaptureLock();
      }
    }
  });

  test("record multi-file artifact workflow", async ({ page }) => {
    await setupCleanApp(page);
    await mockCaptureSession(page, {
      id: "session-new",
      title: "Launch readiness board review",
      outputFiles: [
        "board-ready-launch-brief.md",
        "launch-decision-workflow.mmd",
      ],
    });
    const history = await deferCompletedSessionHistory(page);
    await page.goto("/c/new");
    await expectHome(page);

    const recorder = await startRecorder(page, "workflow-artifacts");
    const prompt =
      "I am preparing a launch readiness review. Read these files together and create a board-ready brief with decisions, open risks, owners, and a workflow artifact.";
    await uploadFiles(page, [files.launchMemo, files.launchBudget, files.launchDeck, files.vendorTerms]);
    await typePromptWithMotion(
      page,
      prompt,
    );
    await pauseForCapture(page, 300);

    recorder.pause();
    history.start();
    await submitCurrentPrompt(page, "Launch readiness board review");
    await expect(page.getByText(prompt, { exact: true }).last()).toBeVisible();
    recorder.resume();
    await expect(page.locator("#main-content").getByText("Board-ready launch brief", { exact: true }).last()).toBeVisible({
      timeout: 25_000,
    });
    history.complete();
    await page.mouse.wheel(0, 520);
    await pauseForCapture(page, 500);

    await openArtifactPanel(page);
    await pauseForCapture(page, 600);
    recorder.pause();
    await page.reload();
    await openArtifactPanel(page);
    await expect(
      page.getByText("board-ready-launch-brief.md", { exact: true }),
    ).toBeVisible();
    recorder.resume();
    await pauseForCapture(page, 1_200);
    await expect(
      page
        .locator("#main-content")
        .getByText("Board-ready launch brief", { exact: true })
        .last(),
    ).toBeVisible();
    await expect(page.getByText("No messages yet")).toHaveCount(0);
    await recorder.stop();

    await saveStill(page, "openyak-artifact-panel.png");
  });

  test("record memo-to-brief workflow", async ({ page }) => {
    await setupCleanApp(page);
    await mockCaptureSession(page, {
      id: "session-new",
      title: "Customer feedback VP memo",
      outputFiles: [
        "customer-feedback-vp-memo.md",
        "customer-feedback-email.md",
      ],
    });
    const history = await deferCompletedSessionHistory(page);
    await page.goto("/c/new");
    await expectHome(page);

    const recorder = await startRecorder(page, "memo-to-brief");
    const prompt =
      "Turn the attached customer feedback notes into a VP-ready memo with the top three themes, revenue risk, owners, next actions, and a send-ready email.";
    await uploadFiles(page, [files.feedbackDoc]);
    await typePromptWithMotion(
      page,
      prompt,
    );
    await pauseForCapture(page, 300);

    recorder.pause();
    history.start();
    await submitCurrentPrompt(page, "Customer feedback VP memo");
    await expect(page.getByText(prompt, { exact: true }).last()).toBeVisible();
    recorder.resume();
    await expect(page.locator("#main-content").getByText("VP-ready customer feedback memo").last()).toBeVisible({
      timeout: 25_000,
    });
    history.complete();
    await page.mouse.wheel(0, 360);
    await pauseForCapture(page, 500);
    recorder.pause();
    await page.reload();
    await expect(
      page
        .locator("#main-content")
        .getByText("VP-ready customer feedback memo")
        .last(),
    ).toBeVisible();
    await page.mouse.wheel(0, 360);
    await expect(
      page.getByText("customer-feedback-vp-memo.md", { exact: true }),
    ).toBeVisible();
    recorder.resume();
    await pauseForCapture(page, 1_000);
    await recorder.stop();
    await saveStill(page, "openyak-docx-brief.png");
  });

  test("record spreadsheet analysis still", async ({ page }) => {
    await setupCleanApp(page);
    await mockCaptureSession(page, {
      id: "session-new",
      title: "Launch budget finance review",
      outputFiles: ["launch-budget-review.md"],
    });
    await page.goto("/c/new");
    await expectHome(page);
    await uploadFiles(page, [files.budgetSheet]);
    await typePromptWithMotion(
      page,
      "Review this launch budget workbook like Finance would: compare budget, actuals, and forecast, call out the biggest variance, and give owner-level actions.",
      1,
    );
    await submitCurrentPrompt(page, "Launch budget finance review");
    await expect(page.locator("#main-content").getByText("Finance workbook review").last()).toBeVisible({ timeout: 25_000 });
    await expect(
      page
        .locator("#main-content")
        .getByText("Finance recommendation")
        .last(),
    ).toBeVisible({ timeout: 25_000 });
    await expect(
      page.getByRole("button", { name: /Send message/i }),
    ).toBeVisible({ timeout: 25_000 });
    await page.reload();
    await expect(
      page
        .locator("#main-content")
        .getByText("Finance recommendation")
        .last(),
    ).toBeVisible();
    await page.mouse.wheel(0, 280);
    await expect(
      page.getByText("launch-budget-review.md", { exact: true }),
    ).toBeVisible();
    await saveStill(page, "openyak-budget-analysis.png");
  });

  test("record Ultra Agent Swarm workflow", async ({ page }) => {
    await setupCleanApp(page);
    await mockCaptureSession(page, {
      id: "session-new",
      title: "Release readiness agent review",
      outputFiles: [
        "release-verification.md",
        "streaming-ux-audit.md",
        "accessibility-review.md",
      ],
    });
    const history = await deferCompletedSessionHistory(
      page,
      4_800,
      ultraCompletedHistory,
    );
    ultraCapturePhase = "initial";
    await page.route("**/api/subagents*", async (route) => {
      const streamingRunning = captureRun(
        "streaming-ux",
        "running",
        "Streaming UX audit",
        "Checking first-token, live Markdown, Stop, and reconnect states.",
        0,
      );
      const streamingDone = captureRun(
        "streaming-ux",
        "completed",
        "Streaming UX audit",
        "First-token, live Markdown, Stop, and reconnect states passed.",
        0,
      );
      const accessibilityRunning = captureRun(
        "accessibility",
        "running",
        "Accessibility review",
        "Checking keyboard focus and reduced-motion behavior.",
        1,
      );
      const accessibilityDone = captureRun(
        "accessibility",
        "completed",
        "Accessibility review",
        "Keyboard, focus, and reduced-motion checks passed.",
        1,
      );
      const releaseQaRunning = captureRun(
        "release-qa",
        "running",
        "Release QA",
        "Running the final desktop regression matrix.",
        2,
      );
      const releaseQaDone = captureRun(
        "release-qa",
        "completed",
        "Release QA",
        "The final desktop regression matrix passed.",
        2,
      );
      const response =
        ultraCapturePhase === "initial"
          ? {
              active: [streamingRunning, accessibilityRunning],
              done: [],
              counts: { active: 2, done: 0, total: 2 },
            }
          : ultraCapturePhase === "partial"
            ? {
                active: [accessibilityRunning, releaseQaRunning],
                done: [streamingDone],
                counts: { active: 2, done: 1, total: 3 },
              }
            : {
                active: [],
                done: [streamingDone, accessibilityDone, releaseQaDone],
                counts: { active: 0, done: 3, total: 3 },
              };
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(response),
      });
    });
    await page.goto("/c/new");
    await expectHome(page);

    const recorder = await startRecorder(page, "ultra-agent-swarm");
    const ultra = page.getByRole("button", { name: /^Ultra:/ });
    await expect(ultra).toHaveAttribute("aria-pressed", "false");
    await ultra.click();
    await expect(ultra).toHaveAttribute("aria-pressed", "true");
    await pauseForCapture(page, 500);

    await typePromptWithMotion(
      page,
      ultraPrompt,
      3,
    );
    await pauseForCapture(page, 350);
    recorder.pause();
    history.start();
    await submitCurrentPrompt(page, "Release readiness agent review");
    await expect(
      page.getByText(ultraPrompt, { exact: true }).last(),
    ).toBeVisible();
    recorder.resume();
    await pauseForCapture(page, 6_500);
    recorder.pause();
    await page.reload();
    await expect(page.getByText("Release readiness synthesis")).toBeVisible();
    await expect(
      page.getByText("release-verification.md", { exact: true }),
    ).toBeVisible();
    recorder.resume();
    await pauseForCapture(page, 1_500);
    await recorder.stop();
  });

  test("record Subagents work view still", async ({ page }) => {
    await setupCleanApp(page);
    await mockCaptureSession(page, {
      id: "session-alpha",
      title: "Release readiness review",
      outputFiles: [
        "release-verification.md",
        "streaming-ux-audit.md",
        "accessibility-review.md",
        "artifact-contract-audit.md",
        "documentation-refresh.md",
      ],
    });
    await page.route("**/api/subagents*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(subagentCaptureResponse),
      });
    });
    await page.goto("/c/session-alpha?view=subagents");

    await expect(
      page.getByRole("heading", { name: "Subagents", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Active", level: 2 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Done · 3", level: 2 }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Open Streaming UX audit" }),
    ).toBeVisible();
    await expect(
      page.getByText("documentation-refresh.md", { exact: true }),
    ).toBeVisible();
    await saveStill(page, "openyak-subagents-work-view.png");
  });

  test("record long-context still", async ({ page }) => {
    await setupCleanApp(page);
    await mockCaptureSession(page, {
      id: "session-long",
      title: "Board launch decision follow-up",
      outputFiles: ["board-launch-decision.md"],
    });
    await page.route("**/api/messages/session-long*", async (route) => {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(longContextCaptureHistory),
      });
    });
    await page.goto("/c/session-long");
    await expect(page.getByText("Board launch decision follow-up").first()).toBeVisible();
    await expect(page.getByText("Final version: launch is approved with conditions.")).toBeVisible();
    await expect(
      page.getByText("board-launch-decision.md", { exact: true }),
    ).toBeVisible();
    await saveStill(page, "openyak-long-context.png");
  });

  test("record auto-compress workflow", async ({ page }) => {
    await setupCleanApp(page);
    await mockCaptureSession(page, {
      id: "session-new",
      title: "Compress launch review context",
      outputFiles: ["launch-context-checkpoint.md"],
    });
    const history = await deferCompletedSessionHistory(
      page,
      10_000,
      autoCompactCompletedHistory,
    );
    await page.goto("/c/new");
    await expectHome(page);
    const recorder = await startRecorder(page, "auto-compress");
    await typePromptWithMotion(
      page,
      autoCompactPrompt,
    );
    await pauseForCapture(page, 300);
    recorder.pause();
    history.start();
    await submitCurrentPrompt(page, "Compress launch review context");
    await expect(
      page.getByText(autoCompactPrompt, { exact: true }).last(),
    ).toBeVisible();
    recorder.resume();
    await expect(page.locator("#main-content").getByText("Auto compacted answer persisted after compression.").last()).toBeVisible({
      timeout: 25_000,
    });
    history.complete();
    await expect(page.getByText("Optimized the conversation")).toBeVisible();
    await pauseForCapture(page, 500);
    recorder.pause();
    await page.reload();
    await expect(
      page
        .locator("#main-content")
        .getByText("Auto compacted answer persisted after compression.")
        .last(),
    ).toBeVisible();
    await expect(page.getByText("Optimized the conversation")).toBeVisible();
    await expect(
      page.getByRole("button", {
        name: /launch-context-checkpoint\.md\. Origins:/,
      }),
    ).toBeVisible();
    recorder.resume();
    await pauseForCapture(page, 1_200);
    await recorder.stop();
  });
});

async function setupCleanApp(page: Page, options?: Parameters<typeof mockOpenYakApi>[1]) {
  await seedOpenYakStorage(page, { force: true });
  await page.addInitScript(() => {
    window.localStorage.setItem("theme", "dark");
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

async function deferCompletedSessionHistory(
  page: Page,
  delayMilliseconds = 10_000,
  completedHistory?: Record<string, unknown>,
) {
  let streamStartedAt = Number.POSITIVE_INFINITY;
  let forceCompletedHistory = false;
  await page.route("**/api/messages/session-new*", async (route) => {
    if (
      !forceCompletedHistory &&
      Date.now() - streamStartedAt < delayMilliseconds
    ) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ total: 0, offset: 0, messages: [] }),
      });
      return;
    }
    if (completedHistory) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(completedHistory),
      });
      return;
    }
    await route.fallback();
  });
  return {
    start() {
      streamStartedAt = Date.now();
    },
    complete() {
      forceCompletedHistory = true;
    },
  };
}

async function mockCaptureSession(
  page: Page,
  fixture: {
    id: string;
    title: string;
    outputFiles: string[];
  },
) {
  const session = {
    id: fixture.id,
    project_id: null,
    parent_id: null,
    slug: null,
    directory: "/Users/alex/openyak-demo",
    title: fixture.title,
    version: 0,
    summary_additions: 12,
    summary_deletions: 2,
    summary_files: fixture.outputFiles.length,
    summary_diffs: [],
    is_pinned: fixture.id === "session-alpha",
    permission: {},
    time_created: captureTime,
    time_updated: captureTime,
    time_compacting: null,
    time_archived: null,
  };

  await page.route("**/api/sessions*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (
      route.request().method() !== "GET" ||
      pathname !== "/api/sessions"
    ) {
      await route.fallback();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([session]),
    });
  });

  await page.route("**/api/sessions/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const detailMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
    if (detailMatch) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          ...session,
          id: decodeURIComponent(detailMatch[1]),
        }),
      });
      return;
    }
    if (/^\/api\/sessions\/[^/]+\/files$/.test(pathname)) {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          files: fixture.outputFiles.map((name) => ({
            name,
            path: `/Users/alex/openyak-demo/${name}`,
            type: "file",
            tool: "write",
          })),
        }),
      });
      return;
    }
    await route.fallback();
  });
}

async function expectHome(page: Page) {
  await expect(page.getByRole("heading", { name: /What should (OpenYak help you do|we do in)/i })).toBeVisible();
  await expect(page.locator("html")).toHaveClass(/dark/);
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

async function submitCurrentPrompt(page: Page, sessionTitle: string) {
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
    await page.getByRole("option", { name: sessionTitle }).click();
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
  let captureFailure: Error | undefined;
  let stopPromise: Promise<void> | undefined;
  const stopAt = Date.now() + 30_000;
  const captureLoop = (async () => {
    while (active && Date.now() < stopAt) {
      if (!paused) {
        const filename = `${String(index).padStart(5, "0")}.png`;
        index += 1;
        try {
          await page.screenshot({
            path: path.join(dir, filename),
            fullPage: false,
          });
        } catch (error) {
          if (active) {
            captureFailure = new Error(
              `Could not capture README frame ${filename}.`,
              { cause: error },
            );
            active = false;
          }
        }
      }
      await delayMs(120);
    }
    active = false;
  })();

  const recorder: CaptureRecorder = {
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
    },
    async stop() {
      active = false;
      stopPromise ??= captureLoop.finally(() => {
        activeRecorders.delete(recorder);
      });
      await stopPromise;
      if (captureFailure) {
        throw captureFailure;
      }
    },
  };
  activeRecorders.add(recorder);
  return recorder;
}

async function stopActiveRecorders() {
  const recorders = [...activeRecorders];
  const results = await Promise.allSettled(
    recorders.map((recorder) => recorder.stop()),
  );
  return results.flatMap((result) =>
    result.status === "rejected" ? [result.reason] : [],
  );
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
    "fps=10,crop=iw-300:ih:300:0,scale=1200:-1:flags=lanczos,split[s0][s1];[s0]palettegen=stats_mode=single:max_colors=256[p];[s1][p]paletteuse=new=1:dither=bayer:bayer_scale=3",
    "-gifflags",
    "-offsetting",
    outputPath,
  ]);
}

async function preflightFfmpeg() {
  try {
    await execFile("ffmpeg", ["-version"]);
  } catch (error) {
    throw new Error(
      "README media capture requires ffmpeg on PATH. Install ffmpeg and rerun `npm run capture:readme-media`.",
      { cause: error },
    );
  }
}

async function acquireCaptureLock() {
  if (captureLockServer) {
    return;
  }
  const server = createServer((_request, response) => {
    response.writeHead(423, { "content-type": "text/plain" });
    response.end("OpenYak README media capture is running.\n");
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => reject(error);
      server.once("error", onError);
      server.listen(
        {
          host: "127.0.0.1",
          port: captureLockPort,
          exclusive: true,
        },
        () => {
          server.off("error", onError);
          resolve();
        },
      );
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new Error(
        "Another README media capture is already running. Wait for it to finish before retrying.",
        { cause: error },
      );
    }
    throw new Error("Could not acquire the README media capture lock.", {
      cause: error,
    });
  }
  server.unref();
  captureLockServer = server;
}

async function releaseCaptureLock() {
  const server = captureLockServer;
  if (!server) {
    return;
  }
  captureLockServer = undefined;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function portForCaptureLock(value: string) {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return 40_000 + (hash % 10_000);
}

async function validateStagedAssets() {
  for (const filename of managedAssets) {
    const outputPath = path.join(stagingRoot, filename);
    let stats;
    try {
      stats = await fs.stat(outputPath);
    } catch (error) {
      throw new Error(`README media capture did not generate ${filename}.`, {
        cause: error,
      });
    }
    if (!stats.isFile() || stats.size === 0) {
      throw new Error(`README media capture generated an empty ${filename}.`);
    }
  }
}

async function publishStagedAssets() {
  await recoverInterruptedPublish();
  await fs.mkdir(backupRoot, { recursive: true });

  const files: Array<{
    filename: string;
    existed: boolean;
    size: number | null;
  }> = [];
  for (const filename of managedAssets) {
    const target = path.join(readmeMediaRoot, filename);
    if (await pathExists(target)) {
      const stats = await fs.stat(target);
      files.push({ filename, existed: true, size: stats.size });
    } else {
      files.push({ filename, existed: false, size: null });
    }
  }

  try {
    for (const file of files.filter((candidate) => candidate.existed)) {
      await fs.copyFile(
        path.join(readmeMediaRoot, file.filename),
        path.join(backupRoot, file.filename),
      );
      const backupStats = await fs.stat(path.join(backupRoot, file.filename));
      if (!backupStats.isFile() || backupStats.size !== file.size) {
        throw new Error(`Could not completely back up ${file.filename}.`);
      }
    }

    const manifestPendingPath = `${publishManifestPath}.pending`;
    await fs.writeFile(
      manifestPendingPath,
      JSON.stringify({ version: 1, files }, null, 2),
    );
    await fs.rename(manifestPendingPath, publishManifestPath);

    for (const filename of managedAssets) {
      await atomicCopyReplace(
        path.join(stagingRoot, filename),
        path.join(readmeMediaRoot, filename),
      );
    }

    const committedPath = path.join(publishTransactionRoot, "committed");
    const committedPendingPath = `${committedPath}.pending`;
    await fs.writeFile(committedPendingPath, "ok\n");
    await fs.rename(committedPendingPath, committedPath);
  } catch (error) {
    try {
      await recoverInterruptedPublish();
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        "Could not publish or fully restore the README media transaction.",
      );
    }
    throw new Error(
      "Could not publish the staged README media; the previous assets were restored.",
      { cause: error },
    );
  }

  await fs.rm(publishTransactionRoot, { recursive: true, force: true });
}

async function recoverInterruptedPublish() {
  if (!(await pathExists(publishTransactionRoot))) {
    await cleanupPublishPendingFiles();
    return;
  }

  if (await pathExists(path.join(publishTransactionRoot, "committed"))) {
    await cleanupPublishPendingFiles();
    await fs.rm(publishTransactionRoot, { recursive: true, force: true });
    return;
  }

  if (!(await pathExists(publishManifestPath))) {
    await cleanupPublishPendingFiles();
    await fs.rm(publishTransactionRoot, { recursive: true, force: true });
    return;
  }

  const manifest = JSON.parse(
    await fs.readFile(publishManifestPath, "utf8"),
  ) as {
    version?: unknown;
    files?: unknown;
  };
  if (
    manifest.version !== 1 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== managedAssets.length
  ) {
    throw new Error(
      "Could not recover README media because the publish manifest is invalid.",
    );
  }

  const files = manifest.files as Array<{
    filename?: unknown;
    existed?: unknown;
    size?: unknown;
  }>;
  for (const expected of managedAssets) {
    const file = files.find((candidate) => candidate.filename === expected);
    if (
      !file ||
      typeof file.existed !== "boolean" ||
      (file.existed &&
        (typeof file.size !== "number" ||
          !(await backupMatchesSize(expected, file.size))))
    ) {
      throw new Error(
        `Could not recover README media because the backup for ${expected} is incomplete.`,
      );
    }
  }

  const recoveryErrors: unknown[] = [];
  for (const file of files) {
    const filename = String(file.filename);
    try {
      if (file.existed) {
        await atomicCopyReplace(
          path.join(backupRoot, filename),
          path.join(readmeMediaRoot, filename),
        );
      } else {
        await fs.rm(path.join(readmeMediaRoot, filename), { force: true });
      }
    } catch (error) {
      recoveryErrors.push(
        new Error(`Could not restore ${filename}.`, { cause: error }),
      );
    }
  }

  if (recoveryErrors.length > 0) {
    throw new AggregateError(
      recoveryErrors,
      "Could not fully recover an interrupted README media publish.",
    );
  }
  await cleanupPublishPendingFiles();
  await fs.rm(publishTransactionRoot, { recursive: true, force: true });
}

function publishPendingPath(filename: string) {
  return path.join(readmeMediaRoot, `.openyak-readme-media-${filename}.pending`);
}

async function cleanupPublishPendingFiles() {
  await Promise.all(
    managedAssets.map((filename) =>
      fs.rm(publishPendingPath(filename), { force: true }),
    ),
  );
}

async function atomicCopyReplace(source: string, target: string) {
  const pending = publishPendingPath(path.basename(target));
  await fs.rm(pending, { force: true });
  try {
    const sourceStats = await fs.stat(source);
    await fs.copyFile(source, pending);
    const pendingStats = await fs.stat(pending);
    if (
      !pendingStats.isFile() ||
      pendingStats.size === 0 ||
      pendingStats.size !== sourceStats.size
    ) {
      throw new Error(`Could not completely prepare ${path.basename(target)}.`);
    }
    await fs.rename(pending, target);
  } finally {
    await fs.rm(pending, { force: true });
  }
}

async function backupMatchesSize(filename: string, size: number) {
  try {
    const stats = await fs.stat(path.join(backupRoot, filename));
    return stats.isFile() && stats.size === size;
  } catch {
    return false;
  }
}

async function pathExists(filePath: string) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
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

  if (streamId === "stream-ui-1") {
    ultraCapturePhase = "initial";
    type CaptureSwarmMember = {
      agent_run_id: string;
      session_id: string;
      ordinal: number;
      title: string;
      agent: string;
      depth: number;
      status: "pending" | "running" | "completed";
      started_at: string | null;
      finished_at: string | null;
      error: string | null;
      cost: number;
      tokens: Record<string, number>;
    };
    const members: CaptureSwarmMember[] = [
      {
        agent_run_id: "run-streaming-ux",
        session_id: "child-streaming-ux",
        ordinal: 0,
        title: "Streaming UX audit",
        agent: "research",
        depth: 1,
        status: "running",
        started_at: captureTime,
        finished_at: null,
        error: null,
        cost: 0,
        tokens: {},
      },
      {
        agent_run_id: "run-accessibility",
        session_id: "child-accessibility",
        ordinal: 1,
        title: "Accessibility review",
        agent: "research",
        depth: 1,
        status: "running",
        started_at: captureTime,
        finished_at: null,
        error: null,
        cost: 0,
        tokens: {},
      },
      {
        agent_run_id: "run-release-qa",
        session_id: "child-release-qa",
        ordinal: 2,
        title: "Release QA",
        agent: "research",
        depth: 1,
        status: "pending",
        started_at: null,
        finished_at: null,
        error: null,
        cost: 0,
        tokens: {},
      },
    ];
    const swarmState = (
      revision: number,
      status: "running" | "completed",
      updatedMembers: CaptureSwarmMember[],
    ) => ({
      schema_version: 1,
      swarm_id: "swarm-readme-release",
      parent_session_id: "session-new",
      revision,
      status,
      strategy: "parallel",
      failure_policy: "continue",
      started_at: captureTime,
      finished_at: status === "completed" ? captureTime : null,
      members: updatedMembers,
    });

    await write(
      "text-delta",
      {
        text: "I’ll split the release review into focused checks and synthesize only after their evidence is back.",
      },
      550,
    );
    await write(
      "tool-call",
      {
        call_id: "swarm-readme-release",
        tool: "swarm",
        arguments: {
          assignments: members.map((member) => ({
            title: member.title,
            prompt: `Audit ${member.title.toLowerCase()} and return verified findings.`,
          })),
        },
        title: "Agent swarm",
      },
      350,
    );
    await write(
      "tool-result",
      {
        call_id: "swarm-readme-release",
        tool: "swarm",
        output: "Three focused agents started.",
        title: "Agent swarm",
      },
      300,
    );
    await write("swarm-state", swarmState(1, "running", members), 850);
    await write(
      "text-delta",
      { text: "\n\nThe first checks are now running in parallel." },
      500,
    );
    ultraCapturePhase = "partial";
    await write(
      "swarm-state",
      swarmState(2, "running", [
        {
          ...members[0],
          status: "completed",
          finished_at: captureTime,
          tokens: { input: 1840, output: 310 },
        },
        members[1],
        { ...members[2], status: "running", started_at: captureTime },
      ]),
      900,
    );
    await write(
      "text-delta",
      {
        text: "\n\nStreaming UX is verified. Accessibility and the release matrix are finishing now.",
      },
      200,
    );
    ultraCapturePhase = "complete";
    await write(
      "swarm-state",
      swarmState(
        3,
        "completed",
        members.map((member) => ({
          ...member,
          status: "completed",
          started_at: member.started_at ?? captureTime,
          finished_at: captureTime,
          tokens: { input: 1700 + member.ordinal * 120, output: 280 },
        })),
      ),
      750,
    );
    await streamText(
      write,
      "Release readiness synthesis\n\nAll three focused reviews are complete. Streaming, Stop and reconnect states behave consistently; keyboard focus and reduced motion checks pass; and the desktop regression matrix is green.\n\nRecommendation: release. Keep the three agent reports attached to the parent task so every finding remains traceable.",
    );
    await write(
      "tool-call",
      {
        call_id: "artifact-readme-release",
        tool: "artifact",
        status: "completed",
        title: "Release verification report",
      },
      350,
    );
    await write(
      "step-finish",
      {
        reason: "stop",
        tokens: { input: 7300, output: 760, reasoning: 140 },
        cost: 0,
      },
      300,
    );
    await write(
      "done",
      { session_id: "session-new", finish_reason: "stop" },
      0,
    );
    response.end();
    return;
  }

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

  if (kind === "budget") {
    return "Finance workbook review\n\nExecutive view: the quarter is still manageable, but the support contractor line is now the controlling variance. Paid acquisition is under plan, which offsets part of the overage, but the forecast should not stay flat unless Support Ops confirms automation savings by month end.\n\n| Line item | Budget signal | Variance call | Owner question |\n| --- | --- | --- | --- |\n| Customer Success | Slightly over | Watch | What retention risk is this protecting? |\n| Paid acquisition | Under plan | Favorable | Will Q3 pipeline be affected? |\n| Infrastructure | Above forecast | Medium risk | Which jobs can move off peak? |\n| Support contractors | 18% over | Critical | What is the exit date and automation plan? |\n\nFinance recommendation\n\nHold the current-quarter forecast only if Support Ops commits to a contractor ramp-down date, Product confirms the automation release scope, and Finance updates the run-rate model before the operating review.";
  }

  return "VP-ready customer feedback memo\n\nExecutive readout: the feedback points to a fixable revenue risk, not a product-market problem. Customers still value the workflow, but onboarding, pricing language, and support ownership are creating avoidable friction before expansion conversations.\n\nTop three themes\n\n| Theme | Signal from notes | Business impact | Owner |\n| --- | --- | --- | --- |\n| Onboarding friction | New teams need repeated setup help | Delays first successful project | Growth Ops |\n| Pricing confusion | Buyers ask when usage becomes billable | Slows procurement and expansion | Finance |\n| Support handoff gaps | Tickets bounce between CS and Support | Creates executive escalation risk | Support Ops |\n\nRecommended actions\n\n1. Publish a one-page pricing FAQ by Friday.\n2. Assign one owner for onboarding follow-up on every strategic account.\n3. Review the SLA dashboard in next week's staff meeting.";
}

function autoCompactStreamingText() {
  return autoCompactResult;
}

function delayMs(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
