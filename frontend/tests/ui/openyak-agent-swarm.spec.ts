import { expect, test, type Page } from "@playwright/test";
import {
  mockOpenYakApi,
  seedOpenYakStorage,
  type OpenYakMockState,
} from "./fixtures/openyak-api";

interface MockSession {
  id: string;
  parent_id: string | null;
  title: string;
}

const now = "2026-07-23T12:00:00.000Z";

async function setupMockedApp(page: Page): Promise<OpenYakMockState> {
  await seedOpenYakStorage(page);
  return mockOpenYakApi(page);
}

async function mockSession(
  page: Page,
  session: MockSession,
  messages: unknown[],
) {
  await page.route(`**/api/sessions/${session.id}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        project_id: null,
        slug: null,
        directory: "/Users/alex/openyak-demo",
        version: 0,
        summary_additions: 0,
        summary_deletions: 0,
        summary_files: 0,
        summary_diffs: [],
        is_pinned: false,
        permission: {},
        model_id: "openrouter/anthropic/claude-sonnet-4.5",
        provider_id: "openrouter",
        time_created: now,
        time_updated: now,
        time_compacting: null,
        time_archived: null,
        ...session,
      }),
    }),
  );
  await page.route(`**/api/messages/${session.id}*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        total: messages.length,
        offset: 0,
        messages,
      }),
    }),
  );
}

async function selectWorkMode(
  page: Page,
  currentMode: "Plan first" | "Ask first" | "Auto-edit",
  nextMode: "Plan first" | "Ask first" | "Auto-edit",
) {
  await page
    .getByRole("button", { name: currentMode, exact: true })
    .click();
  await page
    .getByRole("button", { name: new RegExp(`^${nextMode}\\b`) })
    .last()
    .click();
  await expect(
    page.getByRole("button", { name: nextMode, exact: true }),
  ).toBeVisible();
}

test.describe("OpenYak Ultra and agent swarm regressions", () => {
  test.describe.configure({ timeout: 60_000 });
  test.skip(
    ({ isMobile }) => isMobile,
    "Ultra orchestration controls live in the desktop chat composer.",
  );

  test("Ultra stays independent while Plan, Ask, and Auto modes change", async ({
    page,
  }) => {
    const state = await setupMockedApp(page);
    await page.goto("/c/new");

    const ultra = page.getByRole("button", { name: /^Ultra:/ });
    await expect(ultra).toHaveAccessibleName(
      "Ultra: Coordinate multiple agents for complex work",
    );
    await expect(ultra).toHaveAttribute("aria-pressed", "false");
    await ultra.click();
    await expect(ultra).toHaveAttribute("aria-pressed", "true");

    await selectWorkMode(page, "Auto-edit", "Plan first");
    await expect(ultra).toHaveAttribute("aria-pressed", "true");

    await selectWorkMode(page, "Plan first", "Ask first");
    await expect(ultra).toHaveAttribute("aria-pressed", "true");

    await selectWorkMode(page, "Ask first", "Auto-edit");
    await expect(ultra).toHaveAttribute("aria-pressed", "true");

    await page
      .getByPlaceholder(/Describe the result you want/i)
      .fill("Coordinate a focused multi-agent review");
    const promptResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/chat/prompt") &&
        response.status() === 200,
    );
    await page.getByRole("button", { name: /Send message/i }).click();
    await promptResponse;

    expect(state.promptBodies[0]).toMatchObject({
      execution_mode: "ultra",
      agent: "build",
    });
  });

  test("a child agent session shows Worker and cannot enable Ultra", async ({
    page,
  }) => {
    await setupMockedApp(page);
    await mockSession(
      page,
      {
        id: "swarm-worker-a",
        parent_id: "session-swarm",
        title: "Backend audit worker",
      },
      [],
    );

    await page.goto("/c/swarm-worker-a");

    const worker = page.getByRole("button", {
      name: /^Worker: Worker sessions always use single-agent execution$/,
    });
    await expect(worker).toBeVisible();
    await expect(worker).toBeDisabled();
    await expect(
      page.getByRole("button", { name: /^Ultra:/ }),
    ).toHaveCount(0);
  });

  test("a historical swarm part restores member status and child-session links", async ({
    page,
  }) => {
    await setupMockedApp(page);
    await mockSession(
      page,
      {
        id: "session-swarm",
        parent_id: null,
        title: "Release readiness swarm",
      },
      [
        {
          id: "session-swarm-assistant-1",
          session_id: "session-swarm",
          time_created: now,
          data: {
            role: "assistant",
            agent: "build",
            model_id: "openrouter/anthropic/claude-sonnet-4.5",
            provider_id: "openrouter",
            cost: 0,
            finish: "stop",
          },
          parts: [
            {
              id: "session-swarm-part-1",
              message_id: "session-swarm-assistant-1",
              session_id: "session-swarm",
              time_created: now,
              data: {
                type: "swarm",
                schema_version: 1,
                swarm_id: "swarm-release-readiness",
                parent_session_id: "session-swarm",
                revision: 4,
                status: "partial",
                strategy: "parallel",
                failure_policy: "continue",
                started_at: "2026-07-23T11:58:00.000Z",
                finished_at: now,
                members: [
                  {
                    agent_run_id: "run-backend-audit",
                    session_id: "swarm-worker-a",
                    ordinal: 0,
                    title: "Backend audit",
                    agent: "research",
                    depth: 1,
                    status: "completed",
                    started_at: "2026-07-23T11:58:00.000Z",
                    finished_at: "2026-07-23T11:59:00.000Z",
                    error: null,
                    cost: 0,
                    tokens: { input: 200, output: 80 },
                  },
                  {
                    agent_run_id: "run-ui-regression",
                    session_id: "swarm-worker-b",
                    ordinal: 1,
                    title: "UI regression",
                    agent: "research",
                    depth: 1,
                    status: "failed",
                    started_at: "2026-07-23T11:58:00.000Z",
                    finished_at: "2026-07-23T11:59:30.000Z",
                    error: "Browser assertion failed",
                    cost: 0,
                    tokens: { input: 150, output: 30 },
                  },
                ],
              },
            },
          ],
        },
      ],
    );

    await page.goto("/c/session-swarm");

    const swarm = page.getByRole("status", {
      name: "Agent swarm: Partial",
    });
    await expect(swarm).toBeVisible();
    const members = swarm.getByRole("group", {
      name: "Agent swarm members",
    });
    await expect(members).toBeVisible();

    await expect(
      members.getByRole("link", {
        name: "Backend audit, Completed. Open agent session",
      }),
    ).toHaveAttribute(
      "href",
      "/c/session-swarm?view=subagents&child=swarm-worker-a",
    );
    await expect(
      members.getByRole("link", {
        name: "UI regression, Failed. Open agent session",
      }),
    ).toHaveAttribute(
      "href",
      "/c/session-swarm?view=subagents&child=swarm-worker-b",
    );

    const details = swarm.getByRole("button", {
      name: "Show Agent swarm details",
    });
    await expect(details).toHaveAttribute("aria-expanded", "false");
    await expect(swarm.getByText("Browser assertion failed")).toBeHidden();

    await details.click();

    await expect(
      swarm.getByRole("button", { name: "Hide Agent swarm details" }),
    ).toHaveAttribute("aria-expanded", "true");
    await expect(swarm).toContainText("1/2 complete · 0 active");
    await expect(swarm.getByText("Browser assertion failed")).toBeVisible();
  });

  test("a single subtask opens the same parent-task child detail", async ({
    page,
  }) => {
    await setupMockedApp(page);
    await mockSession(
      page,
      {
        id: "session-swarm",
        parent_id: null,
        title: "Release readiness swarm",
      },
      [
        {
          id: "session-swarm-assistant-subtask",
          session_id: "session-swarm",
          time_created: now,
          data: {
            role: "assistant",
            agent: "build",
            model_id: "openrouter/anthropic/claude-sonnet-4.5",
            provider_id: "openrouter",
            cost: 0,
            finish: "stop",
          },
          parts: [
            {
              id: "session-swarm-subtask-part",
              message_id: "session-swarm-assistant-subtask",
              session_id: "session-swarm",
              time_created: now,
              data: {
                type: "subtask",
                session_id: "swarm-worker-a",
                task_id: "task-backend-audit",
                title: "Backend audit",
                description: "Review the release backend.",
                agent: "research",
                status: "completed",
              },
            },
          ],
        },
      ],
    );

    await page.goto("/c/session-swarm");

    const subtask = page.getByRole("status", {
      name: "Backend audit: Completed",
    });
    await expect(
      subtask.getByRole("link", { name: "Backend audit, Completed" }),
    ).toHaveAttribute(
      "href",
      "/c/session-swarm?view=subagents&child=swarm-worker-a",
    );
    await expect(subtask.getByText("finished", { exact: true })).toBeVisible();
  });

  test("a completed swarm keeps its agent pill visible and reveals restrained details", async ({
    page,
  }) => {
    await setupMockedApp(page);
    await mockSession(
      page,
      {
        id: "session-swarm-complete",
        parent_id: null,
        title: "Completed release swarm",
      },
      [
        {
          id: "session-swarm-complete-assistant",
          session_id: "session-swarm-complete",
          time_created: now,
          data: {
            role: "assistant",
            agent: "build",
            finish: "stop",
          },
          parts: [
            {
              id: "session-swarm-complete-part",
              message_id: "session-swarm-complete-assistant",
              session_id: "session-swarm-complete",
              time_created: now,
              data: {
                type: "swarm",
                schema_version: 1,
                swarm_id: "swarm-complete",
                parent_session_id: "session-swarm-complete",
                revision: 2,
                status: "completed",
                strategy: "parallel",
                failure_policy: "continue",
                started_at: "2026-07-23T11:58:00.000Z",
                finished_at: now,
                members: [
                  {
                    agent_run_id: "run-complete-a",
                    session_id: "swarm-worker-a",
                    ordinal: 0,
                    title: "Backend audit",
                    agent: "research",
                    depth: 1,
                    status: "completed",
                    started_at: "2026-07-23T11:58:00.000Z",
                    finished_at: now,
                    error: null,
                    cost: 0,
                    tokens: { input: 200, output: 80 },
                  },
                ],
              },
            },
          ],
        },
      ],
    );

    await page.goto("/c/session-swarm-complete");

    const swarm = page.getByRole("status", {
      name: "Agent swarm: Completed",
    });
    const lifecycle = swarm.getByRole("button", {
      name: "Show Agent swarm details",
    });
    await expect(lifecycle).toHaveAttribute("aria-expanded", "false");
    await expect(swarm.getByText("finished", { exact: true })).toBeVisible();
    await expect(
      swarm.getByRole("link", {
        name: "Backend audit, Completed. Open agent session",
      }),
    ).toBeVisible();
    await expect(
      swarm.getByRole("region", { name: "Agent swarm details" }),
    ).toHaveCount(0);

    await lifecycle.click();

    const hideDetails = swarm.getByRole("button", {
      name: "Hide Agent swarm details",
    });
    await expect(hideDetails).toHaveAttribute("aria-expanded", "true");
    const detailsId = await hideDetails.getAttribute("aria-controls");
    expect(detailsId).toBeTruthy();
    await expect(page.locator(`[id="${detailsId}"]`)).toHaveCount(1);
    await expect(
      swarm.getByRole("region", { name: "Agent swarm details" }),
    ).toContainText(
      "1/1 complete · 0 active",
    );
  });

  test("a running swarm stays compact while its pill and live lifecycle remain visible", async ({
    page,
  }) => {
    await setupMockedApp(page);
    await mockSession(
      page,
      {
        id: "session-swarm-running",
        parent_id: null,
        title: "Running release swarm",
      },
      [
        {
          id: "session-swarm-running-assistant",
          session_id: "session-swarm-running",
          time_created: now,
          data: { role: "assistant", agent: "build", finish: null },
          parts: [
            {
              id: "session-swarm-running-part",
              message_id: "session-swarm-running-assistant",
              session_id: "session-swarm-running",
              time_created: now,
              data: {
                type: "swarm",
                schema_version: 1,
                swarm_id: "swarm-running",
                parent_session_id: "session-swarm-running",
                revision: 1,
                status: "running",
                strategy: "parallel",
                failure_policy: "continue",
                started_at: now,
                finished_at: null,
                members: [
                  {
                    agent_run_id: "run-running-a",
                    session_id: "swarm-worker-a",
                    ordinal: 0,
                    title: "Backend audit",
                    agent: "research",
                    depth: 1,
                    status: "running",
                    started_at: now,
                    finished_at: null,
                    error: null,
                    cost: 0,
                    tokens: { input: 0, output: 0 },
                  },
                ],
              },
            },
          ],
        },
      ],
    );

    await page.goto("/c/session-swarm-running");

    const swarm = page.getByRole("status", {
      name: "Agent swarm: Running",
    });
    const lifecycle = swarm.getByRole("button", {
      name: "Show Agent swarm details",
    });
    await expect(lifecycle).toHaveAttribute("aria-expanded", "false");
    await expect(
      swarm.getByText("started working", { exact: true }),
    ).toBeVisible();
    await expect(
      swarm.getByRole("link", {
        name: "Backend audit, Running. Open agent session",
      }),
    ).toBeVisible();

    await lifecycle.click();
    await expect(
      swarm.getByRole("region", { name: "Agent swarm details" }),
    ).toContainText("0/1 complete · 1 active");
  });

  test("a cancelled swarm records when the user stopped it", async ({
    page,
  }) => {
    await setupMockedApp(page);
    await mockSession(
      page,
      {
        id: "session-swarm-cancelled",
        parent_id: null,
        title: "Cancelled release swarm",
      },
      [
        {
          id: "session-swarm-cancelled-assistant",
          session_id: "session-swarm-cancelled",
          time_created: now,
          data: { role: "assistant", agent: "build", finish: "stop" },
          parts: [
            {
              id: "session-swarm-cancelled-part",
              message_id: "session-swarm-cancelled-assistant",
              session_id: "session-swarm-cancelled",
              time_created: now,
              data: {
                type: "swarm",
                schema_version: 1,
                swarm_id: "swarm-cancelled",
                parent_session_id: "session-swarm-cancelled",
                revision: 2,
                status: "cancelled",
                strategy: "parallel",
                failure_policy: "continue",
                started_at: "2026-07-23T11:58:00.000Z",
                finished_at: now,
                members: [
                  {
                    agent_run_id: "run-cancelled-a",
                    session_id: "swarm-worker-a",
                    ordinal: 0,
                    title: "Backend audit",
                    agent: "research",
                    depth: 1,
                    status: "cancelled",
                    started_at: "2026-07-23T11:58:00.000Z",
                    finished_at: now,
                    error: null,
                    cost: 0,
                    tokens: { input: 100, output: 20 },
                  },
                ],
              },
            },
          ],
        },
      ],
    );

    await page.goto("/c/session-swarm-cancelled");

    const swarm = page.getByRole("status", {
      name: "Agent swarm: Cancelled",
    });
    const lifecycle = swarm.getByRole("button", {
      name: "Show Agent swarm details",
    });
    await expect(lifecycle).toHaveAttribute("aria-expanded", "false");
    await expect(swarm.getByText("cancelled", { exact: true })).toBeVisible();
  });
});
