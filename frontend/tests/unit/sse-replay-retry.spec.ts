import { expect, test } from "@playwright/test";
import { SSEClient } from "../../src/lib/sse";
import {
  disposeAllStreams,
  getActiveStreamId,
  isStreamActive,
  startStream,
  stopStream,
} from "../../src/lib/session-stream-registry";
import { useChatStore } from "../../src/stores/chat-store";
import { useConnectionStore } from "../../src/stores/connection-store";

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
  private currentLastEventId = "";

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
    if (id !== undefined) this.currentLastEventId = id;
    const event = new MessageEvent(type, {
      data: JSON.stringify(data),
      // EventSource keeps the most recent id for later events that omit
      // their own id field.
      lastEventId: this.currentLastEventId,
    });
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open() {
    this.readyState = FakeEventSource.OPEN;
    this.onopen?.();
  }

  failClosed() {
    this.readyState = FakeEventSource.CLOSED;
    this.onerror?.(new Event("error"));
  }

  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
}

test.describe("SSE replay recovery", () => {
  const originalEventSource = globalThis.EventSource;
  const originalDocument = globalThis.document;
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  let client: SSEClient | null = null;

  test.beforeEach(() => {
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
    FakeEventSource.latest = null;
  });

  test.afterEach(() => {
    client?.close();
    client = null;
    disposeAllStreams();
    useChatStore.getState().resetAll();
    Object.defineProperty(globalThis, "EventSource", {
      configurable: true,
      value: originalEventSource,
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: originalDocument,
    });
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: originalFetch,
    });
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: originalSetTimeout,
    });
  });

  test("delivers each numbered event once after Last-Event-ID resume", () => {
    const received: string[] = [];
    client = new SSEClient({
      url: "http://localhost/stream",
      initialLastEventId: 4,
    });
    client.on("text-delta", (data) => received.push(data.text ?? ""));
    client.connect();

    const stream = FakeEventSource.latest;
    expect(stream).not.toBeNull();
    stream!.emit("text-delta", { text: "replayed-4" }, "4");
    stream!.emit("text-delta", { text: "fresh-5" }, "5");
    stream!.emit("text-delta", { text: "duplicate-5" }, "5");
    stream!.emit("text-delta", { text: "older-3" }, "3");
    stream!.emit("text-delta", { text: "fresh-6" }, "6");

    expect(received).toEqual(["fresh-5", "fresh-6"]);
  });

  test("continues delivering legacy events that do not have an id", () => {
    const received: string[] = [];
    client = new SSEClient({
      url: "http://localhost/stream",
      initialLastEventId: 9,
    });
    client.on("text-delta", (data) => received.push(data.text ?? ""));
    client.connect();

    const stream = FakeEventSource.latest;
    stream!.emit("text-delta", { text: "legacy-one" });
    stream!.emit("text-delta", { text: "legacy-two" });

    expect(received).toEqual(["legacy-one", "legacy-two"]);
  });

  test("delivers an unnumbered missing-job terminal after a high replay id", () => {
    const errors: string[] = [];
    client = new SSEClient({
      url: "http://localhost/stream",
      initialLastEventId: 9,
    });
    client.on("agent-error", (data) => {
      if (data.code === "JOB_NOT_FOUND") errors.push(data.code);
    });
    client.connect();

    FakeEventSource.latest!.emit("agent-error", {
      error_message: "Job not found",
      code: "JOB_NOT_FOUND",
    });

    expect(errors).toEqual(["JOB_NOT_FOUND"]);
  });

  test("does not dedupe unnumbered heartbeat and restart terminal carrying a cumulative id", () => {
    const received: string[] = [];
    client = new SSEClient({ url: "http://localhost/stream" });
    client.on("text-delta", () => received.push("text"));
    client.on("heartbeat", () => received.push("heartbeat"));
    client.on("agent-error", (data) => {
      if (data.code === "JOB_NOT_FOUND") received.push("missing-job");
    });
    client.connect();

    const stream = FakeEventSource.latest!;
    stream.emit("text-delta", { text: "accepted" }, "9");
    stream.emit("heartbeat", {});
    stream.emit("agent-error", {
      error_message: "Job not found",
      code: "JOB_NOT_FOUND",
    });

    expect(received).toEqual(["text", "heartbeat", "missing-job"]);
  });

  test("dispatches a new terminal event but ignores its replay", () => {
    let doneCount = 0;
    client = new SSEClient({
      url: "http://localhost/stream",
      initialLastEventId: 11,
    });
    client.on("done", () => {
      doneCount += 1;
    });
    client.connect();

    const stream = FakeEventSource.latest;
    stream!.emit("done", { finish_reason: "stop" }, "12");
    stream!.emit("done", { finish_reason: "stop" }, "12");

    expect(doneCount).toBe(1);
  });

  test("reconciles a restarted browser stream from the last accepted event", () => {
    const received: string[] = [];
    client = new SSEClient({ url: "http://localhost/stream" });
    client.on("text-delta", (data) => received.push(data.text ?? ""));
    client.connect();

    const originalStream = FakeEventSource.latest!;
    originalStream.emit("text-delta", { text: "before-restart" }, "5");
    originalStream.close();
    client.checkHealth();

    const resumedStream = FakeEventSource.latest!;
    expect(resumedStream).not.toBe(originalStream);
    expect(new URL(resumedStream.url).searchParams.get("last_event_id")).toBe("5");
    resumedStream.emit("text-delta", { text: "replayed-after-restart" }, "5");
    resumedStream.emit("text-delta", { text: "after-restart" }, "6");

    expect(received).toEqual(["before-restart", "after-restart"]);
  });

  test("treats an active fetch stream as healthy when no EventSource exists", () => {
    client = new SSEClient({ url: "http://localhost/stream" });
    const remoteTransport = client as unknown as {
      abortController: AbortController | null;
      doConnect: () => void;
    };
    const controller = new AbortController();
    let reconnects = 0;
    remoteTransport.abortController = controller;
    remoteTransport.doConnect = () => {
      reconnects += 1;
    };

    client.checkHealth();

    expect(reconnects).toBe(0);
    expect(controller.signal.aborted).toBe(false);
  });

  test("drops replayed tool events before they mutate Session state", async () => {
    useChatStore.getState().startGeneration("session-tool", "stream-tool");
    await startStream("session-tool", "stream-tool");
    const stream = FakeEventSource.latest!;

    stream.emit("tool-call", {
      tool: "read",
      call_id: "accepted-call",
      arguments: { path: "README.md" },
    }, "3");
    stream.emit("tool-call", {
      tool: "write",
      call_id: "replayed-call",
      arguments: { path: "duplicate.md" },
    }, "3");

    const toolCallIds = useChatStore.getState().sessions["session-tool"].streamingParts
      .filter((part) => part.type === "tool")
      .map((part) => part.call_id);
    expect(toolCallIds).toEqual(["accepted-call"]);
  });

  test("exposes reconnecting copy for the affected Session", async () => {
    useChatStore.getState().startGeneration("session-reconnect", "stream-reconnect");
    await startStream("session-reconnect", "stream-reconnect");

    const stream = FakeEventSource.latest;
    stream!.open();
    stream!.failClosed();

    expect(
      useConnectionStore.getState().sessionStates["session-reconnect"],
    ).toEqual({
      status: "reconnecting",
      message: "Reconnecting…",
    });
  });

  test("keeps the composer locked when reconnect attempts end but the backend job is still active", async () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: string | URL | Request) => {
        expect(String(input)).toContain("/api/chat/active");
        return new Response(
          JSON.stringify([
            {
              session_id: "session-disconnected-active",
              stream_id: "stream-disconnected-active",
            },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    });
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: (
        handler: TimerHandler,
        timeout?: number,
        ...args: unknown[]
      ) => originalSetTimeout(
        handler,
        timeout != null && timeout >= 500 && timeout <= 10_000 ? 0 : timeout,
        ...args,
      ),
    });

    useChatStore
      .getState()
      .startGeneration("session-disconnected-active", "stream-disconnected-active");
    await startStream("session-disconnected-active", "stream-disconnected-active");

    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (
        useConnectionStore.getState().sessionStates["session-disconnected-active"]
          ?.status === "disconnected"
      ) {
        break;
      }
      FakeEventSource.latest!.failClosed();
      await new Promise((resolve) => originalSetTimeout(resolve, 5));
    }

    await expect.poll(
      () =>
        useConnectionStore.getState().sessionStates["session-disconnected-active"]
          ?.status,
    ).toBe("disconnected");
    await expect.poll(
      () =>
        useChatStore.getState().sessions["session-disconnected-active"]
          ?.isGenerating,
    ).toBe(true);
    expect(isStreamActive("session-disconnected-active")).toBe(true);
  });

  test("keeps the composer locked when a terminal step is followed by an active backend job", async () => {
    Object.defineProperty(globalThis, "fetch", {
      configurable: true,
      value: async (input: string | URL | Request) => {
        expect(String(input)).toContain("/api/chat/active");
        return new Response(
          JSON.stringify([
            {
              session_id: "session-step-active",
              stream_id: "stream-step-active",
            },
          ]),
          {
            status: 200,
            headers: { "Content-Type": "application/json" },
          },
        );
      },
    });
    Object.defineProperty(globalThis, "setTimeout", {
      configurable: true,
      value: (
        handler: TimerHandler,
        timeout?: number,
        ...args: unknown[]
      ) => originalSetTimeout(
        handler,
        timeout === 1_200 ? 5 : timeout === 8_000 ? 10 : timeout,
        ...args,
      ),
    });

    useChatStore
      .getState()
      .startGeneration("session-step-active", "stream-step-active");
    await startStream("session-step-active", "stream-step-active");
    FakeEventSource.latest!.emit("step-finish", {
      reason: "stop",
      tokens: {},
      cost: 0,
    }, "11");

    await new Promise((resolve) => originalSetTimeout(resolve, 100));

    expect(
      useChatStore.getState().sessions["session-step-active"]?.isGenerating,
    ).toBe(true);
    expect(isStreamActive("session-step-active")).toBe(true);
  });

  test("lets a same-Session restart supersede stream setup that was stopped", async () => {
    useChatStore
      .getState()
      .startGeneration("session-latest-start", "stream-stale");
    const staleStart = startStream("session-latest-start", "stream-stale");

    stopStream("session-latest-start");
    useChatStore.getState().stopGeneration("session-latest-start");
    useChatStore
      .getState()
      .beginSending("session-latest-start", "Retry immediately");
    useChatStore
      .getState()
      .startGeneration("session-latest-start", "stream-latest");
    const latestStart = startStream("session-latest-start", "stream-latest");

    await Promise.all([staleStart, latestStart]);

    expect(getActiveStreamId("session-latest-start")).toBe("stream-latest");
    expect(FakeEventSource.latest?.url).toContain(
      "/api/chat/stream/stream-latest",
    );
    expect(
      useChatStore.getState().sessions["session-latest-start"],
    ).toMatchObject({
      streamId: "stream-latest",
      isGenerating: true,
    });
  });

  test("exposes backend model retries for the affected Session", async () => {
    useChatStore.getState().startGeneration("session-retry", "stream-retry");
    await startStream("session-retry", "stream-retry");

    const stream = FakeEventSource.latest;
    stream!.open();
    stream!.emit("retry", {
      attempt: 1,
      max_retries: 3,
      delay: 1.25,
      reason: "provider rate limit",
    }, "7");

    expect(useConnectionStore.getState().sessionStates["session-retry"]).toEqual({
      status: "retrying",
      message: "Retrying in 2s…",
      retry: {
        attempt: 1,
        maxRetries: 3,
        delayMs: 1_250,
        reason: "provider rate limit",
      },
    });
  });

  test("clears retry copy when the Session resumes streaming", async () => {
    useChatStore.getState().startGeneration("session-resumed", "stream-resumed");
    await startStream("session-resumed", "stream-resumed");

    const stream = FakeEventSource.latest;
    stream!.open();
    stream!.emit("retry", {
      attempt: 1,
      max_retries: 3,
      delay: 1,
      reason: "provider overloaded",
    }, "7");
    stream!.emit("text-delta", { text: "Recovered" }, "8");

    expect(useConnectionStore.getState().sessionStates["session-resumed"]).toEqual({
      status: "connected",
      message: null,
    });
  });

  test("keeps retry state isolated from another connected Session", async () => {
    useChatStore.getState().startGeneration("session-a", "stream-a");
    await startStream("session-a", "stream-a");
    const streamA = FakeEventSource.latest!;
    streamA.open();
    streamA.emit("retry", {
      attempt: 2,
      max_retries: 3,
      delay: 2,
      reason: "upstream timeout",
    }, "4");

    useChatStore.getState().startGeneration("session-b", "stream-b");
    await startStream("session-b", "stream-b");
    FakeEventSource.latest!.open();

    expect(useConnectionStore.getState().sessionStates).toMatchObject({
      "session-a": {
        status: "retrying",
        message: "Retrying in 2s…",
      },
      "session-b": {
        status: "connected",
        message: null,
      },
    });
  });

  test("clears task-local status after a terminal event", async () => {
    useChatStore.getState().startGeneration("session-done", "stream-done");
    await startStream("session-done", "stream-done");
    const stream = FakeEventSource.latest!;
    stream.open();
    stream.emit("done", { finish_reason: "stop" }, "9");

    await expect.poll(
      () => useConnectionStore.getState().sessionStates["session-done"],
    ).toBeUndefined();
  });

  test("clears task-local statuses when the stream registry is disposed", async () => {
    useChatStore.getState().startGeneration("session-dispose", "stream-dispose");
    await startStream("session-dispose", "stream-dispose");
    expect(
      useConnectionStore.getState().sessionStates["session-dispose"],
    ).toBeDefined();

    disposeAllStreams();

    expect(
      useConnectionStore.getState().sessionStates["session-dispose"],
    ).toBeUndefined();
    expect(useConnectionStore.getState().status).toBe("idle");
  });
});
