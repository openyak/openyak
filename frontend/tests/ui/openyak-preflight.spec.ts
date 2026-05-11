import { expect, test, type Page } from "@playwright/test";
import {
  mockOpenYakApi,
  seedOpenYakStorage,
  type OpenYakMockState,
} from "./fixtures/openyak-api";

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
  await expect(
    page
      .getByRole("heading", {
        name: /What should (OpenYak help you do|we do in)/i,
      })
      .first(),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Claude Sonnet 4\.5/i }),
  ).toBeVisible({ timeout: 15_000 });
}

async function sendPrompt(page: Page, text: string) {
  await page.getByPlaceholder(/Describe the result you want/i).fill(text);
  const promptResponse = page.waitForResponse(
    (res) => res.url().includes("/api/chat/prompt") && res.status() === 200,
  );
  await page
    .locator('button[aria-label="Send message"]:not([disabled])')
    .click();
  await promptResponse;
}

async function dispatchBrowserFileDrop(
  page: Page,
  filename: string,
  content: string,
  mimeType: string,
) {
  await page.getByPlaceholder(/Describe the result you want/i).evaluate(
    (textarea, payload) => {
      const target = textarea.closest("div.relative.rounded-3xl");
      if (!target) throw new Error("Composer drop target not found");
      const file = new File([payload.content], payload.filename, {
        type: payload.mimeType,
      });
      const dataTransfer = {
        files: [file],
        items: [],
      };
      for (const eventName of ["dragover", "drop"]) {
        const event = new Event(eventName, { bubbles: true, cancelable: true });
        Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
        target.dispatchEvent(event);
      }
    },
    { filename, content, mimeType },
  );
}

async function dispatchTextPaste(page: Page, text: string) {
  await page
    .getByPlaceholder(/Describe the result you want/i)
    .evaluate((textarea, pastedText) => {
      const clipboardData = {
        files: [],
        items: [],
        getData: (format: string) =>
          format === "text/plain" ? pastedText : "",
      };
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", { value: clipboardData });
      textarea.dispatchEvent(event);
    }, text);
}

async function installTauriDragDropMock(page: Page) {
  await page.addInitScript(() => {
    type ListenerEvent = { id: number; event: string; payload: unknown };
    type ListenerCallback = (event: ListenerEvent) => void;
    type TauriTestWindow = Window & {
      __TAURI_INTERNALS__: {
        metadata: {
          currentWindow: { label: string };
          currentWebview: { label: string };
        };
        invoke: (
          cmd: string,
          args?: Record<string, unknown>,
        ) => Promise<unknown>;
        transformCallback: (callback: ListenerCallback) => number;
        unregisterCallback: (id: number) => void;
        convertFileSrc: (filePath: string) => string;
      };
      __TAURI_EVENT_PLUGIN_INTERNALS__: {
        unregisterListener: (event: string, eventId: number) => void;
      };
      __OPENYAK_TEST_EMIT_TAURI_EVENT__: (
        event: string,
        payload: unknown,
      ) => void;
      __OPENYAK_TEST_TAURI_LISTENER_COUNT__: (event: string) => number;
    };

    const w = window as unknown as TauriTestWindow;
    let nextCallbackId = 1;
    let nextListenerId = 1;
    const callbacks = new Map<number, ListenerCallback>();
    const listeners = new Map<string, number[]>();
    const listenerEntries = new Map<
      number,
      { event: string; handler: number }
    >();

    w.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "main" },
        currentWebview: { label: "main" },
      },
      invoke: async (cmd, args = {}) => {
        if (cmd === "get_backend_url") return "http://localhost:8000";
        if (cmd === "get_backend_token") return "test-session-token";
        if (cmd === "get_pending_navigation") return null;
        if (cmd === "get_platform") return "darwin";
        if (cmd === "is_maximized") return false;
        if (cmd === "plugin:event|listen") {
          const event = String(args.event);
          const handler = Number(args.handler);
          const listenerId = nextListenerId++;
          listeners.set(event, [...(listeners.get(event) ?? []), handler]);
          listenerEntries.set(listenerId, { event, handler });
          return listenerId;
        }
        if (cmd === "plugin:event|unlisten") {
          const eventId = Number(args.eventId);
          const entry = listenerEntries.get(eventId);
          if (entry) {
            listeners.set(
              entry.event,
              (listeners.get(entry.event) ?? []).filter(
                (handler) => handler !== entry.handler,
              ),
            );
            listenerEntries.delete(eventId);
          }
          return null;
        }
        return null;
      },
      transformCallback: (callback) => {
        const id = nextCallbackId++;
        callbacks.set(id, callback);
        return id;
      },
      unregisterCallback: (id) => {
        callbacks.delete(id);
      },
      convertFileSrc: (filePath) => filePath,
    };
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = {
      unregisterListener: (event, eventId) => {
        const entry = listenerEntries.get(eventId);
        if (!entry || entry.event !== event) return;
        listeners.set(
          event,
          (listeners.get(event) ?? []).filter(
            (handler) => handler !== entry.handler,
          ),
        );
        listenerEntries.delete(eventId);
      },
    };
    w.__OPENYAK_TEST_EMIT_TAURI_EVENT__ = (event, payload) => {
      for (const handler of listeners.get(event) ?? []) {
        callbacks.get(handler)?.({ id: 1, event, payload });
      }
    };
    w.__OPENYAK_TEST_TAURI_LISTENER_COUNT__ = (event) =>
      listeners.get(event)?.length ?? 0;
  });
}

test.describe("OpenYak UI preflight", () => {
  test("desktop chat path: landing, mode switch, attachments, mentions, send, workspace panel", async ({
    page,
  }) => {
    await openNewChat(page, true);

    await page.getByRole("button", { name: /Auto-edit/i }).click();
    await page.getByRole("button", { name: /Plan first/i }).click();
    await expect(
      page.getByRole("button", { name: /Plan first/i }),
    ).toBeVisible();

    await page.locator('input[type="file"]').setInputFiles({
      name: "sample-preflight.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("workflow,status\nchat,covered\nsettings,covered\n"),
    });
    await expect(page.getByText("sample-preflight.csv")).toBeVisible();

    const input = page.getByPlaceholder(/Describe the result you want/i);
    await input.fill("@rel");
    await expect(
      page.getByRole("button", { name: /release-notes\.md docs\/release/i }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: /release-notes\.md docs\/release/i })
      .click();
    await expect(page.getByText("release-notes.md").first()).toBeVisible();

    await sendPrompt(page, "Create a UI preflight checklist");

    await expect(
      page.getByText("Create a UI preflight checklist").first(),
    ).toBeVisible();
    await expect(page.getByText("sample-preflight.csv").first()).toBeVisible();

    const showWorkspace = page.getByRole("button", { name: /Show workspace/i });
    if (await showWorkspace.isVisible().catch(() => false)) {
      await showWorkspace.click();
    }
    const filesCard = page.getByRole("button", {
      name: /Files \d+ generated files/i,
    });
    await expect(filesCard).toBeVisible();
    if (
      !(await page
        .getByText("plan.md")
        .isVisible()
        .catch(() => false))
    ) {
      await filesCard.click();
    }
    await expect(page.getByText("plan.md")).toBeVisible();
  });

  test("desktop chat path: IME Enter confirms composition without sending", async ({
    page,
  }) => {
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
    const promptResponse = page.waitForResponse(
      (res) => res.url().includes("/api/chat/prompt") && res.status() === 200,
    );
    await input.press("Enter");
    await promptResponse;
    expect(mockState.promptBodies).toHaveLength(1);
  });

  test("desktop chat path: drag-dropping a browser file attaches and sends it", async ({
    page,
  }) => {
    await openNewChat(page);

    await dispatchBrowserFileDrop(
      page,
      "dragged-note.md",
      "# Dragged note\n",
      "text/markdown",
    );
    await expect(page.getByText("dragged-note.md")).toBeVisible();
    expect(mockState.fileUploads).toEqual(["dragged-note.md"]);

    await sendPrompt(page, "Summarize the dropped note");
    expect(JSON.stringify(mockState.promptBodies.at(-1))).toContain(
      "dragged-note.md",
    );
  });

  test("desktop chat path: pasted local file path attaches by path", async ({
    page,
  }) => {
    await openNewChat(page);
    const filePath = "/Users/alex/Desktop/Receipt-2768-7987-6551.pdf";

    await dispatchTextPaste(page, filePath);

    await expect(page.getByText("Receipt-2768-7987-6551.pdf")).toBeVisible();
    await expect(
      page.getByPlaceholder(/Describe the result you want/i),
    ).toHaveValue("");
    expect(mockState.attachedPaths).toEqual([filePath]);
    expect(mockState.fileUploads).toEqual([]);

    await sendPrompt(page, "Extract decisions, risks, and next actions");
    expect(JSON.stringify(mockState.promptBodies.at(-1))).toContain(filePath);
  });

  test("desktop chat path: Tauri native path drop attaches files and folders by local path", async ({
    page,
  }) => {
    await installTauriDragDropMock(page);
    await seedOpenYakStorage(page, { force: true });
    await openNewChat(page);
    await expect
      .poll(() =>
        page.evaluate(() => {
          const w = window as unknown as Window & {
            __OPENYAK_TEST_TAURI_LISTENER_COUNT__?: (event: string) => number;
          };
          return (
            w.__OPENYAK_TEST_TAURI_LISTENER_COUNT__?.("tauri://drag-drop") ?? 0
          );
        }),
      )
      .toBeGreaterThan(0);

    const box = await page
      .getByPlaceholder(/Describe the result you want/i)
      .boundingBox();
    expect(box).not.toBeNull();
    const position = {
      x: box!.x + box!.width / 2,
      y: box!.y + box!.height / 2,
    };
    const paths = [
      "/Users/alex/Desktop/dragged-image.png",
      "/Users/alex/Desktop/drag-folder",
    ];

    await page.evaluate(
      ({ position, paths }) => {
        const w = window as unknown as Window & {
          __OPENYAK_TEST_EMIT_TAURI_EVENT__: (
            event: string,
            payload: unknown,
          ) => void;
        };
        w.__OPENYAK_TEST_EMIT_TAURI_EVENT__("tauri://drag-enter", {
          paths,
          position,
        });
        w.__OPENYAK_TEST_EMIT_TAURI_EVENT__("tauri://drag-drop", {
          paths,
          position,
        });
      },
      { position, paths },
    );

    await expect(page.getByText("dragged-image.png")).toBeVisible();
    await expect(page.getByText("drag-folder")).toBeVisible();
    expect(mockState.attachedPaths).toEqual(paths);
    expect(mockState.fileUploads).toEqual([]);

    await sendPrompt(page, "Summarize the dropped local paths");
    const prompt = JSON.stringify(mockState.promptBodies.at(-1));
    expect(prompt).toContain("/Users/alex/Desktop/dragged-image.png");
    expect(prompt).toContain("/Users/alex/Desktop/drag-folder");
    expect(prompt).toContain("inode/directory");
  });

  test("desktop history path: sidebar navigation and persisted conversation render", async ({
    page,
  }) => {
    await page.goto("/c/session-alpha");
    await expect(
      page.getByText("Quarterly planning notes").first(),
    ).toBeVisible();
    await expect(page.getByText("Summarize the quarterly plan")).toBeVisible();
    await expect(
      page.getByText(/retention, onboarding, and pricing clarity/i),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: /Export/i })).toBeVisible();

    const invoiceOption = page.getByRole("option", {
      name: /Invoice cleanup/i,
    });
    await expect(invoiceOption).toBeVisible();
    await invoiceOption.click();
    await expect(page).toHaveURL(/\/c\/session-beta$/, { timeout: 15_000 });
    await expect(page.getByText("Invoice cleanup").first()).toBeVisible();
  });

  test("desktop search path: command palette finds and opens a conversation", async ({
    page,
  }) => {
    await page.goto("/c/new");
    await page.keyboard.press("Control+K");
    await expect(page.getByPlaceholder("Search chats")).toBeVisible();
    await page.getByPlaceholder("Search chats").fill("quarter");
    await expect(page.getByText("quarterly plan and retention")).toBeVisible();
    await page
      .getByLabel("Results")
      .getByText("Quarterly planning notes")
      .click();
    await expect(page).toHaveURL(/\/c\/session-alpha$/);
  });

  test("desktop artifact path: artifact cards and plan review panel open from chat", async ({
    page,
  }) => {
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
    await expect(
      page.getByText(/Validate desktop GUI workflows/i),
    ).toBeVisible();

    await page.getByRole("button", { name: /Demo Page/i }).click();
    await expect(
      page.frameLocator("iframe").getByText("OpenYak GUI Preflight"),
    ).toBeVisible();

    await page.getByRole("button", { name: /Coverage Matrix/i }).click();
    await expect(page.getByText("CSV", { exact: true }).last()).toBeVisible();
    await expect(page.getByText("covered").first()).toBeVisible();

    await page.getByRole("button", { name: /GUI Preflight Plan/i }).click();
    await expect(page.getByText("Plan Review")).toBeVisible();
    await expect(
      page.getByText("frontend/tests/ui/openyak-preflight.spec.ts"),
    ).toBeVisible();
  });

  test("desktop interactive path: permission request is answered through the GUI", async ({
    page,
  }) => {
    await openNewChat(page);
    await page.getByRole("button", { name: /Auto-edit/i }).click();
    await page.getByRole("button", { name: /Ask first/i }).click();

    await sendPrompt(page, "Trigger permission flow for the preflight");
    await expect(page.getByText("Permission Required")).toBeVisible();
    await expect(
      page.getByText("Allow running this shell command?"),
    ).toBeVisible();
    await expect(page.getByText("Command", { exact: true })).toBeVisible();
    await expect(
      page.locator("pre", { hasText: "npm run preflight:ui" }),
    ).toBeVisible();
    await expect(
      page.getByText("/Users/alex/openyak-demo/frontend"),
    ).toBeVisible();

    const respond = page.waitForResponse(
      (res) => res.url().includes("/api/chat/respond") && res.status() === 200,
    );
    await page.getByRole("button", { name: /Allow/i }).click();
    await respond;
    await expect(page.getByText("Permission Required")).toBeHidden();
  });

  test("desktop interactive path: allow once does not persist a permission rule", async ({
    page,
  }) => {
    await openNewChat(page);
    await page.getByRole("button", { name: /Auto-edit/i }).click();
    await page.getByRole("button", { name: /Ask first/i }).click();

    await sendPrompt(page, "Trigger permission flow for allow once");
    await expect(page.getByText("Permission Required")).toBeVisible();

    const respond = page.waitForResponse(
      (res) => res.url().includes("/api/chat/respond") && res.status() === 200,
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

  test("desktop interactive path: always allow persists permission rules to future prompts", async ({
    page,
  }) => {
    await openNewChat(page);
    await page.getByRole("button", { name: /Auto-edit/i }).click();
    await page.getByRole("button", { name: /Ask first/i }).click();

    await sendPrompt(page, "Trigger permission flow for always allow");
    await expect(page.getByText("Permission Required")).toBeVisible();
    await page
      .getByRole("switch", { name: /Remember this choice for bash/i })
      .setChecked(true);

    const respond = page.waitForResponse(
      (res) => res.url().includes("/api/chat/respond") && res.status() === 200,
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

  test("desktop interactive path: deny once does not persist a permission rule", async ({
    page,
  }) => {
    await openNewChat(page);
    await page.getByRole("button", { name: /Auto-edit/i }).click();
    await page.getByRole("button", { name: /Ask first/i }).click();

    await sendPrompt(page, "Trigger permission flow for deny once");
    await expect(page.getByText("Permission Required")).toBeVisible();

    const respond = page.waitForResponse(
      (res) => res.url().includes("/api/chat/respond") && res.status() === 200,
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

  test("desktop interactive path: always deny persists permission rules to future prompts", async ({
    page,
  }) => {
    await openNewChat(page);
    await page.getByRole("button", { name: /Auto-edit/i }).click();
    await page.getByRole("button", { name: /Ask first/i }).click();

    await sendPrompt(page, "Trigger permission flow for always deny");
    await expect(page.getByText("Permission Required")).toBeVisible();
    await page
      .getByRole("switch", { name: /Remember this choice for bash/i })
      .setChecked(true);

    const respond = page.waitForResponse(
      (res) => res.url().includes("/api/chat/respond") && res.status() === 200,
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

  test("desktop interactive path: agent question is answered through the GUI", async ({
    page,
  }) => {
    await openNewChat(page);
    await sendPrompt(page, "Trigger question flow for release setup");

    await expect(page.getByText("Agent is asking")).toBeVisible();
    await expect(
      page.getByText("Which release channel should this automation watch?"),
    ).toBeVisible();

    const respond = page.waitForResponse(
      (res) => res.url().includes("/api/chat/respond") && res.status() === 200,
    );
    await page.getByRole("button", { name: /Stable/i }).click();
    await respond;
    await expect(page.getByText("Agent is asking")).toBeHidden();
  });

  test("desktop interactive path: plan review is accepted through the GUI", async ({
    page,
  }) => {
    await openNewChat(page);
    await sendPrompt(page, "Trigger plan review flow for the preflight");

    await expect(page.getByText("Accept this plan?")).toBeVisible();
    await expect(page.getByText("Preflight implementation plan")).toBeVisible();
    await expect(
      page.getByText("frontend/tests/ui/openyak-preflight.spec.ts"),
    ).toBeVisible();

    const respond = page.waitForResponse(
      (res) => res.url().includes("/api/chat/respond") && res.status() === 200,
    );
    await page.getByRole("button", { name: /manually approve edits/i }).click();
    await respond;
    await expect(page.getByText("Accept this plan?")).toBeHidden();
  });

  test("settings path: every settings tab has its primary controls", async ({
    page,
  }) => {
    await page.goto("/settings");

    await expect(page.getByRole("heading", { name: "General" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Light" })).toBeVisible();
    await expect(page.getByRole("button", { name: "中文" })).toBeVisible();

    await page.getByRole("button", { name: "Providers" }).click();
    await expect(
      page.getByRole("heading", { name: "Providers" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Own API Key/i }),
    ).toBeVisible();
    await expect(page.getByText("OpenRouter")).toBeVisible();

    await page.getByRole("button", { name: "Permissions" }).click();
    await expect(
      page.getByRole("heading", { name: "Permissions", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("No remembered permissions")).toBeVisible();

    await page.getByRole("button", { name: "Automations" }).click();
    await expect(
      page.getByRole("heading", { name: "Automations" }),
    ).toBeVisible();
    await expect(page.getByText("Morning brief")).toBeVisible();

    await page.getByRole("button", { name: "Plugins" }).click();
    await expect(page.getByRole("heading", { name: "Plugins" })).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Connectors" }),
    ).toBeVisible();
    await expect(page.getByText("GitHub")).toBeVisible();

    await page.getByRole("button", { name: "Remote" }).click();
    await expect(page.getByRole("heading", { name: "Remote" })).toBeVisible();
    await expect(page.getByText("Remote Access Disabled")).toBeVisible();

    await page.getByRole("button", { name: "Usage" }).click();
    await expect(
      page.getByRole("heading", { name: "Usage", exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Total Tokens")).toBeVisible();

    await page.getByRole("button", { name: "Memory" }).click();
    await expect(page.getByRole("heading", { name: "Memory" })).toBeVisible();
    await page.getByRole("button", { name: /alex\/openyak-demo/i }).click();
    await expect(page.getByText("Prefer concise release notes.")).toBeVisible();
    await page.getByTitle("Edit").click();
    await page
      .getByPlaceholder("Workspace memory (Markdown)...")
      .fill("# Project Memory\nPrefer GUI preflight reports.");
    await page.getByRole("button", { name: "Save" }).click();
    await page.getByTitle("Export").click();
    await page.getByTitle("Delete").click();
    await expect(page.getByText("Delete workspace memory?")).toBeVisible();
    await page.getByRole("button", { name: "Yes, delete" }).click();
    await expect(page.getByText("Delete workspace memory?")).toBeHidden();
  });

  test("settings permissions path: remembered choices can be reviewed and cleared", async ({
    page,
  }) => {
    await seedOpenYakStorage(page, {
      force: true,
      savedPermissions: [
        {
          tool: "bash",
          allow: true,
          timestamp: Date.parse("2026-04-26T12:00:00.000Z"),
        },
        {
          tool: "write",
          allow: false,
          timestamp: Date.parse("2026-04-26T12:05:00.000Z"),
        },
      ],
    });

    await page.goto("/settings?tab=permissions");
    await expect(
      page.getByRole("heading", { name: "Permissions", exact: true }),
    ).toBeVisible();
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

  test("settings providers path: all provider modes can be configured from GUI controls", async ({
    page,
  }) => {
    await page.goto("/settings?tab=providers");
    await expect(
      page.getByRole("heading", { name: "Providers" }),
    ).toBeVisible();

    await page.getByRole("button", { name: /Own API Key/i }).click();
    await page.getByPlaceholder("sk-or-...").fill("sk-or-preflight");
    await page.getByRole("button", { name: "Save" }).first().click();
    await expect(page.getByText("sk-or-...mock")).toBeVisible();

    await page.getByRole("button", { name: /ChatGPT Subscription/i }).click();
    await expect(page.getByText("chatgpt@openyak.test")).toBeVisible();
    await expect(
      page.getByRole("button", { name: /Disconnect/i }),
    ).toBeVisible();

    await page.getByRole("button", { name: /Rapid-MLX/i }).click();
    await expect(
      page.getByText("brew install raullenchai/rapid-mlx/rapid-mlx"),
    ).toBeVisible();

    await page.getByRole("button", { name: /Custom Endpoint/i }).click();
    await expect(page.getByRole("button", { name: /Local API/i })).toBeHidden();
    await expect(page.getByText("Local endpoint")).toBeVisible();
    await expect(
      page.getByText("http://localhost:11434/v1", { exact: true }),
    ).toBeVisible();
    await expect(page.getByText("Acme Local Proxy")).toBeVisible();
    await page
      .getByPlaceholder("Endpoint Name (e.g. My Local Model)")
      .fill("Preflight Endpoint");
    await page
      .getByPlaceholder(
        "http://localhost:1234/v1 or https://api.example.com/v1",
      )
      .fill("http://localhost:1234/v1");
    await page
      .getByPlaceholder("API Key (Leave blank if not required)")
      .fill("sk-custom-preflight");
    await page.getByRole("button", { name: "Add Endpoint" }).click();
  });

  test("automations path: create dialog, required fields, templates", async ({
    page,
  }) => {
    await page.goto("/settings?tab=automations");
    await page.getByRole("button", { name: "New Automation" }).click();

    await expect(
      page.getByRole("heading", { name: "New Automation" }),
    ).toBeVisible();
    await page
      .getByPlaceholder(/Weekly Briefing/i)
      .fill("Release note watcher");
    await page
      .getByPlaceholder(/Brief description/i)
      .fill("Watch for changed docs");
    await page
      .getByPlaceholder(/Describe what this automation should do/i)
      .fill("Summarize product docs every morning");
    await page.getByRole("button", { name: "Create" }).click();

    await expect(
      page.getByRole("heading", { name: "New Automation" }),
    ).toBeHidden();
    await page.getByRole("button", { name: "Templates" }).click();
    await expect(page.getByText("Daily Brief")).toBeVisible();
    await page.getByText("Daily Brief").click();
    await expect(page.getByRole("button", { name: "Active" })).toBeVisible();
  });

  test("automations path: run now, history, edit, and delete confirmation", async ({
    page,
  }) => {
    await page.goto("/settings?tab=automations");
    await expect(page.getByText("Morning brief")).toBeVisible();

    await page.getByRole("button", { name: "Run Now" }).click();
    await page.getByRole("button", { name: "History" }).click();
    await expect(page.getByText("Scheduled")).toBeVisible();
    await expect(page.getByText("Manual")).toBeVisible();

    await page.getByText("Morning brief").click();
    await expect(
      page.getByRole("heading", { name: "Edit Automation" }),
    ).toBeVisible();
    await page
      .locator('input[type="text"]')
      .first()
      .fill("Morning brief updated");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(
      page.getByRole("heading", { name: "Edit Automation" }),
    ).toBeHidden();

    const card = page
      .locator("div.rounded-lg")
      .filter({ hasText: "Morning brief" })
      .filter({ hasText: "Summarize overnight" })
      .first();
    await card.locator("button").nth(3).click();
    await expect(page.getByText("Delete this automation?")).toBeVisible();
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByText("Delete this automation?")).toBeHidden();
  });

  test("plugins path: connector, plugin, skill tabs and add custom connector", async ({
    page,
  }) => {
    await page.goto("/settings?tab=plugins");
    await expect(page.getByText("GitHub")).toBeVisible();

    await page.getByPlaceholder("Search...").fill("github");
    await expect(page.getByText("Developer Tools")).toBeVisible();

    await page.getByRole("button", { name: "Add custom" }).click();
    await page.getByPlaceholder("Name").fill("Local MCP");
    await page
      .getByPlaceholder("https://mcp.example.com/mcp")
      .fill("http://localhost:9988/mcp");
    await page.getByRole("button", { name: /^Add$/ }).click();

    await page
      .locator("#main-content")
      .getByRole("button", { name: "Plugins" })
      .click();
    await expect(page.getByText("GitHub workflows")).toBeVisible();

    await page
      .locator("#main-content")
      .getByRole("button", { name: "Skills" })
      .click();
    await expect(page.getByText("browser", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /Browse skills/i }).click();
    await page.getByPlaceholder(/Search 900k\+ skills/i).fill("browser");
    await expect(page.getByText("Browser automation skill")).toBeVisible();
  });

  test("remote access path: enable tunnel and expose mobile handoff controls", async ({
    page,
  }) => {
    await page.goto("/settings?tab=remote");
    await expect(page.getByText("Remote Access Disabled")).toBeVisible();

    await page.getByRole("switch").click();
    await expect(page.getByText("Remote Access Active")).toBeVisible();
    await expect(
      page.getByText("https://remote.openyak.test", { exact: true }).first(),
    ).toBeVisible();
    await page.getByRole("button", { name: /Copy/i }).click();
    await page.getByRole("button", { name: /Rotate Token/i }).click();
  });
});

test.describe("OpenYak mobile remote preflight", () => {
  test.use({ viewport: { width: 393, height: 852 }, isMobile: true });

  test("mobile settings path: connection and provider selection", async ({
    page,
  }) => {
    await page.goto("/m/settings?token=remote-token");
    await expect(
      page.getByRole("heading", { name: "Connection" }),
    ).toBeVisible();
    await expect(page.getByText("Connected")).toBeVisible();
    await expect(page.getByText("Model Access")).toBeVisible();
    await expect(page.getByText("OpenRouter")).toBeVisible();
    await page.getByText("ChatGPT Subscription").click();
    await expect(
      page.getByRole("button", {
        name: /ChatGPT Subscription 1 model available/i,
      }),
    ).toBeVisible();
  });

  test("mobile task path: task list, new task, submit", async ({ page }) => {
    await page.goto("/m?token=remote-token");
    await expect(page.getByRole("heading", { name: "OpenYak" })).toBeVisible();
    await expect(page.getByText("Quarterly planning notes")).toBeVisible();

    await page.getByRole("button", { name: "New task" }).click({ force: true });
    await expect(page.getByRole("heading", { name: "New Task" })).toBeVisible();
    await expect(page.locator("select")).toContainText("Claude Sonnet 4.5");

    await page
      .getByPlaceholder("What should OpenYak do?")
      .fill("Check the release notes from my phone");
    const promptResponse = page.waitForResponse(
      (res) => res.url().includes("/api/chat/prompt") && res.status() === 200,
    );
    await page.getByPlaceholder("What should OpenYak do?").press("Enter");
    await promptResponse;
  });
});
