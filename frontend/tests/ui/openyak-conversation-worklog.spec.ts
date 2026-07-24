import { expect, test, type Page } from "@playwright/test";
import {
  mockOpenYakApi,
  seedOpenYakStorage,
} from "./fixtures/openyak-api";

const now = "2026-07-23T12:00:00.000Z";

function toolPart(
  sessionId: string,
  messageId: string,
  callId: string,
  tool: string,
  input: Record<string, unknown>,
) {
  return {
    id: `${messageId}-${callId}`,
    message_id: messageId,
    session_id: sessionId,
    time_created: now,
    data: {
      type: "tool",
      tool,
      call_id: callId,
      state: {
        status: "completed",
        input,
        output: "ok",
        metadata: {},
        title: null,
        time_start: "2026-07-23T11:58:00.000Z",
        time_end: "2026-07-23T11:58:01.000Z",
        time_compacted: null,
      },
    },
  };
}

async function mockWorklogSession(page: Page) {
  const sessionId = "session-worklog";
  const assistantId = `${sessionId}-assistant`;
  const messages = [
    {
      id: `${sessionId}-user`,
      session_id: sessionId,
      time_created: "2026-07-23T11:57:00.000Z",
      data: { role: "user", agent: "build" },
      parts: [
        {
          id: `${sessionId}-user-text`,
          message_id: `${sessionId}-user`,
          session_id: sessionId,
          time_created: "2026-07-23T11:57:00.000Z",
          data: {
            type: "text",
            text: "Audit the release and coordinate two focused agents.",
          },
        },
      ],
    },
    {
      id: assistantId,
      session_id: sessionId,
      time_created: "2026-07-23T11:58:00.000Z",
      data: {
        role: "assistant",
        agent: "build",
        finish: "stop",
      },
      parts: [
        {
          id: `${assistantId}-opening`,
          message_id: assistantId,
          session_id: sessionId,
          time_created: "2026-07-23T11:58:00.000Z",
          data: {
            type: "text",
            text: "I split the release review into two parallel tracks.",
          },
        },
        toolPart(
          sessionId,
          assistantId,
          "read-one",
          "read",
          { file_path: "/workspace/README.md" },
        ),
        toolPart(
          sessionId,
          assistantId,
          "read-two",
          "read",
          { file_path: "/workspace/package.json" },
        ),
        toolPart(
          sessionId,
          assistantId,
          "bash-one",
          "bash",
          { command: "npm test" },
        ),
        {
          id: `${assistantId}-swarm`,
          message_id: assistantId,
          session_id: sessionId,
          time_created: "2026-07-23T11:59:00.000Z",
          data: {
            type: "swarm",
            schema_version: 1,
            swarm_id: "release-swarm",
            parent_session_id: sessionId,
            revision: 2,
            status: "completed",
            strategy: "parallel",
            failure_policy: "continue",
            started_at: "2026-07-23T11:58:05.000Z",
            finished_at: "2026-07-23T11:59:00.000Z",
            members: [
              {
                agent_run_id: "release-agent-backend",
                session_id: "release-agent-backend-session",
                ordinal: 0,
                title: "Backend review",
                agent: "research",
                depth: 1,
                status: "completed",
                started_at: "2026-07-23T11:58:05.000Z",
                finished_at: "2026-07-23T11:58:50.000Z",
                error: null,
                cost: 0,
                tokens: { input: 100, output: 40 },
              },
              {
                agent_run_id: "release-agent-frontend",
                session_id: "release-agent-frontend-session",
                ordinal: 1,
                title: "Frontend review",
                agent: "research",
                depth: 1,
                status: "completed",
                started_at: "2026-07-23T11:58:05.000Z",
                finished_at: "2026-07-23T11:59:00.000Z",
                error: null,
                cost: 0,
                tokens: { input: 120, output: 50 },
              },
            ],
          },
        },
        {
          id: `${assistantId}-middle`,
          message_id: assistantId,
          session_id: sessionId,
          time_created: "2026-07-23T11:59:01.000Z",
          data: {
            type: "text",
            text: "Both reviews found the same release risk.",
          },
        },
        {
          id: `${assistantId}-compaction`,
          message_id: assistantId,
          session_id: sessionId,
          time_created: "2026-07-23T11:59:02.000Z",
          data: {
            type: "compaction",
            auto: true,
            compactionStatus: "completed",
          },
        },
        toolPart(
          sessionId,
          assistantId,
          "edit-one",
          "edit",
          { file_path: "/workspace/release.ts" },
        ),
        {
          id: `${assistantId}-closing`,
          message_id: assistantId,
          session_id: sessionId,
          time_created: "2026-07-23T12:00:00.000Z",
          data: {
            type: "text",
            text: "The release is ready for one final verification.",
          },
        },
      ],
    },
  ];

  await page.route(`**/api/sessions/${sessionId}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: sessionId,
        project_id: null,
        parent_id: null,
        slug: null,
        directory: "/Users/alex/openyak-demo",
        title: "Release worklog review",
        version: 0,
        summary_additions: 1,
        summary_deletions: 0,
        summary_files: 1,
        summary_diffs: [],
        is_pinned: false,
        permission: {},
        model_id: "openrouter/anthropic/claude-sonnet-4.5",
        provider_id: "openrouter",
        time_created: now,
        time_updated: now,
        time_compacting: null,
        time_archived: null,
      }),
    }),
  );
  await page.route(`**/api/messages/${sessionId}*`, (route) =>
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

test.describe("Codex-aligned conversation worklog", () => {
  test.skip(
    ({ isMobile }) => isMobile,
    "The desktop transcript is the canonical Work Mode timeline.",
  );

  test("keeps prose, activity, agents, compaction, and follow-up work in execution order", async ({
    page,
  }) => {
    await seedOpenYakStorage(page);
    await mockOpenYakApi(page);
    await mockWorklogSession(page);
    await page.goto("/c/session-worklog");

    const main = page.locator("#main-content");
    await expect(
      main.getByText("I split the release review into two parallel tracks."),
    ).toBeVisible();
    await expect(
      main.getByRole("button", { name: /read files.*ran a command/i }),
    ).toBeVisible();
    await expect(main.getByText("Backend review", { exact: true })).toBeVisible();
    await expect(main.getByText("Frontend review", { exact: true })).toBeVisible();
    await expect(
      main.getByText("Both reviews found the same release risk."),
    ).toBeVisible();
    await expect(
      main.getByText(/Optimized the conversation|Context compressed/i),
    ).toBeVisible();
    await expect(
      main.getByRole("button", { name: /edited a file/i }),
    ).toBeVisible();
    await expect(
      main.getByText("The release is ready for one final verification."),
    ).toBeVisible();

    const order = await main.evaluate((element) => {
      const text = element.textContent ?? "";
      return [
        "I split the release review into two parallel tracks.",
        "Read files",
        "Backend review",
        "Both reviews found the same release risk.",
        "Optimized the conversation",
        "Edited a file",
        "The release is ready for one final verification.",
      ].map((needle) => text.toLowerCase().indexOf(needle.toLowerCase()));
    });

    expect(order.every((position) => position >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));

    const activityTrigger = main
      .getByRole("button", { name: /read files.*ran a command/i });
    await expect(activityTrigger).toHaveAttribute("aria-expanded", "false");
    await expect(activityTrigger).toHaveAttribute(
      "aria-controls",
      "activity-panel",
    );
    await activityTrigger.click();
    await expect(activityTrigger).toHaveAttribute("aria-expanded", "true");
    await expect(
      page.locator("#activity-panel[aria-label='Activity']"),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close activity" }).click();
    await expect(activityTrigger).toBeFocused();
  });

  test("removes the old text cursor as soon as tool work starts", async ({
    page,
  }) => {
    await seedOpenYakStorage(page);
    await mockOpenYakApi(page);
    await page.goto("/c/new");
    await page
      .getByPlaceholder(/Describe the result you want/i)
      .fill("Start the text then tool cursor regression");
    const promptResponse = page.waitForResponse(
      (response) =>
        response.url().includes("/api/chat/prompt") &&
        response.status() === 200,
    );
    await page.getByRole("button", { name: /Send message/i }).click();
    await promptResponse;

    await expect(
      page.getByText("Text completed before the tool starts."),
    ).toBeVisible();
    await expect(page.getByText("Working with tools")).toBeVisible();
    await expect(page.locator(".streaming-cursor")).toHaveCount(0);
  });
});
