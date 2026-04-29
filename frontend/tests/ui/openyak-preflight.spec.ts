import { expect, test, type Page } from "@playwright/test";
import { mockOpenYakApi, seedOpenYakStorage, type OpenYakMockState } from "./fixtures/openyak-api";

let mockState: OpenYakMockState;

test.beforeEach(async ({ page }) => {
  await seedOpenYakStorage(page);
  mockState = await mockOpenYakApi(page);
});

async function openNewChat(page: Page, workspace = false) {
  const path = workspace
    ? `/c/new?directory=${encodeURIComponent("/Users/alex/openyak-demo")}`
    : "/c/new";
  await page.goto(path);
  await expect(page.getByRole("heading", { name: /What should (OpenYak help you do|we do in)/i })).toBeVisible();
  await expect(page.getByRole("button", { name: /Best Free/i })).toBeVisible({ timeout: 15_000 });
}

async function sendPrompt(page: Page, text: string) {
  await page.getByPlaceholder(/Describe the result you want/i).fill(text);
  const promptResponse = page.waitForResponse((res) =>
    res.url().includes("/api/chat/prompt") && res.status() === 200,
  );
  await page.getByRole("button", { name: /Send message/i }).click();
  await promptResponse;
}

test.describe("OpenYak UI preflight", () => {
  test("desktop chat path: landing, mode switch, attachments, mentions, send, workspace panel", async ({ page }) => {
    await openNewChat(page, true);

    await page.getByRole("button", { name: /Auto-edit/i }).click();
    await page.getByRole("button", { name: /Plan first/i }).click();
    await expect(page.getByRole("button", { name: /Plan first/i })).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles({
      name: "sample-preflight.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("workflow,status\nchat,covered\nsettings,covered\n"),
    });
    await expect(page.getByText("sample-preflight.csv")).toBeVisible();

    const input = page.getByPlaceholder(/Describe the result you want/i);
    await input.fill("@rel");
    await expect(page.getByRole("button", { name: /release-notes\.md docs\/release/i })).toBeVisible();
    await page.getByRole("button", { name: /release-notes\.md docs\/release/i }).click();
    await expect(page.getByText("release-notes.md").first()).toBeVisible();

    await sendPrompt(page, "Create a UI preflight checklist");

    await expect(page.getByText("Create a UI preflight checklist").first()).toBeVisible();
    await expect(page.getByText("sample-preflight.csv").first()).toBeVisible();

    const showWorkspace = page.getByRole("button", { name: /Show workspace/i });
    if (await showWorkspace.isVisible().catch(() => false)) {
      await showWorkspace.click();
    }
    const filesCard = page.getByRole("button", { name: /Files \d+ generated files/i });
    await expect(filesCard).toBeVisible();
    if (!(await page.getByText("plan.md").isVisible().catch(() => false))) {
      await filesCard.click();
    }
    await expect(page.getByText("plan.md")).toBeVisible();
  });

  test("desktop chat path: IME Enter confirms composition without sending", async ({ page }) => {
    await openNewChat(page);

    const input = page.getByPlaceholder(/Describe the result you want/i);
    await input.fill("你好");
    await input.focus();

    await input.dispatchEvent("compositionstart", { data: "你" });
    await input.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    });
    expect(mockState.promptBodies).toHaveLength(0);

    await input.dispatchEvent("compositionend", { data: "你好" });
    await input.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 13,
      which: 13,
      bubbles: true,
      cancelable: true,
    });
    expect(mockState.promptBodies).toHaveLength(0);

    await page.waitForTimeout(120);
    const promptResponse = page.waitForResponse((res) =>
      res.url().includes("/api/chat/prompt") && res.status() === 200,
    );
    await input.press("Enter");
    await promptResponse;
    expect(mockState.promptBodies).toHaveLength(1);
  });

  test("desktop history path: sidebar navigation and persisted conversation render", async ({ page }) => {
    await page.goto("/c/session-alpha");
    await expect(page.getByText("Quarterly planning notes").first()).toBeVisible();
    await expect(page.getByText("Summarize the quarterly plan")).toBeVisible();
    await expect(page.getByText(/retention, onboarding, and billing clarity/i)).toBeVisible();
    await expect(page.getByRole("button", { name: /Export/i })).toBeVisible();

    const invoiceOption = page.getByRole("option", { name: /Invoice cleanup/i });
    await expect(invoiceOption).toBeVisible();
    await invoiceOption.click();
    await expect(page).toHaveURL(/\/c\/session-beta$/, { timeout: 15_000 });
    await expect(page.getByText("Invoice cleanup").first()).toBeVisible();
  });

  test("desktop search path: command palette finds and opens a conversation", async ({ page }) => {
    await page.goto("/c/new");
    await page.keyboard.press("Control+K");
    await expect(page.getByPlaceholder("Search chats")).toBeVisible();
    await page.getByPlaceholder("Search chats").fill("quarter");
    await expect(page.getByText("quarterly plan and retention")).toBeVisible();
    await page.getByLabel("Results").getByText("Quarterly planning notes").click();
    await expect(page).toHaveURL(/\/c\/session-alpha$/);
  });

  test("desktop artifact path: artifact cards and plan review panel open from chat", async ({ page }) => {
    await page.goto("/c/session-artifacts");
    await expect(page.getByText("Artifact showcase").first()).toBeVisible();
    await expect(page.getByText("Release Brief")).toBeVisible();
    await expect(page.getByText("Demo Page")).toBeVisible();
    await expect(page.getByText("Coverage Matrix")).toBeVisible();
    await expect(page.getByText("Workflow Diagram")).toBeVisible();
    await expect(page.getByText("Logo Sketch")).toBeVisible();
    await expect(page.getByText("GUI Preflight Plan")).toBeVisible();

    await page.getByRole("button", { name: /Release Brief/i }).click();
    await expect(page.getByText("Markdown")).toBeVisible();
    await expect(page.getByText(/Validate desktop GUI workflows/i)).toBeVisible();

    await page.getByRole("button", { name: /Demo Page/i }).click();
    await expect(page.frameLocator("iframe").getByText("OpenYak GUI Preflight")).toBeVisible();

    await page.getByRole("button", { name: /Coverage Matrix/i }).click();
    await expect(page.getByText("CSV", { exact: true }).last()).toBeVisible();
    await expect(page.getByText("covered").first()).toBeVisible();

    await page.getByRole("button", { name: /GUI Preflight Plan/i }).click();
    await expect(page.getByText("Plan Review")).toBeVisible();
    await expect(page.getByText("frontend/tests/ui/openyak-preflight.spec.ts")).toBeVisible();
  });

  test("desktop interactive path: permission request is answered through the GUI", async ({ page }) => {
    await openNewChat(page);
    await page.getByRole("button", { name: /Auto-edit/i }).click();
    await page.getByRole("button", { name: /Ask first/i }).click();

    await sendPrompt(page, "Trigger permission flow for the preflight");
    await expect(page.getByText("Permission Required")).toBeVisible();
    await expect(page.getByText("Allow running this shell command?")).toBeVisible();
    await expect(page.getByText("Command", { exact: true })).toBeVisible();
    await expect(page.locator("pre", { hasText: "npm run preflight:ui" })).toBeVisible();
    await expect(page.getByText("/Users/alex/openyak-demo/frontend")).toBeVisible();

    const respond = page.waitForResponse((res) =>
      res.url().includes("/api/chat/respond") && res.status() === 200,
    );
    await page.getByRole("button", { name: /Allow/i }).click();
    await respond;
    await expect(page.getByText("Permission Required")).toBeHidden();
  });

  test("desktop interactive path: allow once does not persist a permission rule", async ({ page }) => {
    await openNewChat(page);
    await page.getByRole("button", { name: /Auto-edit/i }).click();
    await page.getByRole("button", { name: /Ask first/i }).click();

    await sendPrompt(page, "Trigger permission flow for allow once");
    await expect(page.getByText("Permission Required")).toBeVisible();

    const respond = page.waitForResponse((res) =>
      res.url().includes("/api/chat/respond") && res.status() === 200,
    );
    await page.getByRole("button", { name: /Allow/i }).click();
    await respond;

    expect(mockState.chatResponses.at(-1)).toMatchObject({
      response: {
        allowed: true,
        remember: false,
        permission: "bash",
        pattern: "npm run preflight:ui",
      },
    });

    await openNewChat(page);
    await sendPrompt(page, "Create a follow-up checklist");
    expect(mockState.promptBodies.at(-1)).toMatchObject({
      permission_rules: null,
    });
  });

  test("desktop interactive path: always allow persists permission rules to future prompts", async ({ page }) => {
    await openNewChat(page);
    await page.getByRole("button", { name: /Auto-edit/i }).click();
    await page.getByRole("button", { name: /Ask first/i }).click();

    await sendPrompt(page, "Trigger permission flow for always allow");
    await expect(page.getByText("Permission Required")).toBeVisible();
    await page.getByRole("switch", { name: /Remember this choice for bash/i }).setChecked(true);

    const respond = page.waitForResponse((res) =>
      res.url().includes("/api/chat/respond") && res.status() === 200,
    );
    await page.getByRole("button", { name: /Allow/i }).click();
    await respond;

    expect(mockState.chatResponses.at(-1)).toMatchObject({
      response: {
        allowed: true,
        remember: true,
        permission: "bash",
        pattern: "npm run preflight:ui",
      },
    });

    await openNewChat(page);
    await sendPrompt(page, "Create a follow-up checklist");
    expect(mockState.promptBodies.at(-1)).toMatchObject({
      permission_rules: [
        {
          action: "allow",
          permission: "bash",
          pattern: "*",
        },
      ],
    });
  });

  test("desktop interactive path: deny once does not persist a permission rule", async ({ page }) => {
    await openNewChat(page);
    await page.getByRole("button", { name: /Auto-edit/i }).click();
    await page.getByRole("button", { name: /Ask first/i }).click();

    await sendPrompt(page, "Trigger permission flow for deny once");
    await expect(page.getByText("Permission Required")).toBeVisible();

    const respond = page.waitForResponse((res) =>
      res.url().includes("/api/chat/respond") && res.status() === 200,
    );
    await page.getByRole("button", { name: /Deny/i }).click();
    await respond;

    expect(mockState.chatResponses.at(-1)).toMatchObject({
      response: {
        allowed: false,
        remember: false,
        permission: "bash",
        pattern: "npm run preflight:ui",
      },
    });

    await openNewChat(page);
    await sendPrompt(page, "Create a follow-up checklist");
    expect(mockState.promptBodies.at(-1)).toMatchObject({
      permission_rules: null,
    });
  });

  test("desktop interactive path: always deny persists permission rules to future prompts", async ({ page }) => {
    await openNewChat(page);
    await page.getByRole("button", { name: /Auto-edit/i }).click();
    await page.getByRole("button", { name: /Ask first/i }).click();

    await sendPrompt(page, "Trigger permission flow for always deny");
    await expect(page.getByText("Permission Required")).toBeVisible();
    await page.getByRole("switch", { name: /Remember this choice for bash/i }).setChecked(true);

    const respond = page.waitForResponse((res) =>
      res.url().includes("/api/chat/respond") && res.status() === 200,
    );
    await page.getByRole("button", { name: /Deny/i }).click();
    await respond;

    expect(mockState.chatResponses.at(-1)).toMatchObject({
      response: {
        allowed: false,
        remember: true,
        permission: "bash",
        pattern: "npm run preflight:ui",
      },
    });

    await openNewChat(page);
    await sendPrompt(page, "Create a follow-up checklist");
    expect(mockState.promptBodies.at(-1)).toMatchObject({
      permission_rules: [
        {
          action: "deny",
          permission: "bash",
          pattern: "*",
        },
      ],
    });
  });

  test("desktop interactive path: agent question is answered through the GUI", async ({ page }) => {
    await openNewChat(page);
    await sendPrompt(page, "Trigger question flow for release setup");

    await expect(page.getByText("Agent is asking")).toBeVisible();
    await expect(page.getByText("Which release channel should this automation watch?")).toBeVisible();

    const respond = page.waitForResponse((res) =>
      res.url().includes("/api/chat/respond") && res.status() === 200,
    );
    await page.getByRole("button", { name: /Stable/i }).click();
    await respond;
    await expect(page.getByText("Agent is asking")).toBeHidden();
  });

  test("desktop interactive path: plan review is accepted through the GUI", async ({ page }) => {
    await openNewChat(page);
    await sendPrompt(page, "Trigger plan review flow for the preflight");

    await expect(page.getByText("Accept this plan?")).toBeVisible();
    await expect(page.getByText("Preflight implementation plan")).toBeVisible();
    await expect(page.getByText("frontend/tests/ui/openyak-preflight.spec.ts")).toBeVisible();

    const respond = page.waitForResponse((res) =>
      res.url().includes("/api/chat/respond") && res.status() === 200,
    );
    await page.getByRole("button", { name: /manually approve edits/i }).click();
    await respond;
    await expect(page.getByText("Accept this plan?")).toBeHidden();
  });

  test("settings path: every settings tab has its primary controls", async ({ page }) => {
    await page.goto("/settings");

    await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Light" })).toBeVisible();
    await expect(page.getByRole("button", { name: "中文" })).toBeVisible();

    await page.getByRole("button", { name: "Providers" }).click();
    await expect(page.getByRole("heading", { name: "Providers" })).toBeVisible();
    await expect(page.getByText("OpenYak Account")).toBeVisible();
    await page.getByRole("button", { name: /Own API Key/i }).click();
    await expect(page.getByText("OpenRouter")).toBeVisible();

    await page.getByRole("button", { name: "Permissions" }).click();
    await expect(page.getByRole("heading", { name: "Permissions", exact: true })).toBeVisible();
    await expect(page.getByText("No remembered permissions")).toBeVisible();

    await page.getByRole("button", { name: "Automations" }).click();
    await expect(page.getByRole("heading", { name: "Automations" })).toBeVisible();
    await expect(page.getByText("Morning brief")).toBeVisible();

    await page.getByRole("button", { name: "Plugins" }).click();
    await expect(page.getByRole("heading", { name: "Plugins" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connectors" })).toBeVisible();
    await expect(page.getByText("GitHub")).toBeVisible();

    await page.getByRole("button", { name: "Remote" }).click();
    await expect(page.getByRole("heading", { name: "Remote" })).toBeVisible();
    await expect(page.getByText("Remote Access Disabled")).toBeVisible();

    await page.getByRole("button", { name: "Billing" }).click();
    await expect(page.getByRole("heading", { name: "Billing" })).toBeVisible();
    await expect(page.getByText("$12.50", { exact: true }).first()).toBeVisible();

    await page.getByRole("button", { name: "Usage" }).click();
    await expect(page.getByRole("heading", { name: "Usage", exact: true })).toBeVisible();
    await expect(page.getByText("Total Tokens")).toBeVisible();

    await page.getByRole("button", { name: "Memory" }).click();
    await expect(page.getByRole("heading", { name: "Memory" })).toBeVisible();
    await page.getByRole("button", { name: /alex\/openyak-demo/i }).click();
    await expect(page.getByText("Prefer concise release notes.")).toBeVisible();
    await page.getByTitle("Edit").click();
    await page.getByPlaceholder("Workspace memory (Markdown)...").fill("# Project Memory\nPrefer GUI preflight reports.");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByTitle("Export").click();
    await page.getByTitle("Delete").click();
    await expect(page.getByText("Delete workspace memory?")).toBeVisible();
    await page.getByRole("button", { name: "Yes, delete" }).click();
    await expect(page.getByText("Delete workspace memory?")).toBeHidden();
  });

  test("settings permissions path: remembered choices can be reviewed and cleared", async ({ page }) => {
    await seedOpenYakStorage(page, {
      force: true,
      savedPermissions: [
        { tool: "bash", allow: true, timestamp: Date.parse("2026-04-26T12:00:00.000Z") },
        { tool: "write", allow: false, timestamp: Date.parse("2026-04-26T12:05:00.000Z") },
      ],
    });

    await page.goto("/settings?tab=permissions");
    await expect(page.getByRole("heading", { name: "Permissions", exact: true })).toBeVisible();
    await expect(page.getByText("Shell", { exact: true })).toBeVisible();
    await expect(page.getByText("All bash requests")).toBeVisible();
    await expect(page.getByText("Write", { exact: true })).toBeVisible();
    await expect(page.getByText("All write requests")).toBeVisible();

    await page.getByRole("button", { name: "Revoke bash permission" }).click();
    await expect(page.getByText("Shell", { exact: true })).toBeHidden();
    await expect(page.getByText("Write", { exact: true })).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Clear all" }).click();
    await expect(page.getByText("No remembered permissions")).toBeVisible();
  });

  test("settings providers path: all provider modes can be configured from GUI controls", async ({ page }) => {
    await page.goto("/settings?tab=providers");
    await expect(page.getByRole("heading", { name: "Providers" })).toBeVisible();

    await page.getByRole("button", { name: /Own API Key/i }).click();
    await page.getByPlaceholder("sk-or-...").fill("sk-or-preflight");
    await page.getByRole("button", { name: "Save" }).first().click();
    await expect(page.getByText("sk-or-...mock")).toBeVisible();

    await page.getByRole("button", { name: /ChatGPT Subscription/i }).click();
    await expect(page.getByText("chatgpt@openyak.test")).toBeVisible();
    await expect(page.getByRole("button", { name: /Disconnect/i })).toBeVisible();

    await page.getByRole("button", { name: /Local API/i }).click();
    await expect(page.getByText("http://localhost:11434/v1", { exact: true })).toBeVisible();
    await page.getByPlaceholder("http://localhost:11434/v1").fill("http://localhost:1234/v1");
    await page.getByRole("button", { name: "Save" }).click();

    await page.getByRole("button", { name: /Custom Endpoint/i }).click();
    await expect(page.getByText("Acme Local Proxy")).toBeVisible();
    await page.getByPlaceholder("Endpoint Name (e.g. My Local Model)").fill("Preflight Endpoint");
    await page.getByPlaceholder("https://api.example.com/v1").fill("http://localhost:9888/v1");
    await page.getByPlaceholder("API Key (Leave blank if not required)").fill("sk-custom-preflight");
    await page.getByRole("button", { name: "Add Endpoint" }).click();
  });

  test("automations path: create dialog, required fields, templates", async ({ page }) => {
    await page.goto("/settings?tab=automations");
    await page.getByRole("button", { name: "New Automation" }).click();

    await expect(page.getByRole("heading", { name: "New Automation" })).toBeVisible();
    await page.getByPlaceholder(/Weekly Briefing/i).fill("Release note watcher");
    await page.getByPlaceholder(/Brief description/i).fill("Watch for changed docs");
    await page.getByPlaceholder(/Describe what this automation should do/i).fill("Summarize product docs every morning");
    await page.getByRole("button", { name: "Create" }).click();

    await expect(page.getByRole("heading", { name: "New Automation" })).toBeHidden();
    await page.getByRole("button", { name: "Templates" }).click();
    await expect(page.getByText("Daily Brief")).toBeVisible();
    await page.getByText("Daily Brief").click();
    await expect(page.getByRole("button", { name: "Active" })).toBeVisible();
  });

  test("automations path: run now, history, edit, and delete confirmation", async ({ page }) => {
    await page.goto("/settings?tab=automations");
    await expect(page.getByText("Morning brief")).toBeVisible();

    await page.getByRole("button", { name: "Run Now" }).click();
    await page.getByRole("button", { name: "History" }).click();
    await expect(page.getByText("Scheduled")).toBeVisible();
    await expect(page.getByText("Manual")).toBeVisible();

    await page.getByText("Morning brief").click();
    await expect(page.getByRole("heading", { name: "Edit Automation" })).toBeVisible();
    await page.locator('input[type="text"]').first().fill("Morning brief updated");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByRole("heading", { name: "Edit Automation" })).toBeHidden();

    const card = page.locator("div.rounded-lg").filter({ hasText: "Morning brief" }).filter({ hasText: "Summarize overnight" }).first();
    await card.locator("button").nth(3).click();
    await expect(page.getByText("Delete this automation?")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Delete this automation?")).toBeHidden();
  });

  test("plugins path: connector, plugin, skill tabs and add custom connector", async ({ page }) => {
    await page.goto("/settings?tab=plugins");
    await expect(page.getByText("GitHub")).toBeVisible();

    await page.getByPlaceholder("Search...").fill("github");
    await expect(page.getByText("Developer Tools")).toBeVisible();

    await page.getByRole("button", { name: "Add custom" }).click();
    await page.getByPlaceholder("Name").fill("Local MCP");
    await page.getByPlaceholder("https://mcp.example.com/mcp").fill("http://localhost:9988/mcp");
    await page.getByRole("button", { name: /^Add$/ }).click();

    await page.locator("#main-content").getByRole("button", { name: "Plugins" }).click();
    await expect(page.getByText("GitHub workflows")).toBeVisible();

    await page.locator("#main-content").getByRole("button", { name: "Skills" }).click();
    await expect(page.getByText("browser", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Browse skills/i }).click();
    await page.getByPlaceholder(/Search 900k\+ skills/i).fill("browser");
    await expect(page.getByText("Browser automation skill")).toBeVisible();
  });

  test("remote access path: enable tunnel and expose mobile handoff controls", async ({ page }) => {
    await page.goto("/settings?tab=remote");
    await expect(page.getByText("Remote Access Disabled")).toBeVisible();

    await page.getByRole("switch").click();
    await expect(page.getByText("Remote Access Active")).toBeVisible();
    await expect(page.getByText("https://remote.openyak.test", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: /Copy/i }).click();
    await page.getByRole("button", { name: /Rotate Token/i }).click();
  });
});

test.describe("OpenYak mobile remote preflight", () => {
  test.use({ viewport: { width: 393, height: 852 }, isMobile: true });

  test("mobile settings path: connection and provider selection", async ({ page }) => {
    await page.goto("/m/settings?token=remote-token");
    await expect(page.getByRole("heading", { name: "Connection" })).toBeVisible();
    await expect(page.getByText("Connected")).toBeVisible();
    await expect(page.getByText("Model Access")).toBeVisible();
    await expect(page.getByText("OpenRouter")).toBeVisible();
    await page.getByText("ChatGPT Subscription").click();
    await expect(page.getByRole("button", { name: /ChatGPT Subscription 1 model available/i })).toBeVisible();
  });

  test("mobile task path: task list, new task, submit", async ({ page }) => {
    await page.goto("/m?token=remote-token");
    await expect(page.getByRole("heading", { name: "OpenYak" })).toBeVisible();
    await expect(page.getByText("Quarterly planning notes")).toBeVisible();

    await page.getByRole("button", { name: "New task" }).click({ force: true });
    await expect(page.getByRole("heading", { name: "New Task" })).toBeVisible();
    await expect(page.locator("select")).toContainText("Claude Sonnet 4.5");

    await page.getByPlaceholder("What should OpenYak do?").fill("Check the release notes from my phone");
    const promptResponse = page.waitForResponse((res) =>
      res.url().includes("/api/chat/prompt") && res.status() === 200,
    );
    await page.getByPlaceholder("What should OpenYak do?").press("Enter");
    await promptResponse;
  });
});
