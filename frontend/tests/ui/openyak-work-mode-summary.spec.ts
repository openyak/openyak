import { expect, test, type Page } from "@playwright/test";
import {
  mockOpenYakApi,
  seedOpenYakStorage,
} from "./fixtures/openyak-api";

async function setupMockedApp(page: Page) {
  await seedOpenYakStorage(page);
  await mockOpenYakApi(page);
}

async function mockTaskSummaryEvidence(page: Page) {
  await page.route("**/api/subagents?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        active: [],
        done: [{ id: "child-review" }],
        counts: { active: 0, done: 1, total: 1 },
      }),
    }),
  );
  await page.route("**/api/messages/session-alpha*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        total: 2,
        offset: 0,
        messages: [
          {
            id: "summary-user",
            session_id: "session-alpha",
            time_created: "2026-07-23T11:58:00.000Z",
            data: { role: "user", agent: "build" },
            parts: Array.from({ length: 6 }, (_, index) => {
              const name =
                index === 0
                  ? "release-brief.pdf"
                  : index === 5
                    ? "signoff-notes.txt"
                    : `reference-${index + 1}.md`;
              return {
                id: `summary-input-${index}`,
                message_id: "summary-user",
                session_id: "session-alpha",
                time_created: "2026-07-23T11:58:00.000Z",
                data: {
                  type: "file",
                  file_id: `brief-${index}`,
                  name,
                  path: `/Users/alex/openyak-demo/${name}`,
                  size: 2048,
                  mime_type:
                    index === 0 ? "application/pdf" : "text/plain",
                  source: "uploaded",
                },
              };
            }),
          },
          {
            id: "summary-assistant",
            session_id: "session-alpha",
            time_created: "2026-07-23T12:00:00.000Z",
            data: { role: "assistant", agent: "build", finish: "stop" },
            parts: [
              {
                id: "summary-source",
                message_id: "summary-assistant",
                session_id: "session-alpha",
                time_created: "2026-07-23T12:00:00.000Z",
                data: {
                  type: "tool",
                  tool: "web_search",
                  call_id: "search-release",
                  state: {
                    status: "completed",
                    input: {},
                    output: "",
                    metadata: {
                      results: [
                        {
                          url: "https://example.com/release",
                          title: "Release guide",
                        },
                        {
                          url: "https://example.com/testing",
                          title: "Testing guide",
                        },
                        {
                          url: "https://example.com/accessibility",
                          title: "Accessibility guide",
                        },
                        {
                          url: "https://example.com/operations",
                          title: "Operations guide",
                        },
                        {
                          url: "https://example.com/security",
                          title: "Security guide",
                        },
                        {
                          url: "https://example.com/final-check",
                          title: "Final check guide",
                        },
                      ],
                    },
                    title: "Release research",
                    time_start: null,
                    time_end: null,
                    time_compacted: null,
                  },
                },
              },
            ],
          },
        ],
      }),
    }),
  );
}

test.describe("Codex-aligned Work Mode summary", () => {
  test.describe.configure({ timeout: 60_000 });
  test.skip(
    ({ isMobile }) => isMobile,
    "The Work Mode summary is a desktop workspace surface.",
  );

  test("Outputs is an accessible disclosure that controls its files", async ({
    page,
  }) => {
    await setupMockedApp(page);
    await page.goto("/c/session-alpha");

    const outputs = page.getByRole("button", {
      name: /Outputs.*5 generated files/i,
    });
    await expect(outputs).toHaveAttribute("aria-expanded", "true");
    await expect(page.getByRole("button", { name: "plan.md" })).toBeVisible();

    await outputs.click();

    await expect(outputs).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByRole("button", { name: "plan.md" })).toBeHidden();
  });

  test("Outputs reveals generated files beyond the first five on demand", async ({
    page,
  }) => {
    await setupMockedApp(page);
    await page.route("**/api/sessions/session-alpha/files", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          files: Array.from({ length: 10 }, (_, index) => ({
            name: `output-${index + 1}.md`,
            path: `/Users/alex/openyak-demo/output-${index + 1}.md`,
            type: "file",
            tool: "write",
          })),
        }),
      }),
    );
    await page.goto("/c/session-alpha");

    await expect(
      page.getByRole("button", { name: "output-6.md" }),
    ).toBeHidden();

    const showMore = page.getByRole("button", { name: "Show 5 more" });
    await expect(showMore).toHaveAttribute("aria-expanded", "false");
    await showMore.click();

    await expect(
      page.getByRole("button", { name: "output-6.md" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Show less" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  test("the task summary orders every available Work Mode section", async ({
    page,
  }) => {
    await setupMockedApp(page);
    await mockTaskSummaryEvidence(page);
    await page.goto("/c/session-alpha");

    const summary = page.getByRole("complementary", { name: "Task summary" });
    await expect(summary).toBeVisible();
    await expect(summary.getByRole("heading", { level: 2 })).toHaveText([
      "Progress",
      "Outputs",
      "Subagents",
      "Sources",
      "Inputs",
      "Context",
    ]);
    await expect(summary.getByText("Release guide")).toBeVisible();
    await expect(summary.getByText("release-brief.pdf")).toBeVisible();
    await expect(
      summary.getByRole("link", {
        name: "Open subagents: 0 working, 1 done",
      }),
    ).toBeVisible();
  });

  test("Sources uses View all instead of permanently hiding overflow", async ({
    page,
  }) => {
    await setupMockedApp(page);
    await mockTaskSummaryEvidence(page);
    await page.goto("/c/session-alpha");

    const sources = page.getByRole("region", { name: "Sources, 6" });
    await expect(sources.getByText("Release guide")).toBeVisible();
    await expect(sources.getByText("Final check guide")).toBeHidden();

    const viewAll = sources.getByRole("button", { name: "View all 6" });
    await expect(viewAll).toHaveAttribute("aria-expanded", "false");
    await viewAll.click();

    await expect(sources.getByText("Final check guide")).toBeVisible();
    await expect(
      sources.getByRole("button", { name: "Show less" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  test("Inputs exposes the exact hidden count and restores every item", async ({
    page,
  }) => {
    await setupMockedApp(page);
    await mockTaskSummaryEvidence(page);
    await page.goto("/c/session-alpha");

    const inputs = page.getByRole("region", { name: "Inputs, 6" });
    await expect(inputs.getByText("signoff-notes.txt")).toBeHidden();

    const showMore = inputs.getByRole("button", { name: "Show 1 more" });
    await expect(showMore).toHaveAttribute("aria-expanded", "false");
    await showMore.click();

    await expect(inputs.getByText("signoff-notes.txt")).toBeVisible();
    await expect(
      inputs.getByRole("button", { name: "Show less" }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  test("empty Work Mode sections stay out of the task summary", async ({
    page,
  }) => {
    await setupMockedApp(page);
    await page.route("**/api/sessions/session-beta/todos", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ todos: [] }),
      }),
    );
    await page.route("**/api/sessions/session-beta/files", (route) =>
      route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ files: [] }),
      }),
    );
    await page.goto("/c/session-beta");
    await page.getByRole("button", { name: /Show workspace/i }).click();

    const summary = page.getByRole("complementary", { name: "Task summary" });
    await expect(summary.getByRole("heading", { level: 2 })).toHaveText([
      "Context",
    ]);
    await expect(summary.getByText("No outputs yet")).toHaveCount(0);
  });
});
