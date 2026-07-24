import { expect, test, type Page } from "@playwright/test";
import {
  mockOpenYakApi,
  seedOpenYakStorage,
} from "./fixtures/openyak-api";

async function setup(page: Page) {
  await seedOpenYakStorage(page);
  await mockOpenYakApi(page);
  const time = "2026-07-23T10:00:00.000Z";
  const sharedSource = {
    url: "https://example.com/child-evidence",
    title: "Child evidence guide",
    domain: "example.com",
    snippet: "Evidence collected by a delegated reviewer.",
    tool: "web_search",
    origins: [
      {
        session_id: "child-review",
        agent_run_id: "child-review",
        agent_title: "Accessibility audit",
        status: "completed",
        tool: "web_search",
      },
      {
        session_id: "child-review",
        agent_run_id: "child-review",
        agent_title: "Accessibility audit",
        status: "completed",
        tool: "browser",
      },
    ],
  };
  await page.route("**/api/messages/session-alpha*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        total: 1,
        offset: 0,
        messages: [
          {
            id: "parent-evidence",
            session_id: "session-alpha",
            time_created: time,
            data: { role: "assistant", agent: "build", finish: "stop" },
            parts: [
              {
                id: "parent-source",
                message_id: "parent-evidence",
                session_id: "session-alpha",
                time_created: time,
                data: {
                  type: "tool",
                  tool: "web_search",
                  call_id: "parent-search",
                  state: {
                    status: "completed",
                    input: {},
                    output: "",
                    metadata: {
                      results: [
                        {
                          url: "https://example.com/child-evidence/",
                          title: "Parent evidence guide",
                        },
                      ],
                    },
                    title: "Evidence search",
                    time_start: time,
                    time_end: time,
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
  const baseRun = {
    agent_run_id: "child-review",
    agent: "research",
    session_id: "child-review",
    parent_session_id: "session-alpha",
    parent_title: "Quarterly planning notes",
    title: "Accessibility audit",
    summary: "Audit complete.",
    status: "completed",
    source: "swarm",
    swarm_id: "swarm-release",
    ordinal: 0,
    started_at: time,
    finished_at: time,
    last_message_at: time,
    time_updated: time,
    error: null,
  };

  await page.route("**/api/subagents?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        active: [],
        done: [
          {
            ...baseRun,
            id: "child-review",
            outputs: [
              {
                name: "plan.md",
                path: "/Users/alex/openyak-demo/plan.md",
                type: "generated",
                tool: "write",
              },
              {
                name: "child-findings.md",
                path: "/Users/alex/openyak-demo/child-findings.md",
                type: "generated",
                tool: "artifact",
                origins: [
                  {
                    session_id: "child-review",
                    agent_run_id: "child-review",
                    agent_title: "Accessibility audit",
                    status: "completed",
                    tool: "artifact",
                  },
                  {
                    session_id: "child-review",
                    agent_run_id: "child-review",
                    agent_title: "Accessibility audit",
                    status: "completed",
                    tool: "write",
                  },
                ],
              },
            ],
            sources: [
              sharedSource,
              {
                url: "HTTPS://Renderer.Example.COM:443/guide#private-fragment",
                title: "Renderer canonical source",
                domain: "renderer.example.com",
                tool: "browser",
              },
              {
                url: "javascript:alert(1)",
                title: "Unsafe child source",
                domain: "unsafe.local",
                tool: "web_fetch",
              },
            ],
          },
          {
            ...baseRun,
            id: "child-review-replay",
            agent_run_id: "child-review",
            outputs: [
              {
                name: "child-findings.md",
                path: "/Users/alex/openyak-demo/child-findings.md",
                type: "generated",
                tool: "artifact",
              },
            ],
            sources: [sharedSource],
          },
        ],
        counts: { active: 0, done: 2, total: 2 },
      }),
    }),
  );
}

test.describe("Work Mode child evidence summary", () => {
  test.skip(
    ({ isMobile }) => isMobile,
    "The Workspace Summary is a desktop surface.",
  );

  test("aggregates deduplicated child outputs and sources with visible provenance", async ({
    page,
  }) => {
    await setup(page);
    await page.goto("/c/session-alpha");

    const summary = page.getByRole("complementary", { name: "Task summary" });
    const outputs = summary.getByRole("button", {
      name: /Outputs\. 6 generated files/i,
    });
    await expect(outputs).toBeVisible();
    await summary.getByRole("button", { name: "Show 1 more" }).click();

    const sharedOutput = summary.getByRole("button", {
      name: /plan\.md.*Quarterly planning notes.*session session-alpha.*Accessibility audit.*session child-review/i,
    });
    await expect(sharedOutput).toBeVisible();
    await expect(
      sharedOutput.getByText("2 origins · Accessibility audit · completed · write"),
    ).toBeVisible();

    const childOutput = summary.getByRole("button", {
      name: /child-findings\.md.*Accessibility audit.*research.*child-review.*artifact/i,
    });
    await expect(childOutput).toBeVisible();
    await expect(
      childOutput.getByText(
        "2 origins · Accessibility audit · completed · artifact",
      ),
    ).toBeVisible();

    const sources = summary.getByRole("region", { name: "Sources, 3" });
    const source = sources.getByRole("link", {
      name: /Parent evidence guide.*example\.com.*Quarterly planning notes.*session session-alpha.*Accessibility audit.*session child-review/i,
    });
    await expect(source).toBeVisible();
    await expect(source).toHaveAttribute(
      "title",
      /Quarterly planning notes.*build.*session-alpha.*web_search.*Accessibility audit.*research.*child-review/i,
    );
    await expect(source).toHaveAttribute(
      "href",
      "https://example.com/child-evidence/",
    );
    await expect(
      source.getByText("example.com · 3 origins · Accessibility audit · completed"),
    ).toBeVisible();

    const canonicalSource = sources.getByRole("link", {
      name: /Renderer canonical source/i,
    });
    await expect(canonicalSource).toHaveAttribute(
      "href",
      "https://renderer.example.com/guide",
    );
    await expect(canonicalSource).toHaveAttribute(
      "title",
      /https:\/\/renderer\.example\.com\/guide/,
    );
    await expect(canonicalSource).not.toHaveAttribute(
      "title",
      /private-fragment/,
    );

    await expect(sources.getByText("Unsafe child source")).toBeVisible();
    await expect(
      sources.getByRole("link", { name: /Unsafe child source/i }),
    ).toHaveCount(0);
    const unsafeSource = sources
      .getByText("Unsafe child source")
      .locator("..")
      .locator("..");
    await expect(unsafeSource).toHaveAttribute(
      "title",
      /External link unavailable/,
    );
    await expect(unsafeSource).not.toHaveAttribute(
      "title",
      /javascript:alert/,
    );
  });
});
