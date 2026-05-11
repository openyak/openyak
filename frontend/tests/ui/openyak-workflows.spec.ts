import { expect, test, type Page } from "@playwright/test";
import {
  mockOpenYakApi,
  seedOpenYakStorage,
  type OpenYakMockState,
} from "./fixtures/openyak-api";

async function setupMockedApp(page: Page): Promise<OpenYakMockState> {
  await seedOpenYakStorage(page);
  return mockOpenYakApi(page);
}

async function expectNoAppCrash(page: Page) {
  await expect(page.getByText("Runtime", { exact: false })).toHaveCount(0);
  await expect(page.getByText("API 401", { exact: false })).toHaveCount(0);
}

async function sendPrompt(page: Page, text: string) {
  await page.getByPlaceholder(/Describe the result you want/i).fill(text);
  const promptResponse = page.waitForResponse(
    (res) => res.url().includes("/api/chat/prompt") && res.status() === 200,
  );
  await page.getByRole("button", { name: /Send message/i }).click();
  await promptResponse;
}

test.describe("OpenYak complete GUI workflows", () => {
  test.describe.configure({ timeout: 60_000 });

  test("chat task journey: workspace, attachment, mention, send, persist, search, reopen", async ({
    page,
  }) => {
    const state = await setupMockedApp(page);

    await page.goto(
      `/c/new?directory=${encodeURIComponent("/Users/alex/openyak-demo")}`,
    );
    await expect(
      page.getByRole("heading", {
        name: /What should (OpenYak help you do|we do in)/i,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Best Free/i }),
    ).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles({
      name: "sample-preflight.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("workflow,status\nchat,covered\n"),
    });
    await expect(page.getByText("sample-preflight.csv")).toBeVisible();

    const composer = page.getByPlaceholder(/Describe the result you want/i);
    await composer.fill("@rel");
    await page
      .getByRole("button", { name: /release-notes\.md docs\/release/i })
      .click();
    await expect(page.getByText("release-notes.md").first()).toBeVisible();

    await sendPrompt(page, "Create a UI preflight checklist");

    await expect(page).toHaveURL(/\/c\/session-new$/);
    await expect(
      page.getByText("Create a UI preflight checklist").first(),
    ).toBeVisible();
    await expect(page.getByText("sample-preflight.csv").first()).toBeVisible();
    await expect(page.getByText("release-notes.md").first()).toBeVisible();
    await expect(
      page.getByText("Preflight answer streamed from the mock backend."),
    ).toBeVisible();

    expect(state.fileUploads).toEqual(["sample-preflight.csv"]);
    expect(JSON.stringify(state.promptBodies[0])).toContain(
      "Create a UI preflight checklist",
    );
    expect(JSON.stringify(state.promptBodies[0])).toContain(
      "/Users/alex/openyak-demo",
    );
    expect(JSON.stringify(state.promptBodies[0])).toContain("release-notes.md");

    await page.reload();
    await expect(
      page.getByText("Preflight answer streamed from the mock backend."),
    ).toBeVisible();
    await expect(
      page.getByText("Create a UI preflight checklist").first(),
    ).toBeVisible();

    await page.keyboard.press("Control+K");
    await page.getByPlaceholder("Search chats").fill("preflight");
    await expect(
      page.getByLabel("Results").getByText("Create a UI preflight checklist"),
    ).toBeVisible();
    await page
      .getByLabel("Results")
      .getByText("Create a UI preflight checklist")
      .click();
    await expect(page).toHaveURL(/\/c\/session-new$/);
    await expectNoAppCrash(page);
  });

  test("provider setup journey: configure providers, switch model surface, send with selected provider", async ({
    page,
  }) => {
    const state = await setupMockedApp(page);

    await page.goto("/settings?tab=providers");
    await expect(
      page.getByRole("heading", { name: "Providers" }),
    ).toBeVisible();

    await page.getByRole("button", { name: /Own API Key/i }).click();
    await page.getByPlaceholder("sk-or-...").fill("sk-or-workflow");
    const ownKeySave = page.waitForResponse(
      (res) =>
        res.url().includes("/api/config/providers/openrouter/key") &&
        res.request().method() === "POST" &&
        res.status() === 200,
    );
    await page.getByRole("button", { name: "Save" }).first().click();
    await ownKeySave;
    expect(JSON.stringify(state.providerSaves)).toContain("sk-or-workflow");

    await expect
      .poll(() =>
        page.evaluate(
          () =>
            JSON.parse(window.localStorage.getItem("openyak-settings") ?? "{}")
              ?.state?.activeProvider,
        ),
      )
      .toBe("byok");

    await page.goto("/c/new");
    await expect(
      page.getByRole("button", { name: /Claude Sonnet 4\.5/i }),
    ).toBeVisible();

    await sendPrompt(page, "Create a UI preflight checklist");
    await expect(page).toHaveURL(/\/c\/session-new$/);
    expect(JSON.stringify(state.promptBodies[0])).toContain(
      "openrouter/anthropic/claude-sonnet-4.5",
    );
    expect(JSON.stringify(state.promptBodies[0])).toContain("openrouter");

    await page.goto("/settings?tab=providers");

    await page.getByRole("button", { name: /Custom Endpoint/i }).click();
    await expect(page.getByText("Local endpoint")).toBeVisible();
    await expect(
      page.getByText("http://localhost:11434/v1", { exact: true }),
    ).toBeVisible();
    await page
      .getByPlaceholder("Endpoint Name (e.g. My Local Model)")
      .fill("Workflow Endpoint");
    await page
      .getByPlaceholder(
        "http://localhost:1234/v1 or https://api.example.com/v1",
      )
      .fill("http://localhost:1234/v1");
    const customSave = page.waitForResponse(
      (res) =>
        res.url().includes("/api/config/custom") &&
        res.request().method() === "POST" &&
        res.status() === 200,
    );
    await page.getByRole("button", { name: "Add Endpoint" }).click();
    await customSave;
    expect(JSON.stringify(state.providerSaves)).toContain("Workflow Endpoint");
    expect(JSON.stringify(state.providerSaves)).toContain(
      "http://localhost:1234/v1",
    );
    await expectNoAppCrash(page);
  });

  test("automation lifecycle journey: create, run, inspect history, edit, delete", async ({
    page,
  }) => {
    const state = await setupMockedApp(page);

    await page.goto("/settings?tab=automations");
    await expect(page.getByText("Morning brief")).toBeVisible();

    await page.getByRole("button", { name: "New Automation" }).click();
    await page
      .getByPlaceholder(/Weekly Briefing/i)
      .fill("Release note watcher");
    await page
      .getByPlaceholder(/Brief description/i)
      .fill("Watch docs before standup");
    await page
      .getByPlaceholder(/Describe what this automation should do/i)
      .fill("Summarize product docs every morning");
    await page.getByRole("button", { name: "Create" }).click();
    await expect(
      page.getByRole("heading", { name: "New Automation" }),
    ).toBeHidden();
    await expect(page.getByText("Release note watcher")).toBeVisible();
    expect(JSON.stringify(state.automationCreates[0])).toContain(
      "Release note watcher",
    );

    const createdCard = page
      .locator("div.rounded-lg")
      .filter({ hasText: "Release note watcher" });
    await createdCard.getByRole("button", { name: "Run Now" }).click();
    await expect.poll(() => state.automationRuns).toContain("automation-2");

    await createdCard.getByRole("button", { name: "History" }).click();
    await expect(createdCard.getByText("Manual")).toBeVisible();
    await expect(createdCard.getByText("View Result")).toBeVisible();

    await createdCard.getByText("Release note watcher").click();
    await expect(
      page.getByRole("heading", { name: "Edit Automation" }),
    ).toBeVisible();
    await page
      .locator('input[type="text"]')
      .first()
      .fill("Release note watcher updated");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(
      page.getByRole("heading", { name: "Edit Automation" }),
    ).toBeHidden();
    await expect(page.getByText("Release note watcher updated")).toBeVisible();
    expect(JSON.stringify(state.automationUpdates)).toContain(
      "Release note watcher updated",
    );

    const updatedCard = page
      .locator("div.rounded-lg")
      .filter({ hasText: "Release note watcher updated" });
    const iconButtons = updatedCard.locator("button");
    await iconButtons.nth(3).click();
    await expect(page.getByText("Delete this automation?")).toBeVisible();
    await page.getByRole("button", { name: "Delete" }).click();
    await expect(page.getByText("Delete this automation?")).toBeHidden();
    await expect(page.getByText("Release note watcher updated")).toBeHidden();
    expect(state.automationDeletes).toContain("automation-2");
    await expectNoAppCrash(page);
  });

  test("remote mobile handoff journey: enable desktop remote, change provider on mobile, submit task", async ({
    page,
  }) => {
    const state = await setupMockedApp(page);

    await page.goto("/settings?tab=remote");
    await expect(page.getByText("Remote Access Disabled")).toBeVisible();
    await page.getByRole("switch").click();
    await expect(page.getByText("Remote Access Active")).toBeVisible();
    await expect(
      page.getByText("https://remote.openyak.test", { exact: true }).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: /Rotate Token/i }).click();

    await page.goto("/m/settings?token=rotated-token");
    await expect(
      page.getByRole("heading", { name: "Connection" }),
    ).toBeVisible();
    await expect(page.getByText("Connected")).toBeVisible();
    await page
      .getByRole("button", { name: /ChatGPT Subscription 1 model available/i })
      .click();
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.localStorage.getItem("openyak_remote_provider"),
        ),
      )
      .toBe("chatgpt");

    await page.goto("/m/new");
    await expect(page.getByRole("heading", { name: "New Task" })).toBeVisible();
    await expect(page.locator("select")).toContainText("GPT-5.5");
    await page
      .getByPlaceholder("What should OpenYak do?")
      .fill("Check the release notes from my phone");

    const promptResponse = page.waitForResponse(
      (res) => res.url().includes("/api/chat/prompt") && res.status() === 200,
    );
    await page.getByPlaceholder("What should OpenYak do?").press("Enter");
    await promptResponse;

    await expect(page).toHaveURL(
      /\/m\/task\/_\?sessionId=session-new&stream_id=stream-ui-1$/,
      { timeout: 20_000 },
    );
    expect(JSON.stringify(state.promptBodies[0])).toContain(
      "Check the release notes from my phone",
    );
    expect(JSON.stringify(state.promptBodies[0])).toContain(
      "openai-subscription/gpt-5.5",
    );
    await expectNoAppCrash(page);
  });
});
