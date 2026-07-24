import { expect, test, type Page, type Route } from "@playwright/test";
import {
  mockOpenYakApi,
  seedOpenYakStorage,
  type OpenYakMockOptions,
} from "./fixtures/openyak-api";

type RunStatus =
  | "pending"
  | "running"
  | "waiting_input"
  | "completed"
  | "failed"
  | "cancelled";

function run(
  id: string,
  status: RunStatus,
  overrides: Record<string, unknown> = {},
) {
  const active =
    status === "pending" ||
    status === "running" ||
    status === "waiting_input";
  const time = new Date(Date.now() - 8 * 60 * 60 * 1000).toISOString();
  return {
    id,
    agent_run_id: id,
    agent: "research",
    session_id: `child-${id}`,
    parent_session_id: "session-alpha",
    parent_title: "Quarterly planning notes",
    title: `Agent ${id}`,
    summary: active ? null : `Completed result from ${id}.`,
    status,
    source: "swarm",
    swarm_id: "swarm-release",
    ordinal: 0,
    started_at: time,
    finished_at: active ? null : time,
    last_message_at: active ? null : time,
    time_updated: time,
    error: null,
    ...overrides,
  };
}

const scopedResponse = {
  active: [
    run("active", "running", {
      title: "Static terminal audit",
      summary: "Reviewing terminal lifecycle and cancellation behavior.",
      last_message_at: new Date(
        Date.now() - 5 * 60 * 1000,
      ).toISOString(),
    }),
  ],
  done: [
    run("done-a", "completed", {
      title: "Swarm review",
      summary: "No remaining release blockers were found.",
    }),
    run("done-b", "failed", {
      title: "UI regression",
      summary: null,
      error: "One browser assertion failed.",
    }),
  ],
  counts: { active: 1, done: 2, total: 3 },
};

function fulfillJson(route: Route, body: unknown) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

async function setup(
  page: Page,
  response: typeof scopedResponse = scopedResponse,
  options: OpenYakMockOptions = {},
) {
  const requests: string[] = [];
  await seedOpenYakStorage(page);
  await mockOpenYakApi(page, options);
  await page.route("**/api/subagents*", (route) => {
    requests.push(route.request().url());
    return fulfillJson(route, response);
  });
  return requests;
}

test.describe("Codex-aligned Subagents GUI", () => {
  test.describe.configure({ timeout: 60_000 });
  test.skip(
    ({ isMobile }) => isMobile,
    "Workspace and desktop sidebar summaries are desktop surfaces.",
  );

  test("opens the Subagents list inside its parent task shell", async ({
    page,
  }) => {
    await setup(page);

    await page.goto("/c/session-alpha?view=subagents");

    await expect(page).toHaveURL(
      /\/c\/session-alpha\?view=subagents$/,
    );
    await expect(
      page.getByRole("heading", { name: "Subagents", level: 1 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Active", level: 2 }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Back to parent task" }),
    ).toHaveAttribute("href", "/c/session-alpha");
    await expect(
      page.getByRole("link", { name: "Open Static terminal audit" }),
    ).toHaveAttribute(
      "href",
      "/c/session-alpha?view=subagents&child=child-active",
    );
  });

  test("workspace summary opens the task Work view without resetting its draft", async ({
    page,
  }) => {
    const requests = await setup(page);
    await page.goto("/c/session-alpha");

    const composer = page.getByPlaceholder(/Describe the result you want/i);
    await composer.fill("Keep this parent-task draft");

    const summary = page.getByRole("link", { name: "Open subagents" });
    await expect(summary).toBeVisible();
    await expect(summary).toContainText("Subagents");
    await expect(summary).toContainText("1 working");
    await expect(summary).toContainText("2 done");
    await expect(summary).toHaveAttribute(
      "href",
      "/c/session-alpha?view=subagents",
    );
    await expect(
      page.getByRole("complementary", { name: "Task summary" }),
    ).toContainText("Outputs");
    await expect.poll(() => requests).toContainEqual(
      expect.stringContaining(
        "/api/subagents?parent_session_id=session-alpha",
      ),
    );
    expect(
      requests.some((url) => /\/api\/subagents$/.test(url)),
    ).toBe(false);

    await summary.click();
    await expect(page).toHaveURL(
      /\/c\/session-alpha\?view=subagents$/,
    );
    await expect(composer).toHaveValue("Keep this parent-task draft");
    await expect(summary).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Active", level: 2 }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Done · 2", level: 2 }),
    ).toBeVisible();

    await expect(
      page.getByRole("link", { name: "Open Static terminal audit" }),
    ).toHaveAttribute(
      "href",
      "/c/session-alpha?view=subagents&child=child-active",
    );
    await expect(
      page.getByRole("link", { name: "Open Swarm review" }),
    ).toContainText("No remaining release blockers were found.");
    await expect(
      page.getByRole("link", { name: "Open UI regression" }),
    ).toContainText("One browser assertion failed.");

    await page
      .getByRole("link", { name: "Open Static terminal audit" })
      .click();
    await expect(page).toHaveURL(
      /\/c\/session-alpha\?view=subagents&child=child-active$/,
    );
    await expect(
      page.getByRole("link", { name: "Back to subagents" }),
    ).toHaveAttribute("href", "/c/session-alpha?view=subagents");
    await expect(page.getByText("Static terminal audit")).toBeVisible();
    await expect(composer).toHaveValue("Keep this parent-task draft");

    await page.getByRole("link", { name: "Back to subagents" }).click();
    await expect(
      page.getByRole("heading", { name: "Subagents", level: 1 }),
    ).toBeFocused();
    await page.getByRole("link", { name: "Back to parent task" }).click();
    await expect(page).toHaveURL(/\/c\/session-alpha$/);
    await expect(summary).toBeFocused();
  });

  test("child detail separates status, delegated task, and final response", async ({
    page,
  }) => {
    await setup(page);

    await page.goto(
      "/c/session-alpha?view=subagents&child=child-done-a",
    );

    const detail = page.getByRole("region", {
      name: "Subagent details",
    });
    await expect(
      detail.getByRole("heading", { name: "Status", level: 2 }),
    ).toBeVisible();
    await expect(detail.getByText("Completed", { exact: true })).toBeVisible();
    await expect(
      detail.getByRole("heading", { name: "Delegated task", level: 2 }),
    ).toBeVisible();
    await expect(
      detail.getByText("Summarize the quarterly plan"),
    ).toBeVisible();
    await expect(
      detail.getByRole("heading", { name: "Final response", level: 2 }),
    ).toBeVisible();
    await expect(
      detail.getByText(
        "The plan has three priorities: retention, onboarding, and pricing clarity.",
      ),
    ).toBeVisible();
  });

  test("running child keeps Final response structure while marking output live", async ({
    page,
  }) => {
    await setup(page);

    await page.goto(
      "/c/session-alpha?view=subagents&child=child-active",
    );

    const detail = page.getByRole("region", {
      name: "Subagent details",
    });
    await expect(detail.getByText("Running", { exact: true })).toBeVisible();
    await expect(
      detail.getByRole("heading", { name: "Final response", level: 2 }),
    ).toBeVisible();
    await expect(detail.getByText("Live response", { exact: true })).toBeVisible();
    await expect(
      detail.getByText(
        "The plan has three priorities: retention, onboarding, and pricing clarity.",
      ),
    ).toBeVisible();
  });

  test("running child appends live stream output from its session bucket", async ({
    page,
  }) => {
    await setup(page);
    let activeRequests = 0;
    let childStarted = false;
    await page.route("**/api/chat/active", (route) => {
      activeRequests += 1;
      return fulfillJson(
        route,
        childStarted
          ? [
              {
                session_id: "child-active",
                stream_id: "stream-slow",
              },
            ]
          : [],
      );
    });

    await page.goto("/c/session-alpha");
    await expect.poll(() => activeRequests).toBeGreaterThanOrEqual(2);
    childStarted = true;
    await page.getByRole("link", { name: "Open subagents" }).click();
    await page
      .getByRole("link", { name: "Open Static terminal audit" })
      .click();

    const detail = page.getByRole("region", {
      name: "Subagent details",
    });
    await expect(detail.getByText("Live response", { exact: true })).toBeVisible();
    await expect(
      detail.getByText(
        /Starting a deliberately slow GUI stream\./,
      ),
    ).toBeVisible({ timeout: 2_500 });
  });

  test("waiting child can answer its permission request inside Work view", async ({
    page,
  }) => {
    await seedOpenYakStorage(page, { force: true, workMode: "ask" });
    const permissionRun = run("permission", "waiting_input", {
      title: "Permission-gated audit",
    });
    await setup(
      page,
      {
        active: [permissionRun],
        done: [],
        counts: { active: 1, done: 0, total: 1 },
      },
      {
        activeJobs: [
          {
            session_id: "child-permission",
            stream_id: "stream-permission",
            parent_session_id: "session-alpha",
            needs_input: true,
          },
        ],
      },
    );
    const responses: unknown[] = [];
    await page.route("**/api/chat/respond", (route) => {
      responses.push(route.request().postDataJSON());
      return fulfillJson(route, { status: "submitted" });
    });

    await page.goto("/c/session-alpha?view=subagents");
    await expect(
      page.getByRole("link", {
        name: /Open subagents.*1 waiting for input/i,
      }),
    ).toBeVisible();
    const waitingRun = page.getByRole("link", {
      name: /Open Permission-gated audit.*Waiting for input/i,
    });
    await expect(waitingRun).toContainText("Waiting for input");
    await waitingRun.click();

    await expect(
      page.getByRole("heading", { name: "Permission Required" }),
    ).toBeVisible({ timeout: 2_500 });
    await page.getByRole("button", { name: "Allow" }).click();

    await expect.poll(() => responses).toContainEqual(
      expect.objectContaining({
        stream_id: "stream-permission",
        call_id: "perm-run-tests",
        response: expect.objectContaining({ allowed: true }),
      }),
    );
  });

  test("large Active and Done sections reveal the runs beyond their first page", async ({
    page,
  }) => {
    const active = Array.from({ length: 6 }, (_, index) =>
      run(`active-${index}`, "running"),
    );
    const done = Array.from({ length: 12 }, (_, index) =>
      run(`done-${index}`, "completed"),
    );
    await setup(page, {
      active,
      done,
      counts: { active: active.length, done: done.length, total: 18 },
    });

    await page.goto("/c/session-alpha?view=subagents");

    const activeSection = page
      .getByRole("heading", { name: "Active", level: 2 })
      .locator("..");
    const doneSection = page
      .getByRole("heading", { name: "Done · 12", level: 2 })
      .locator("..");

    await expect(activeSection.getByRole("link")).toHaveCount(4);
    await expect(doneSection.getByRole("link")).toHaveCount(10);

    await activeSection
      .getByRole("button", { name: "Show 2 more" })
      .click();
    await doneSection
      .getByRole("button", { name: "Show 2 more" })
      .click();

    await expect(activeSection.getByRole("link")).toHaveCount(6);
    await expect(doneSection.getByRole("link")).toHaveCount(12);
  });

  test("failed child keeps its delegated task and explains why no final answer arrived", async ({
    page,
  }) => {
    await setup(page);

    await page.goto(
      "/c/session-alpha?view=subagents&child=child-done-b",
    );

    const detail = page.getByRole("region", {
      name: "Subagent details",
    });
    await expect(detail.getByText("Failed", { exact: true })).toBeVisible();
    await expect(
      detail.getByText("Summarize the quarterly plan"),
    ).toBeVisible();
    await expect(
      detail.getByRole("heading", { name: "Final response", level: 2 }),
    ).toBeVisible();
    await expect(
      detail.getByText(
        "The plan has three priorities: retention, onboarding, and pricing clarity.",
      ),
    ).toBeVisible();
    await expect(
      detail.getByRole("alert"),
    ).toContainText("One browser assertion failed.");
  });

  test("cancelled child keeps partial output beside its terminal explanation", async ({
    page,
  }) => {
    const cancelled = run("cancelled", "cancelled", {
      title: "Cancelled audit",
      error: "Cancelled by the parent task.",
    });
    await setup(page, {
      active: [],
      done: [cancelled],
      counts: { active: 0, done: 1, total: 1 },
    });

    await page.goto(
      "/c/session-alpha?view=subagents&child=child-cancelled",
    );

    const detail = page.getByRole("region", {
      name: "Subagent details",
    });
    await expect(detail.getByText("Cancelled", { exact: true })).toBeVisible();
    await expect(
      detail.getByText(
        "The plan has three priorities: retention, onboarding, and pricing clarity.",
      ),
    ).toBeVisible();
    await expect(detail.getByText("Cancelled by the parent task.")).toBeVisible();
  });

  test("unavailable child history stays in detail with a retry action", async ({
    page,
  }) => {
    await setup(page);
    await page.route("**/api/messages/child-done-a*", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ detail: "Temporarily unavailable" }),
      }),
    );

    await page.goto(
      "/c/session-alpha?view=subagents&child=child-done-a",
    );

    const detail = page.getByRole("region", {
      name: "Subagent details",
    });
    await expect(
      detail.getByText("Delegated task unavailable."),
    ).toBeVisible();
    await expect(detail.getByRole("alert")).toContainText(
      "Subagent history is temporarily unavailable.",
    );
    await expect(
      detail.getByRole("button", { name: "Retry" }),
    ).toBeVisible();
    await expect(page).toHaveURL(
      /child=child-done-a$/,
    );
  });

  test("child detail labels both sections while its history is loading", async ({
    page,
  }) => {
    await setup(page);
    let releaseMessages: (() => void) | undefined;
    const messagesHeld = new Promise<void>((resolve) => {
      releaseMessages = resolve;
    });
    await page.route("**/api/messages/child-done-a*", async (route) => {
      await messagesHeld;
      await fulfillJson(route, {
        total: 0,
        offset: 0,
        messages: [],
      });
    });

    await page.goto(
      "/c/session-alpha?view=subagents&child=child-done-a",
    );

    const detail = page.getByRole("region", {
      name: "Subagent details",
    });
    await expect(detail.getByText("Loading delegated task…")).toBeVisible();
    await expect(detail.getByText("Loading response…")).toBeVisible();

    releaseMessages?.();
    await expect(detail.getByText("Final response unavailable.")).toBeVisible();
  });

  test("list and child detail restore focus as the Work view changes", async ({
    page,
  }) => {
    await setup(page);
    await page.goto("/c/session-alpha?view=subagents");

    const pageHeading = page.getByRole("heading", {
      name: "Subagents",
      level: 1,
    });
    await expect(pageHeading).toBeFocused();

    await page
      .getByRole("link", { name: "Open Swarm review" })
      .click();
    const detail = page.getByRole("region", {
      name: "Subagent details",
    });
    await expect(detail).toBeFocused();
    await expect(detail).toHaveCSS("outline-style", "none");

    await page
      .getByRole("link", { name: "Back to subagents" })
      .click();
    await expect(pageHeading).toBeFocused();
  });

  test("terminal child status includes its elapsed run time", async ({
    page,
  }) => {
    const timedRun = run("timed", "completed", {
      title: "Timed review",
      started_at: "2026-04-26T10:00:00.000Z",
      finished_at: "2026-04-26T10:01:30.000Z",
    });
    await setup(page, {
      active: [],
      done: [timedRun],
      counts: { active: 0, done: 1, total: 1 },
    });

    await page.goto(
      "/c/session-alpha?view=subagents&child=child-timed",
    );

    const detail = page.getByRole("region", {
      name: "Subagent details",
    });
    await expect(detail.getByText("Completed", { exact: true })).toBeVisible();
    await expect(detail.getByText("1m 30s", { exact: true })).toBeVisible();
  });

  test("empty lifecycle sections and pending fallback match Codex", async ({
    page,
  }) => {
    await setup(page, {
      active: [
        run("pending", "pending", {
          title: "Starting reviewer",
          summary: null,
          last_message_at: null,
        }),
      ],
      done: [],
      counts: { active: 1, done: 0, total: 1 },
    });

    await page.goto("/subagents?parent=session-alpha");

    await expect(page.getByText("Thinking")).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Done · 0", level: 2 }),
    ).toBeVisible();
  });

  test("a child-agent task can navigate back to its parent", async ({
    page,
  }) => {
    await setup(page);
    const sessionTime = new Date().toISOString();

    await page.route("**/api/sessions/child-active", (route) =>
      fulfillJson(route, {
        id: "child-active",
        project_id: null,
        parent_id: "session-alpha",
        slug: null,
        directory: "/Users/alex/openyak-demo",
        title: "Static terminal audit",
        version: 0,
        summary_additions: 0,
        summary_deletions: 0,
        summary_files: 0,
        summary_diffs: [],
        is_pinned: false,
        permission: {},
        model_id: "openrouter/anthropic/claude-sonnet-4.5",
        provider_id: "openrouter",
        time_created: sessionTime,
        time_updated: sessionTime,
        time_compacting: null,
        time_archived: null,
      }),
    );

    await page.goto("/c/child-active");

    const parentLink = page.getByRole("link", {
      name: "Back to parent task: Quarterly planning notes",
    });
    await expect(parentLink).toBeVisible();
    await expect(parentLink).toHaveAttribute("href", "/c/session-alpha");
  });
});
