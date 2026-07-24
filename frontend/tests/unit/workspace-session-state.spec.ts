import { expect, test } from "@playwright/test";
import {
  disposeAllStreams,
  startStream,
} from "../../src/lib/session-stream-registry";
import { useChatStore } from "../../src/stores/chat-store";
import { useWorkspaceStore } from "../../src/stores/workspace-store";

type EventListener = (event: Event) => void;

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static latest: FakeEventSource | null = null;

  readonly url: string;
  readyState = FakeEventSource.OPEN;
  onopen: (() => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  private listeners = new Map<string, EventListener[]>();
  private nextEventId = 1;

  constructor(url: string | URL) {
    this.url = String(url);
    FakeEventSource.latest = this;
  }

  addEventListener(type: string, listener: EventListener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, data: Record<string, unknown>, id?: string) {
    const event = new MessageEvent(type, {
      data: JSON.stringify(data),
      lastEventId: id ?? String(this.nextEventId++),
    });
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

test.describe("Workspace Session state", () => {
  const originalEventSource = globalThis.EventSource;
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;

  test.beforeAll(() => {
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      value: FakeEventSource,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        hidden: false,
        visibilityState: "visible",
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
  });

  test.afterEach(() => {
    disposeAllStreams();
    useChatStore.getState().resetAll();
    useWorkspaceStore.getState().resetAllSessions();
    FakeEventSource.latest = null;
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
  });

  test.afterAll(() => {
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      value: originalEventSource,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
  });

  test("restores todos, files, scratchpad, and path when focus returns to a Session", () => {
    const workspace = useWorkspaceStore.getState();

    workspace.activateSession("session-alpha");
    workspace.setTodos([
      { content: "Alpha plan", status: "in_progress", activeForm: "Planning Alpha" },
    ]);
    workspace.setWorkspaceFiles([
      {
        name: "alpha.md",
        path: "/workspace-alpha/alpha.md",
        type: "generated",
      },
    ]);
    workspace.setScratchpadContent("Alpha notes");
    workspace.setActiveWorkspacePath("/workspace-alpha");

    workspace.activateSession("session-beta");
    expect(useWorkspaceStore.getState()).toMatchObject({
      activeSessionId: "session-beta",
      todos: [],
      workspaceFiles: [],
      scratchpadContent: "",
      activeWorkspacePath: null,
    });

    useWorkspaceStore.getState().setScratchpadContent("Beta notes");
    useWorkspaceStore.getState().setActiveWorkspacePath("/workspace-beta");

    useWorkspaceStore.getState().activateSession("session-alpha");
    expect(useWorkspaceStore.getState()).toMatchObject({
      activeSessionId: "session-alpha",
      todos: [
        { content: "Alpha plan", status: "in_progress", activeForm: "Planning Alpha" },
      ],
      workspaceFiles: [
        {
          name: "alpha.md",
          path: "/workspace-alpha/alpha.md",
          type: "generated",
        },
      ],
      scratchpadContent: "Alpha notes",
      activeWorkspacePath: "/workspace-alpha",
    });
  });

  test("targeted child Session updates do not change the active parent Summary", () => {
    const workspace = useWorkspaceStore.getState();
    workspace.activateSession("parent-alpha");
    workspace.setTodos([{ content: "Parent plan", status: "in_progress" }]);
    workspace.setWorkspaceFiles([
      {
        name: "parent.md",
        path: "/parent/parent.md",
        type: "generated",
      },
    ]);

    workspace.setTodosForSession("child-beta", [
      { content: "Child plan", status: "completed" },
    ]);
    workspace.setWorkspaceFilesForSession("child-beta", [
      {
        name: "child.md",
        path: "/child/child.md",
        type: "generated",
      },
    ]);

    expect(useWorkspaceStore.getState()).toMatchObject({
      activeSessionId: "parent-alpha",
      todos: [{ content: "Parent plan", status: "in_progress" }],
      workspaceFiles: [
        {
          name: "parent.md",
          path: "/parent/parent.md",
          type: "generated",
        },
      ],
    });

    useWorkspaceStore.getState().activateSession("child-beta");
    expect(useWorkspaceStore.getState()).toMatchObject({
      activeSessionId: "child-beta",
      todos: [{ content: "Child plan", status: "completed" }],
      workspaceFiles: [
        {
          name: "child.md",
          path: "/child/child.md",
          type: "generated",
        },
      ],
    });
  });

  test("background Session todo events do not overwrite the visible Session", async () => {
    const workspace = useWorkspaceStore.getState();
    workspace.activateSession("session-alpha");
    workspace.setTodos([{ content: "Alpha plan", status: "in_progress" }]);

    useChatStore.getState().startGeneration("session-beta", "stream-beta");
    await startStream("session-beta", "stream-beta");
    const stream = FakeEventSource.latest;
    expect(stream).not.toBeNull();

    stream!.emit("tool-call", {
      tool: "todo",
      call_id: "todo-beta",
      arguments: {},
    });
    stream!.emit("tool-result", {
      tool: "todo",
      call_id: "todo-beta",
      output: "Todo list updated",
      metadata: {
        todos: [{ content: "Beta plan", status: "in_progress" }],
      },
    });

    expect(useWorkspaceStore.getState()).toMatchObject({
      activeSessionId: "session-alpha",
      todos: [{ content: "Alpha plan", status: "in_progress" }],
    });

    useWorkspaceStore.getState().activateSession("session-beta");
    expect(useWorkspaceStore.getState().todos).toEqual([
      { content: "Beta plan", status: "in_progress" },
    ]);
  });

  test("background Session file refreshes stay in that Session", async () => {
    const workspace = useWorkspaceStore.getState();
    workspace.activateSession("session-alpha");
    workspace.setWorkspaceFiles([
      {
        name: "alpha.md",
        path: "/workspace-alpha/alpha.md",
        type: "generated",
      },
    ]);

    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: string | URL | Request) => {
        expect(String(input)).toContain("/api/sessions/session-beta/files");
        return new Response(
          JSON.stringify({
            files: [
              {
                name: "beta.md",
                path: "/workspace-beta/beta.md",
                type: "generated",
              },
            ],
          }),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    });

    useChatStore.getState().startGeneration("session-beta", "stream-beta");
    await startStream("session-beta", "stream-beta");
    const stream = FakeEventSource.latest;
    expect(stream).not.toBeNull();

    stream!.emit("tool-call", {
      tool: "write",
      call_id: "write-beta",
      arguments: { path: "/workspace-beta/beta.md" },
    });
    stream!.emit("tool-result", {
      tool: "write",
      call_id: "write-beta",
      output: "Wrote beta.md",
    });

    await expect
      .poll(() => useWorkspaceStore.getState().getSessionState("session-beta").workspaceFiles)
      .toEqual([
        {
          name: "beta.md",
          path: "/workspace-beta/beta.md",
          type: "generated",
        },
      ]);
    expect(useWorkspaceStore.getState().workspaceFiles).toEqual([
      {
        name: "alpha.md",
        path: "/workspace-alpha/alpha.md",
        type: "generated",
      },
    ]);
  });
});
