import type { Page, Request, Route } from "@playwright/test";

interface MockPart {
  id: string;
  message_id: string;
  session_id: string;
  time_created: string;
  data: Record<string, unknown>;
}

interface MockMessage {
  id: string;
  session_id: string;
  time_created: string;
  data: Record<string, unknown>;
  parts: MockPart[];
}

interface MockMessagePage {
  total: number;
  offset: number;
  messages: MockMessage[];
}

interface SessionRecord {
  id: string;
  project_id: null;
  parent_id: null;
  slug: null;
  directory: string | null;
  title: string;
  version: number;
  summary_additions: number;
  summary_deletions: number;
  summary_files: number;
  summary_diffs: unknown[];
  is_pinned: boolean;
  permission: Record<string, unknown>;
  time_created: string;
  time_updated: string;
  time_compacting: null;
  time_archived: null;
}

export interface OpenYakMockState {
  promptBodies: unknown[];
  editBodies: unknown[];
  chatResponses: unknown[];
  abortRequests: unknown[];
  automationCreates: unknown[];
  automationUpdates: unknown[];
  automationDeletes: string[];
  automationRuns: string[];
  connectorCreates: unknown[];
  providerSaves: unknown[];
  memoryUpdates: unknown[];
  fileUploads: string[];
  attachedPaths: string[];
  binaryReads: string[];
  compactRequests: unknown[];
  sessionUpdates: unknown[];
  sessionDeletes: string[];
  sessionExports: string[];
  remoteConfigUpdates: unknown[];
  channelAdds: unknown[];
  channelRemoves: unknown[];
  authRequests: unknown[];
  remoteEnabled: boolean;
}

type AutomationMock = ReturnType<typeof createdAutomation>;

interface PromptErrorMock {
  match: string;
  status: number;
  detail: string;
}

interface ConnectorErrorMock {
  match: string;
  status: number;
  detail: string;
}

interface ActiveJobMock {
  stream_id: string;
  session_id: string;
  needs_input?: boolean;
}

export interface OpenYakMockOptions {
  failUploads?: string[];
  promptErrors?: PromptErrorMock[];
  binaryFailures?: string[];
  healthStatus?: number;
  ollamaStatusCode?: number;
  openaiLoginStatus?: number;
  openaiSubscriptionConnected?: boolean;
  remoteProviderInfoStatus?: number | number[];
  connectorErrors?: ConnectorErrorMock[];
  activeJobs?: ActiveJobMock[];
}

export interface OpenYakSeedOptions {
  authConnected?: boolean;
  hasCompletedOnboarding?: boolean;
  savedPermissions?: Array<{ tool: string; allow: boolean; timestamp: number }>;
  force?: boolean;
}

interface BinaryFixture {
  content_base64: string;
  name: string;
  path: string;
  mime_type: string;
  size: number;
}

const now = "2026-04-26T12:00:00.000Z";

const sessionAlpha: SessionRecord = {
  id: "session-alpha",
  project_id: null,
  parent_id: null,
  slug: null,
  directory: "/Users/alex/openyak-demo",
  title: "Quarterly planning notes",
  version: 0,
  summary_additions: 4,
  summary_deletions: 1,
  summary_files: 2,
  summary_diffs: [],
  is_pinned: true,
  permission: {},
  time_created: "2026-04-25T10:00:00.000Z",
  time_updated: now,
  time_compacting: null,
  time_archived: null,
};

const sessionBeta = {
  ...sessionAlpha,
  id: "session-beta",
  directory: null,
  title: "Invoice cleanup",
  is_pinned: false,
  summary_additions: 0,
  summary_deletions: 0,
  summary_files: 0,
  time_created: "2026-04-24T10:00:00.000Z",
  time_updated: "2026-04-24T11:00:00.000Z",
};

const sessionArtifacts = {
  ...sessionAlpha,
  id: "session-artifacts",
  directory: "/Users/alex/openyak-demo",
  title: "Artifact showcase",
  is_pinned: false,
  summary_additions: 24,
  summary_deletions: 3,
  summary_files: 6,
  time_created: "2026-04-23T10:00:00.000Z",
  time_updated: "2026-04-23T11:30:00.000Z",
};

const sessionLong = {
  ...sessionAlpha,
  id: "session-long",
  directory: "/Users/alex/openyak-demo",
  title: "Long conversation load test",
  is_pinned: false,
  summary_additions: 12,
  summary_deletions: 4,
  summary_files: 3,
  time_created: "2026-04-22T10:00:00.000Z",
  time_updated: "2026-04-22T13:30:00.000Z",
};

const sessionCompact = {
  ...sessionAlpha,
  id: "session-compact",
  directory: "/Users/alex/openyak-demo",
  title: "Context compression checkpoint",
  is_pinned: false,
  summary_additions: 48,
  summary_deletions: 9,
  summary_files: 8,
  time_created: "2026-04-21T10:00:00.000Z",
  time_updated: "2026-04-21T13:30:00.000Z",
};

const createdSession = {
  ...sessionAlpha,
  id: "session-new",
  directory: null,
  title: "Create a UI preflight checklist",
  is_pinned: false,
  time_created: now,
  time_updated: now,
};

const models = [
  {
    id: "openyak/best-free",
    name: "Best Free",
    provider_id: "openyak-proxy",
    capabilities: {
      function_calling: true,
      vision: true,
      reasoning: true,
      json_output: true,
      max_context: 128000,
      max_output: 8192,
    },
    pricing: { prompt: 0, completion: 0 },
    metadata: {},
  },
  {
    id: "openrouter/anthropic/claude-sonnet-4.5",
    name: "Claude Sonnet 4.5",
    provider_id: "openrouter",
    capabilities: {
      function_calling: true,
      vision: true,
      reasoning: true,
      json_output: true,
      max_context: 200000,
      max_output: 8192,
    },
    pricing: { prompt: 0.000003, completion: 0.000015 },
    metadata: {},
  },
  {
    id: "openai-subscription/gpt-5.5",
    name: "GPT-5.5",
    provider_id: "openai-subscription",
    capabilities: {
      function_calling: true,
      vision: true,
      reasoning: true,
      json_output: true,
      max_context: 256000,
      max_output: 16384,
    },
    pricing: { prompt: 0, completion: 0 },
    metadata: {},
  },
  {
    id: "local/qwen3-coder",
    name: "Qwen3 Coder Local",
    provider_id: "local",
    capabilities: {
      function_calling: true,
      vision: false,
      reasoning: true,
      json_output: true,
      max_context: 64000,
      max_output: 8192,
    },
    pricing: { prompt: 0, completion: 0 },
    metadata: {},
  },
  {
    id: "custom_acme/acme-coder",
    name: "Acme Coder",
    provider_id: "custom_acme",
    capabilities: {
      function_calling: true,
      vision: false,
      reasoning: true,
      json_output: true,
      max_context: 128000,
      max_output: 8192,
    },
    pricing: { prompt: 0.000001, completion: 0.000002 },
    metadata: {},
  },
];

const messagePage = (sessionId: string): MockMessagePage => {
  const isBeta = sessionId === "session-beta";
  return {
    total: 2,
    offset: 0,
    messages: [
      {
        id: `${sessionId}-user-1`,
        session_id: sessionId,
        time_created: "2026-04-26T11:58:00.000Z",
        data: { role: "user", agent: "build" },
        parts: [
          {
            id: `${sessionId}-part-user-1`,
            message_id: `${sessionId}-user-1`,
            session_id: sessionId,
            time_created: "2026-04-26T11:58:00.000Z",
            data: {
              type: "text",
              text: isBeta ? "Clean up the invoice folder" : "Summarize the quarterly plan",
            },
          },
        ],
      },
      {
        id: `${sessionId}-assistant-1`,
        session_id: sessionId,
        time_created: "2026-04-26T11:59:00.000Z",
        data: {
          role: "assistant",
          agent: "build",
          model_id: "openyak/best-free",
          provider_id: "openyak-proxy",
          cost: 0,
          finish: "stop",
        },
        parts: [
          {
            id: `${sessionId}-part-assistant-1`,
            message_id: `${sessionId}-assistant-1`,
            session_id: sessionId,
            time_created: "2026-04-26T11:59:00.000Z",
            data: {
              type: "text",
              text: isBeta
                ? "Invoices are grouped by vendor, month, and payment status for review."
                : "The plan has three priorities: retention, onboarding, and billing clarity.",
            },
          },
          {
            id: `${sessionId}-part-assistant-finish`,
            message_id: `${sessionId}-assistant-1`,
            session_id: sessionId,
            time_created: "2026-04-26T11:59:02.000Z",
            data: {
              type: "step-finish",
              reason: "stop",
              tokens: { input: 1200, output: 280, reasoning: 30, cache_read: 0, cache_write: 0 },
              cost: 0,
            },
          },
        ],
      },
    ],
  };
};

const createdMessagePage: MockMessagePage = {
  total: 2,
  offset: 0,
  messages: [
    {
      id: "session-new-user-1",
      session_id: "session-new",
      time_created: now,
      data: { role: "user", agent: "build" },
      parts: [
        {
          id: "session-new-user-text",
          message_id: "session-new-user-1",
          session_id: "session-new",
          time_created: now,
          data: { type: "text", text: "Create a UI preflight checklist" },
        },
        {
          id: "session-new-user-file-upload",
          message_id: "session-new-user-1",
          session_id: "session-new",
          time_created: now,
          data: {
            type: "file",
            file_id: "file-1",
            name: "sample-preflight.csv",
            path: "/tmp/openyak-ui/sample-preflight.csv",
            size: 128,
            mime_type: "text/csv",
            source: "uploaded",
            content_hash: "hash-1",
          },
        },
        {
          id: "session-new-user-file-mentioned",
          message_id: "session-new-user-1",
          session_id: "session-new",
          time_created: now,
          data: {
            type: "file",
            file_id: "attached-0",
            name: "release-notes.md",
            path: "/Users/alex/openyak-demo/docs/release-notes.md",
            size: 256,
            mime_type: "text/markdown",
            source: "referenced",
            content_hash: "attached-hash-0",
          },
        },
      ],
    },
    {
      id: "session-new-assistant-1",
      session_id: "session-new",
      time_created: now,
      data: {
        role: "assistant",
        agent: "build",
        model_id: "openyak/best-free",
        provider_id: "openyak-proxy",
        cost: 0,
        finish: "stop",
      },
      parts: [
        {
          id: "session-new-assistant-text",
          message_id: "session-new-assistant-1",
          session_id: "session-new",
          time_created: now,
          data: { type: "text", text: "Preflight answer streamed from the mock backend." },
        },
        {
          id: "session-new-assistant-finish",
          message_id: "session-new-assistant-1",
          session_id: "session-new",
          time_created: now,
          data: {
            type: "step-finish",
            reason: "stop",
            tokens: { input: 10, output: 8, reasoning: 0, cache_read: 0, cache_write: 0 },
            cost: 0,
          },
        },
      ],
    },
  ],
};

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type NaturalOfficeKind = "memo" | "budget" | "deck" | "vendor" | "board" | "followup";

const naturalOfficeResponses: Record<NaturalOfficeKind, string> = {
  memo:
    "VP-ready customer feedback memo\n\nExecutive readout: the feedback points to a fixable revenue risk, not a product-market problem. Customers still value the workflow, but onboarding, pricing language, and support ownership are creating avoidable friction before expansion conversations.\n\nTop three themes\n\n| Theme | Signal from notes | Business impact | Owner |\n| --- | --- | --- | --- |\n| Onboarding friction | New teams need repeated setup help | Delays first successful project | Growth Ops |\n| Pricing confusion | Buyers ask when usage becomes billable | Slows procurement and expansion | Finance |\n| Support handoff gaps | Tickets bounce between CS and Support | Creates executive escalation risk | Support Ops |\n\nRecommended actions\n\n1. Publish a one-page pricing FAQ by Friday.\n2. Assign one owner for onboarding follow-up on every strategic account.\n3. Review the SLA dashboard in next week's staff meeting.\n\nEmail draft\n\nTeam, I reviewed the customer notes and the pattern is clear: we should tighten onboarding, clarify pricing language, and close support handoffs before the next expansion cycle. I recommend Growth Ops, Finance, and Support Ops each bring a concrete fix and owner to tomorrow's planning review.",
  budget:
    "Finance workbook review\n\nExecutive view: the quarter is still manageable, but the support contractor line is now the controlling variance. Paid acquisition is under plan, which offsets part of the overage, but the forecast should not be held flat unless Support Ops confirms automation savings by month end.\n\n| Line item | Budget | Actual / forecast signal | Variance call | Owner question |\n| --- | --- | --- | --- | --- |\n| Customer Success | On plan | Slightly over on enterprise support | Watch | What retention risk is this protecting? |\n| Paid acquisition | Under plan | Spend delayed by campaign pause | Favorable | Will Q3 pipeline be affected? |\n| Infrastructure | Above forecast | Batch workloads increased | Medium risk | Which jobs can be moved off peak? |\n| Support contractors | 18% over | Ticket volume rose faster than staffing | Critical | What is the exit date and automation plan? |\n\nFinance recommendation\n\nHold the current quarter forecast only if Support Ops commits to a contractor ramp-down date, Product confirms the automation release scope, and Finance updates the run-rate model before the operating review.",
  deck:
    "QBR deck feedback\n\nSlide-by-slide: tighten the opening summary, move retention proof before pipeline claims, and split the crowded risk slide into risks and asks.\n\nEvidence gaps: add customer quotes, renewal cohort detail, and the source for the forecast assumption.\n\nSpeaker notes: call out what changed since last QBR and state the decision on the final slide.\n\nDecision ask: approve a 30-day retention sprint with Product, CS, and Finance owners.",
  vendor:
    "Vendor renewal risk brief\n\nObligations: confirm the renewal notice window, security addendum, data-retention clause, and support SLA.\n\nDeadlines: notice date is the critical path, followed by procurement review and legal redline cutoff.\n\nRisks: auto-renewal, uncapped usage overage, missing DPA language, and weak termination assistance.\n\nOwner / 负责人: Legal owns terms, Procurement owns pricing, Security owns DPA review, and Finance owns budget approval.\n\nFirst three actions: freeze renewal terms, request a price hold, and schedule Legal/Security review before procurement approval.",
  board:
    "Board-ready launch brief\n\nExecutive summary: launch readiness is green on product scope, yellow on budget variance, and yellow on vendor renewal risk. The launch can proceed if Finance locks the contractor run-rate, Product closes onboarding gaps, and Legal confirms the renewal notice window before the board packet is finalized.\n\nDecision required\n\nApprove launch with three operating conditions:\n\n1. Finance confirms the contractor exit date and revised support run-rate.\n2. Product closes the onboarding checklist for enterprise accounts.\n3. Legal and Security complete vendor renewal review before procurement approval.\n\n| Risk | Owner | Severity | Next step |\n| --- | --- | --- | --- |\n| Support contractor variance | Finance | Yellow | Confirm exit date and savings model |\n| Enterprise onboarding readiness | Product | Yellow | Close remaining checklist items |\n| Vendor renewal notice window | Legal | Yellow | Lock renewal date and redline cutoff |\n| Customer communication | CS | Green | Send launch guidance to account owners |\n\nArtifacts prepared: a Markdown launch brief and a Mermaid decision workflow are attached for the meeting packet.",
  followup:
    "Launch team follow-up\n\nRACI: Product is responsible for onboarding scope, CS is accountable for customer communication, Finance is consulted on budget variance, and Legal/Security are consulted on vendor terms.\n\n30-day agenda: Week 1 owner alignment, Week 2 evidence cleanup, Week 3 renewal decision, Week 4 board follow-up and metric review.",
};

function latestPromptText(state: OpenYakMockState) {
  const latest = state.promptBodies[state.promptBodies.length - 1] as Record<string, unknown> | undefined;
  return typeof latest?.text === "string" ? latest.text : "";
}

function naturalOfficeKindFromText(text: string): NaturalOfficeKind | null {
  const lower = text.toLowerCase();
  if (/\braci\b|30-day|30 day|agenda/.test(lower)) return "followup";
  if (lower.includes("board-ready") || lower.includes("launch readiness") || lower.includes("decision workflow")) return "board";
  if (lower.includes("vendor") || lower.includes("renewal") || lower.includes("procurement")) return "vendor";
  if (lower.includes("deck") || lower.includes("slides") || lower.includes("qbr")) return "deck";
  if (lower.includes("budget") || lower.includes("forecast") || lower.includes("variance")) return "budget";
  if (lower.includes("vp-ready memo") || lower.includes("customer feedback") || lower.includes("memo")) return "memo";
  return null;
}

function uploadedFilePart(name: string, index: number) {
  const extension = name.split(".").pop()?.toLowerCase();
  const mimeType =
    extension === "csv"
      ? "text/csv"
      : extension === "docx"
        ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        : extension === "xlsx"
          ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          : extension === "pptx"
            ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
            : extension === "pdf"
              ? "application/pdf"
              : "text/plain";

  return {
    id: `session-new-user-file-upload-${index}`,
    message_id: "session-new-user-1",
    session_id: "session-new",
    time_created: now,
    data: {
      type: "file",
      file_id: `file-${index + 1}`,
      name,
      path: `/tmp/openyak-ui/${name}`,
      size: 128,
      mime_type: mimeType,
      source: "uploaded",
      content_hash: `hash-${index + 1}`,
    },
  };
}

function applyNaturalOfficeMessagePage(state: OpenYakMockState, kind: NaturalOfficeKind) {
  const page = cloneJson(createdMessagePage);
  const user = page.messages[0];
  const assistant = page.messages[1];
  const promptText = latestPromptText(state);

  user.parts = [
    {
      id: "session-new-user-text",
      message_id: "session-new-user-1",
      session_id: "session-new",
      time_created: now,
      data: { type: "text", text: promptText },
    },
    ...state.fileUploads.map((name, index) => uploadedFilePart(name, index)),
  ];

  assistant.parts[0].data = {
    type: "text",
    text: naturalOfficeResponses[kind],
  };

  if (kind === "board") {
    assistant.parts.splice(
      1,
      0,
      artifactToolPart("session-new", "session-new-assistant-1", "artifact-natural-board-md", {
        command: "create",
        type: "markdown",
        title: "Board-ready Launch Brief",
        identifier: "board-ready-launch-brief",
        content:
          "# Board-ready Launch Brief\n\n| Risk | Owner | Next step |\n| --- | --- | --- |\n| Budget variance | Finance | Confirm contractor exit date |\n| Onboarding readiness | Product | Close scope gaps |\n| Vendor renewal | Legal | Lock notice window |",
      }),
      artifactToolPart("session-new", "session-new-assistant-1", "artifact-natural-board-mermaid", {
        command: "create",
        type: "mermaid",
        title: "Launch Decision Workflow",
        identifier: "launch-decision-workflow",
        content:
          "flowchart TD\nA[Launch readiness review] --> B{Budget variance accepted?}\nB -->|Yes| C[Approve launch]\nB -->|No| D[Finance owner review]\nC --> E[Board follow-up]",
      }),
    );
  }

  assistant.parts[assistant.parts.length - 1].data = {
    type: "step-finish",
    reason: "stop",
    tokens: { input: 4200, output: 620, reasoning: 80, cache_read: 0, cache_write: 0 },
    cost: 0,
  };

  return page;
}

function createdMessagePageForState(state: OpenYakMockState) {
  const page = cloneJson(createdMessagePage);
  const naturalKind = naturalOfficeKindFromText(latestPromptText(state));
  if (naturalKind) return applyNaturalOfficeMessagePage(state, naturalKind);

  const promptedAutoCompact = state.promptBodies.some((body) =>
    JSON.stringify(body).toLowerCase().includes("auto compress"),
  );
  if (!promptedAutoCompact) return page;

  const assistant = page.messages[1];
  assistant.parts[0].data = {
    type: "text",
    text:
      "Auto compacted answer persisted after compression.\n\nContext checkpoint\n\nOpenYak preserved the launch-review thread, compressed older turns, and kept the active decision context available for the next reply.\n\n| Area | Preserved detail | Next action |\n| --- | --- | --- |\n| Owners | Product, CS, Finance, Legal, Security | Confirm one accountable owner per risk |\n| Deadlines | Board packet, renewal window, automation savings date | Keep the critical dates in the active summary |\n| Risks | Budget variance, onboarding readiness, vendor renewal | Use the compressed summary for follow-up planning |\n\nNext decision: approve the launch only after Finance confirms the contractor exit date and Legal locks the vendor renewal window.",
  };
  assistant.parts.splice(1, 0, {
    id: "session-new-auto-compaction",
    message_id: "session-new-assistant-1",
    session_id: "session-new",
    time_created: now,
    data: { type: "compaction", auto: true },
  });
  assistant.parts[2].data = {
    type: "step-finish",
    reason: "stop",
    tokens: { input: 24000, output: 220, reasoning: 20, cache_read: 0, cache_write: 0 },
    cost: 0,
  };
  return page;
}

function sessionMessagePageForState(sessionId: string, state: OpenYakMockState) {
  const page = cloneJson(messagePage(sessionId));
  const edit = [...state.editBodies].reverse().find((body) => {
    const data = body as Record<string, unknown> | null;
    return data?.session_id === sessionId;
  }) as Record<string, unknown> | undefined;
  if (!edit) return page;
  const editedText = String(edit.text ?? "");
  const userMessageId = String(edit.message_id ?? "");
  const userMessage = page.messages.find((message) => message.id === userMessageId);
  const userTextPart = userMessage?.parts.find((part) => part.data.type === "text");
  if (userTextPart && editedText) {
    userTextPart.data = { type: "text", text: editedText };
  }
  const assistant = page.messages.find((message) => message.data.role === "assistant");
  const assistantTextPart = assistant?.parts.find((part) => part.data.type === "text");
  if (assistantTextPart) {
    assistantTextPart.data = {
      type: "text",
      text: "Edited response streamed from the mock backend.",
    };
  }
  return page;
}

function textMessage(
  sessionId: string,
  id: string,
  role: "user" | "assistant",
  text: string,
  tokens?: Record<string, number>,
): MockMessage {
  const messageId = `${sessionId}-${id}`;
  return {
    id: messageId,
    session_id: sessionId,
    time_created: now,
    data: role === "assistant"
      ? {
          role,
          agent: "build",
          model_id: "openyak/best-free",
          provider_id: "openyak-proxy",
          cost: 0,
          finish: "stop",
        }
      : { role, agent: "build" },
    parts: [
      {
        id: `${messageId}-text`,
        message_id: messageId,
        session_id: sessionId,
        time_created: now,
        data: { type: "text", text },
      },
      ...(role === "assistant"
        ? [
            {
              id: `${messageId}-finish`,
              message_id: messageId,
              session_id: sessionId,
              time_created: now,
              data: {
                type: "step-finish",
                reason: "stop",
                tokens: tokens ?? { input: 1200, output: 120, reasoning: 12, cache_read: 0, cache_write: 0 },
                cost: 0,
              },
            },
          ]
        : []),
    ],
  };
}

const longConversationPrompts = [
  "Can you turn the launch notes into a short operating brief for tomorrow's review?",
  "Add a section that separates product readiness from commercial risk.",
  "Please pull the budget variance into the same brief and make the owner explicit.",
  "Can you rewrite the risk table so it is usable in a board packet?",
  "The vendor renewal feels underplayed. What should Legal confirm before we commit?",
  "Draft the customer communication plan as three bullets for CS leadership.",
  "Now convert this into a 30-day rollout plan with owners and dates.",
  "Can you make the recommendation more decisive, but still call out the unresolved items?",
];

const longConversationReplies = [
  "I would frame the launch as conditionally ready: product scope is green, but the support run-rate and vendor renewal need explicit owners before the board review.",
  "I separated the work into product readiness, finance exposure, legal dependency, and customer communication so each owner can act without rereading the full thread.",
  "The controlling budget issue is support contractor spend. Finance should confirm the exit date, while Support Ops confirms whether automation savings will land this month.",
  "For the board packet, keep the table compact: risk, owner, severity, and next decision. Avoid narrative in the table and put the recommendation above it.",
  "Legal should confirm the renewal notice window, termination assistance, DPA language, and any usage overage exposure before Procurement approves the renewal path.",
  "For CS, the clean message is: launch scope is stable, onboarding guidance is updated, and account owners should escalate any enterprise blockers by Friday.",
  "The 30-day plan should start with owner alignment, then evidence cleanup, then renewal decision, then board follow-up and metric review.",
  "Recommendation: approve the launch with three conditions: Finance locks the run-rate, Product closes onboarding gaps, and Legal confirms renewal timing.",
];

const longConversationMessages = Array.from({ length: 60 }, (_, index) => {
  const turn = String(index + 1).padStart(3, "0");
  const prompt = longConversationPrompts[index % longConversationPrompts.length];
  const reply = longConversationReplies[index % longConversationReplies.length];
  return [
    textMessage(
      "session-long",
      `user-${turn}`,
      "user",
      `Long user turn ${turn}: ${index >= 56
        ? [
            "Before I send this to the board, can you sanity-check whether the vendor renewal risk should stay yellow or move to red?",
            "Can you use the same context to draft the final decision paragraph for the pre-read?",
            "Please make the last paragraph sound like an operator wrote it, not like a generic summary.",
            "Now give me the final version with the launch decision, owners, deadlines, and open risks in one place.",
          ][index - 56]
        : prompt}`,
    ),
    textMessage(
      "session-long",
      `assistant-${turn}`,
      "assistant",
      `Long assistant turn ${turn}: ${index >= 56
        ? [
            "Keep vendor renewal at yellow unless Legal misses the notice-window confirmation. It becomes red only if the renewal date is inside the freeze period or if the DPA language cannot be confirmed before procurement approval.",
            "Recommended decision: approve the launch for the board packet, conditional on Finance confirming the contractor exit date, Product closing the onboarding checklist, and Legal locking the renewal notice window before final approval.",
            "Here is a more operator-style close: We can move forward, but only with named owners on the three unresolved items. Finance owns run-rate, Product owns onboarding completion, and Legal owns renewal timing.",
            "Final version: launch is approved with conditions. Product closes enterprise onboarding gaps by Wednesday, Finance confirms the support contractor run-rate by Friday, Legal locks the vendor renewal window before procurement approval, and CS sends account-owner guidance after those three checks are complete.",
          ][index - 56]
        : reply}`,
      { input: 48000 + index * 700, output: 180, reasoning: 12, cache_read: 0, cache_write: 0 },
    ),
  ];
}).flat();

function paginatedMessages(messages: ReturnType<typeof textMessage>[], limit: number, rawOffset: number) {
  const total = messages.length;
  const offset = rawOffset < 0 ? Math.max(0, total - limit) : Math.max(0, rawOffset);
  return {
    total,
    offset,
    messages: messages.slice(offset, Math.min(total, offset + limit)),
  };
}

function compactMessagePage(compacted: boolean) {
  const assistant = textMessage(
    "session-compact",
    "assistant-1",
    "assistant",
    "This conversation is above the manual compaction threshold.",
    { input: 90000, output: 500, reasoning: 60, cache_read: 0, cache_write: 0 },
  );

  if (compacted) {
    assistant.parts.splice(1, 0, {
      id: "session-compact-compaction",
      message_id: assistant.id,
      session_id: "session-compact",
      time_created: now,
      data: { type: "compaction", auto: false },
    });
  }

  return {
    total: 2,
    offset: 0,
    messages: [
      textMessage("session-compact", "user-1", "user", "Review this long context before we compress it."),
      assistant,
    ],
  };
}

function artifactToolPart(
  sessionId: string,
  messageId: string,
  callId: string,
  input: Record<string, unknown>,
  title = String(input.title ?? "Artifact"),
) {
  return {
    id: `${sessionId}-${callId}`,
    message_id: messageId,
    session_id: sessionId,
    time_created: "2026-04-23T11:05:00.000Z",
    data: {
      type: "tool",
      tool: "artifact",
      call_id: callId,
      state: {
        status: "completed",
        input,
        output: null,
        metadata: null,
        title,
        time_start: "2026-04-23T11:04:00.000Z",
        time_end: "2026-04-23T11:05:00.000Z",
        time_compacted: null,
      },
    },
  };
}

const artifactMessagePage = {
  total: 2,
  offset: 0,
  messages: [
    {
      id: "session-artifacts-user-1",
      session_id: "session-artifacts",
      time_created: "2026-04-23T11:00:00.000Z",
      data: { role: "user", agent: "build" },
      parts: [
        {
          id: "session-artifacts-user-part-1",
          message_id: "session-artifacts-user-1",
          session_id: "session-artifacts",
          time_created: "2026-04-23T11:00:00.000Z",
          data: { type: "text", text: "Create a release pack with docs, page, data, and diagrams." },
        },
      ],
    },
    {
      id: "session-artifacts-assistant-1",
      session_id: "session-artifacts",
      time_created: "2026-04-23T11:02:00.000Z",
      data: {
        role: "assistant",
        agent: "build",
        model_id: "openyak/best-free",
        provider_id: "openyak-proxy",
        cost: 0,
        finish: "stop",
      },
      parts: [
        {
          id: "session-artifacts-text-1",
          message_id: "session-artifacts-assistant-1",
          session_id: "session-artifacts",
          time_created: "2026-04-23T11:02:00.000Z",
          data: {
            type: "text",
            text:
              "I prepared the release pack and plan review artifacts.\n\nOffice files for review: `/Users/alex/openyak-demo/docs/office-brief.docx`, `/Users/alex/openyak-demo/data/office-matrix.xlsx`, `/Users/alex/openyak-demo/docs/office-report.pdf`, `/Users/alex/openyak-demo/slides/office-deck.pptx`, and `/Users/alex/openyak-demo/data/missing-report.xlsx`.",
          },
        },
        artifactToolPart("session-artifacts", "session-artifacts-assistant-1", "artifact-md", {
          command: "create",
          type: "markdown",
          title: "Release Brief",
          identifier: "release-brief",
          content: "# Release Brief\n\n- Validate desktop GUI workflows\n- Validate mobile handoff\n- Validate settings and extension surfaces",
        }),
        artifactToolPart("session-artifacts", "session-artifacts-assistant-1", "artifact-html", {
          command: "create",
          type: "html",
          title: "Demo Page",
          identifier: "demo-page",
          content: "<main><h1>OpenYak GUI Preflight</h1><p>End-to-end browser coverage.</p></main>",
        }),
        artifactToolPart("session-artifacts", "session-artifacts-assistant-1", "artifact-csv", {
          command: "create",
          type: "csv",
          title: "Coverage Matrix",
          identifier: "coverage-matrix",
          content: "workflow,status\nchat,covered\nsettings,covered\nmobile,covered",
        }),
        artifactToolPart("session-artifacts", "session-artifacts-assistant-1", "artifact-mermaid", {
          command: "create",
          type: "mermaid",
          title: "Workflow Diagram",
          identifier: "workflow-diagram",
          content: "flowchart TD\nA[Open GUI] --> B[Run workflow]\nB --> C[Assert user-visible result]",
        }),
        artifactToolPart("session-artifacts", "session-artifacts-assistant-1", "artifact-svg", {
          command: "create",
          type: "svg",
          title: "Logo Sketch",
          identifier: "logo-sketch",
          content: "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 120 80\"><rect width=\"120\" height=\"80\" rx=\"10\" fill=\"#0f172a\"/><text x=\"18\" y=\"46\" fill=\"white\" font-size=\"20\">OpenYak</text></svg>",
        }),
        {
          id: "session-artifacts-plan",
          message_id: "session-artifacts-assistant-1",
          session_id: "session-artifacts",
          time_created: "2026-04-23T11:05:30.000Z",
          data: {
            type: "tool",
            tool: "submit_plan",
            call_id: "plan-card-1",
            state: {
              status: "completed",
              input: {
                title: "GUI Preflight Plan",
                plan: "## Plan\n\n1. Run desktop workflows.\n2. Run settings workflows.\n3. Run mobile handoff workflows.",
                files_to_modify: ["frontend/tests/ui/openyak-preflight.spec.ts"],
              },
              output: null,
              metadata: {
                title: "GUI Preflight Plan",
                plan: "## Plan\n\n1. Run desktop workflows.\n2. Run settings workflows.\n3. Run mobile handoff workflows.",
                plan_path: "/Users/alex/openyak-demo/.openyak/plans/gui-preflight.md",
                files_to_modify: ["frontend/tests/ui/openyak-preflight.spec.ts"],
              },
              title: "GUI Preflight Plan",
              time_start: "2026-04-23T11:05:00.000Z",
              time_end: "2026-04-23T11:05:30.000Z",
              time_compacted: null,
            },
          },
        },
        {
          id: "session-artifacts-finish",
          message_id: "session-artifacts-assistant-1",
          session_id: "session-artifacts",
          time_created: "2026-04-23T11:06:00.000Z",
          data: {
            type: "step-finish",
            reason: "stop",
            tokens: { input: 3000, output: 900, reasoning: 120, cache_read: 0, cache_write: 0 },
            cost: 0,
          },
        },
      ],
    },
  ],
};

function seededSettings(options: OpenYakSeedOptions = {}) {
  return {
    state: {
      hasCompletedOnboarding: options.hasCompletedOnboarding ?? true,
      selectedModel: "openyak/best-free",
      selectedProviderId: "openyak-proxy",
      selectedAgent: "build",
      safeMode: false,
      workMode: "auto",
      reasoningEnabled: true,
      permissionPresets: { fileChanges: true, runCommands: true },
      savedPermissions: options.savedPermissions ?? [],
      workspaceDirectory: null,
      hasSeenHints: true,
      language: "en",
      activeProvider: "openyak",
    },
    version: 0,
  };
}

function seededAuth(options: OpenYakSeedOptions = {}) {
  const authConnected = options.authConnected ?? true;
  return {
    state: {
      proxyUrl: "https://proxy.test",
      accessToken: authConnected ? "access-token" : null,
      refreshToken: authConnected ? "refresh-token" : null,
      isConnected: authConnected,
      user: authConnected
        ? {
            id: "user-1",
            email: "tester@openyak.test",
            billing_mode: "credits",
            credit_balance: 1250,
            daily_free_tokens_used: 120000,
            daily_free_token_limit: 1000000,
          }
        : null,
    },
    version: 0,
  };
}

export async function seedOpenYakStorage(page: Page, options: OpenYakSeedOptions = {}) {
  const overwrite =
    options.force === true ||
    options.authConnected !== undefined ||
    options.hasCompletedOnboarding !== undefined ||
    options.savedPermissions !== undefined;
  await page.addInitScript(({ settings, auth, overwrite: shouldOverwrite }) => {
    const setValue = (key: string, value: string) => {
      if (shouldOverwrite || !window.localStorage.getItem(key)) {
        window.localStorage.setItem(key, value);
      }
    };

    setValue("openyak-settings", JSON.stringify(settings));
    setValue("openyak-auth", JSON.stringify(auth));
    setValue("openyak-language", "en");
    setValue(
      "openyak_remote_config",
      JSON.stringify({ url: window.location.origin, token: "remote-token" }),
    );
    setValue("openyak_remote_provider", "openrouter");
  }, { settings: seededSettings(options), auth: seededAuth(options), overwrite });
}

function fulfillJson(route: Route, body: unknown = {}) {
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify(body),
  });
}

function requestJson(request: Request) {
  try {
    return request.postDataJSON();
  } catch {
    return null;
  }
}

function xml(content: string) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${content}`;
}

function makePdfBase64() {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 420 240] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    "<< /Length 70 >>\nstream\nBT /F1 18 Tf 48 150 Td (OpenYak PDF workflow) Tj 0 -28 Td (Page 1) Tj ET\nendstream",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let body = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((obj, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefOffset = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  offsets.slice(1).forEach((offset) => {
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  });
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(body, "binary").toString("base64");
}

async function makeDocxBase64() {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    xml(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
        "</Types>",
    ),
  );
  zip.file(
    "_rels/.rels",
    xml(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
        "</Relationships>",
    ),
  );
  zip.file(
    "word/document.xml",
    xml(
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
        "<w:body>" +
        "<w:p><w:r><w:t>OpenYak DOCX workflow</w:t></w:r></w:p>" +
        "<w:p><w:r><w:t>Real Office preview path exercised by GUI preflight.</w:t></w:r></w:p>" +
        '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>' +
        "</w:body>" +
        "</w:document>",
    ),
  );
  return zip.generateAsync({ type: "base64" });
}

async function makeXlsxBase64() {
  const XLSX = await import("xlsx");
  const workbook = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet([
    ["Workflow", "Status"],
    ["Office XLSX", "Rendered"],
    ["Artifacts", "Covered"],
  ]);
  XLSX.utils.book_append_sheet(workbook, sheet, "Coverage");
  return XLSX.write(workbook, { bookType: "xlsx", type: "base64" }) as string;
}

async function makePptxBase64() {
  const { default: JSZip } = await import("jszip");
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    xml(
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/>' +
        '<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>' +
        '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>' +
        '<Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/>' +
        '<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/>' +
        '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' +
        "</Types>",
    ),
  );
  zip.file(
    "_rels/.rels",
    xml(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>' +
        "</Relationships>",
    ),
  );
  zip.file(
    "ppt/_rels/presentation.xml.rels",
    xml(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="slideMasters/slideMaster1.xml"/>' +
        "</Relationships>",
    ),
  );
  zip.file(
    "ppt/presentation.xml",
    xml(
      '<p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
        '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId2"/></p:sldMasterIdLst>' +
        '<p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst>' +
        '<p:sldSz cx="9144000" cy="5143500" type="screen16x9"/><p:notesSz cx="6858000" cy="9144000"/>' +
        "</p:presentation>",
    ),
  );
  zip.file(
    "ppt/slides/_rels/slide1.xml.rels",
    xml(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
        "</Relationships>",
    ),
  );
  zip.file(
    "ppt/slides/slide1.xml",
    xml(
      '<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
        '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>' +
        '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title 1"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="914400" y="914400"/><a:ext cx="7315200" cy="914400"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="3600"/><a:t>OpenYak PPTX workflow</a:t></a:r></a:p></p:txBody></p:sp>' +
        "</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>",
    ),
  );
  zip.file(
    "ppt/slideLayouts/_rels/slideLayout1.xml.rels",
    xml(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster" Target="../slideMasters/slideMaster1.xml"/>' +
        "</Relationships>",
    ),
  );
  zip.file(
    "ppt/slideLayouts/slideLayout1.xml",
    xml(
      '<p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank">' +
        '<p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>' +
        '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>',
    ),
  );
  zip.file(
    "ppt/slideMasters/_rels/slideMaster1.xml.rels",
    xml(
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme" Target="../theme/theme1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout" Target="../slideLayouts/slideLayout1.xml"/>' +
        "</Relationships>",
    ),
  );
  zip.file(
    "ppt/slideMasters/slideMaster1.xml",
    xml(
      '<p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">' +
        '<p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld>' +
        '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
        '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId2"/></p:sldLayoutIdLst><p:txStyles/></p:sldMaster>',
    ),
  );
  zip.file(
    "ppt/theme/theme1.xml",
    xml(
      '<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="Office Theme">' +
        '<a:themeElements><a:clrScheme name="Office"><a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1><a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="1F2937"/></a:dk2><a:lt2><a:srgbClr val="F8FAFC"/></a:lt2><a:accent1><a:srgbClr val="2563EB"/></a:accent1><a:accent2><a:srgbClr val="16A34A"/></a:accent2><a:accent3><a:srgbClr val="DC2626"/></a:accent3><a:accent4><a:srgbClr val="9333EA"/></a:accent4><a:accent5><a:srgbClr val="EA580C"/></a:accent5><a:accent6><a:srgbClr val="0891B2"/></a:accent6><a:hlink><a:srgbClr val="0000FF"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme>' +
        '<a:fontScheme name="Office"><a:majorFont><a:latin typeface="Arial"/></a:majorFont><a:minorFont><a:latin typeface="Arial"/></a:minorFont></a:fontScheme>' +
        '<a:fmtScheme name="Office"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="9525"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle/></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>',
    ),
  );
  return zip.generateAsync({ type: "base64" });
}

let officeFixturesPromise: Promise<Record<string, BinaryFixture>> | null = null;

async function getOfficeFixtures() {
  if (!officeFixturesPromise) {
    officeFixturesPromise = (async () => {
      const fixtures = [
        {
          name: "office-brief.docx",
          mime_type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          content_base64: await makeDocxBase64(),
        },
        {
          name: "office-matrix.xlsx",
          mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
          content_base64: await makeXlsxBase64(),
        },
        {
          name: "office-report.pdf",
          mime_type: "application/pdf",
          content_base64: makePdfBase64(),
        },
        {
          name: "office-deck.pptx",
          mime_type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          content_base64: await makePptxBase64(),
        },
      ];

      return Object.fromEntries(
        fixtures.map((fixture) => [
          fixture.name,
          {
            ...fixture,
            path: `/Users/alex/openyak-demo/${fixture.name}`,
            size: Buffer.from(fixture.content_base64, "base64").byteLength,
          },
        ]),
      );
    })();
  }
  return officeFixturesPromise;
}

function createdAutomation(body: Record<string, unknown> = {}) {
  return {
    id: body.id ?? "automation-new",
    name: body.name ?? "Morning brief",
    description: body.description ?? "Created in preflight",
    prompt: body.prompt ?? "Summarize new changes",
    schedule_config: body.schedule_config ?? { type: "interval", hours: 24, minutes: 0 },
    agent: body.agent ?? "build",
    model: body.model ?? null,
    workspace: body.workspace ?? null,
    enabled: body.enabled ?? true,
    template_id: null,
    last_run_at: body.last_run_at ?? null,
    last_run_status: body.last_run_status ?? null,
    last_session_id: body.last_session_id ?? null,
    next_run_at: body.next_run_at ?? "2026-04-27T12:00:00.000Z",
    run_count: body.run_count ?? 0,
    timeout_seconds: 3600,
    loop_max_iterations: null,
    loop_preset: null,
    loop_stop_marker: null,
    time_created: now,
    time_updated: now,
  };
}

function sseEvent(id: number, event: string, data: Record<string, unknown>) {
  return [`id: ${id}`, `event: ${event}`, `data: ${JSON.stringify(data)}`, ""].join("\n");
}

function sseStreamBody(streamId: string) {
  if (streamId.startsWith("stream-natural-")) {
    const kind = streamId.slice("stream-natural-".length) as NaturalOfficeKind;
    const text = naturalOfficeResponses[kind] ?? naturalOfficeResponses.memo;
    return [
      sseEvent(1, "text-delta", { text }),
      ...(kind === "board"
        ? [
            sseEvent(2, "tool-call", {
              call_id: "artifact-natural-board-md",
              tool: "artifact",
              status: "completed",
              title: "Board-ready Launch Brief",
            }),
            sseEvent(3, "tool-call", {
              call_id: "artifact-natural-board-mermaid",
              tool: "artifact",
              status: "completed",
              title: "Launch Decision Workflow",
            }),
          ]
        : []),
      sseEvent(kind === "board" ? 4 : 2, "step-finish", {
        reason: "stop",
        tokens: { input: 4200, output: 620, reasoning: 80 },
        cost: 0,
      }),
      sseEvent(kind === "board" ? 5 : 3, "done", { session_id: "session-new", finish_reason: "stop" }),
      "",
    ].join("\n");
  }

  if (streamId === "stream-manual-compact") {
    return [
      sseEvent(1, "compaction-start", { phases: ["prune", "summarize"] }),
      sseEvent(2, "compaction-phase", { phase: "prune", status: "started" }),
      sseEvent(3, "compaction-phase", { phase: "prune", status: "completed" }),
      sseEvent(4, "compaction-phase", { phase: "summarize", status: "started" }),
      sseEvent(5, "compaction-progress", { phase: "summarize", chars: 1800 }),
      sseEvent(6, "compaction-phase", { phase: "summarize", status: "completed" }),
      sseEvent(7, "compacted", { summary_created: true }),
      sseEvent(8, "done", { session_id: "session-compact", finish_reason: "stop" }),
      "",
    ].join("\n");
  }

  if (streamId === "stream-auto-compact") {
    return [
      sseEvent(1, "text-delta", { text: "I am checking the long context before answering." }),
      sseEvent(2, "compaction-start", { phases: ["prune", "summarize"] }),
      sseEvent(3, "compaction-phase", { phase: "prune", status: "started" }),
      sseEvent(4, "compaction-phase", { phase: "prune", status: "completed" }),
      sseEvent(5, "compaction-phase", { phase: "summarize", status: "started" }),
      sseEvent(6, "compaction-progress", { phase: "summarize", chars: 2200 }),
      sseEvent(7, "compaction-phase", { phase: "summarize", status: "completed" }),
      sseEvent(8, "compacted", { summary_created: true }),
      sseEvent(9, "text-delta", { text: " Auto compacted answer persisted after compression." }),
      sseEvent(10, "step-finish", {
        reason: "stop",
        tokens: { input: 24000, output: 220, reasoning: 20 },
        cost: 0,
      }),
      sseEvent(11, "done", { session_id: "session-new", finish_reason: "stop" }),
      "",
    ].join("\n");
  }

  if (streamId === "stream-permission") {
    return [
      sseEvent(1, "text-delta", { text: "I need approval before running the verification command." }),
      sseEvent(2, "permission-request", {
        call_id: "perm-run-tests",
        tool_call_id: "tool-run-tests",
        tool: "bash",
        permission: "bash",
        patterns: ["npm run preflight:ui"],
        arguments: {
          command: "npm run preflight:ui",
          cwd: "/Users/alex/openyak-demo/frontend",
        },
        message: "Allow running this shell command?\n\nnpm run preflight:ui",
        arguments_truncated: false,
      }),
      "",
    ].join("\n");
  }

  if (streamId === "stream-question") {
    return [
      sseEvent(1, "text-delta", { text: "I need one choice before continuing." }),
      sseEvent(2, "question", {
        call_id: "question-release-channel",
        tool: "question",
        arguments: {
          question: "Which release channel should this automation watch?",
          options: [
            { label: "Stable", description: "Only production-ready releases" },
            { label: "Beta", description: "Include preview releases" },
          ],
        },
      }),
      "",
    ].join("\n");
  }

  if (streamId === "stream-plan") {
    return [
      sseEvent(1, "text-delta", { text: "I drafted a plan for review." }),
      sseEvent(2, "plan-review", {
        call_id: "plan-review-gui",
        title: "Preflight implementation plan",
        plan: "## GUI Preflight\n\n1. Exercise desktop chat.\n2. Exercise settings.\n3. Exercise remote mobile.",
        files_to_modify: ["frontend/tests/ui/openyak-preflight.spec.ts", "frontend/tests/ui/fixtures/openyak-api.ts"],
      }),
      "",
    ].join("\n");
  }

  if (streamId === "stream-slow") {
    return [
      sseEvent(1, "text-delta", { text: "Starting a deliberately slow GUI stream." }),
      sseEvent(2, "reasoning-delta", { text: "Waiting for the user to test stop generation." }),
      "",
    ].join("\n");
  }

  if (streamId.startsWith("stream-edit-")) {
    const sessionId = streamId.slice("stream-edit-".length);
    return [
      sseEvent(1, "text-delta", { text: "Edited response streamed from the mock backend." }),
      sseEvent(2, "step-finish", {
        reason: "stop",
        tokens: { input: 20, output: 9, reasoning: 0 },
        cost: 0,
      }),
      sseEvent(3, "done", { session_id: sessionId, finish_reason: "stop" }),
      "",
    ].join("\n");
  }

  return [
    sseEvent(1, "text-delta", { text: "Preflight answer streamed from the mock backend." }),
    sseEvent(2, "step-finish", {
      reason: "stop",
      tokens: { input: 10, output: 8, reasoning: 0 },
      cost: 0,
    }),
    sseEvent(3, "done", { session_id: "session-new", finish_reason: "stop" }),
    "",
  ].join("\n");
}

export async function mockOpenYakApi(page: Page, options: OpenYakMockOptions = {}): Promise<OpenYakMockState> {
  const state: OpenYakMockState = {
    promptBodies: [],
    editBodies: [],
    chatResponses: [],
    abortRequests: [],
    automationCreates: [],
    automationUpdates: [],
    automationDeletes: [],
    automationRuns: [],
    connectorCreates: [],
    providerSaves: [],
    memoryUpdates: [],
    fileUploads: [],
    attachedPaths: [],
    binaryReads: [],
    compactRequests: [],
    sessionUpdates: [],
    sessionDeletes: [],
    sessionExports: [],
    remoteConfigUpdates: [],
    channelAdds: [],
    channelRemoves: [],
    authRequests: [],
    remoteEnabled: false,
  };
  const sessionRecords = new Map<string, SessionRecord>([
    [sessionAlpha.id, cloneJson(sessionAlpha)],
    [sessionBeta.id, cloneJson(sessionBeta)],
    [sessionArtifacts.id, cloneJson(sessionArtifacts)],
    [sessionLong.id, cloneJson(sessionLong)],
    [sessionCompact.id, cloneJson(sessionCompact)],
  ]);
  const automationList: AutomationMock[] = [
    createdAutomation({
      id: "automation-1",
      name: "Morning brief",
      description: "Summarize overnight workspace changes",
      prompt: "Create a concise morning brief",
      workspace: "/Users/alex/openyak-demo",
      last_run_at: "2026-04-26T09:00:00.000Z",
      last_run_status: "success",
      last_session_id: "session-alpha",
      run_count: 2,
    }),
  ];
  let remoteProviderInfoCalls = 0;

  const findAutomation = (id: string) => automationList.find((a) => a.id === id);
  const getSession = (id: string) =>
    id === createdSession.id
      ? cloneJson(createdSession)
      : cloneJson(sessionRecords.get(id) ?? sessionAlpha);
  const allSessions = () => [
    ...(state.promptBodies.length || state.editBodies.length ? [createdSession] : []),
    ...[sessionAlpha.id, sessionBeta.id, sessionArtifacts.id, sessionLong.id, sessionCompact.id]
      .filter((id) => !state.sessionDeletes.includes(id))
      .map((id) => cloneJson(sessionRecords.get(id)!)),
  ];

  const handler = async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();

    if (url.hostname === "proxy.test" || url.hostname === "api.open-yak.com") {
      if (path === "/api/auth/register" || path === "/api/auth/login") {
        state.authRequests.push(requestJson(request));
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Mocked auth failure" }),
        });
      }
      if (path === "/api/auth/resend") {
        state.authRequests.push(requestJson(request));
        return fulfillJson(route, { message: "sent" });
      }
      if (path === "/api/auth/verify") {
        state.authRequests.push(requestJson(request));
        return route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Invalid verification code" }),
        });
      }
      if (path === "/api/billing/balance") {
        return fulfillJson(route, {
          balance_usd: 12.5,
          credits: 1250,
          usd_equivalent: 12.5,
          daily_free_tokens_used: 120000,
          daily_free_token_limit: 1000000,
        });
      }
      if (path === "/api/billing/packs") {
        return fulfillJson(route, [
          { id: "starter", amount_usd: 1000, credits: 1000, price_usd: 10, label: "$10" },
        ]);
      }
      if (path === "/api/billing/transactions") {
        return fulfillJson(route, {
          total: 1,
          items: [
            {
              id: "tx-1",
              amount: -12,
              balance_after: 1250,
              type: "usage",
              description: "Chat: Best Free",
              metadata: null,
              time_created: now,
            },
          ],
        });
      }
      if (path === "/api/auth/refresh") {
        return fulfillJson(route, { access_token: "access-token", refresh_token: "refresh-token" });
      }
    }

    if (path.includes("/api/chat/stream/")) {
      const streamId = decodeURIComponent(path.split("/").pop() ?? "stream-ui-1");
      return route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/event-stream",
          "cache-control": "no-cache",
        },
        body: sseStreamBody(streamId),
      });
    }

    if (path === "/health") {
      if (options.healthStatus && options.healthStatus !== 200) {
        return route.fulfill({
          status: options.healthStatus,
          contentType: "application/json",
          body: JSON.stringify({ detail: options.healthStatus === 401 ? "Invalid token" : "Connection failed" }),
        });
      }
      return fulfillJson(route, { status: "ok" });
    }
    if (path === "/api/models") return fulfillJson(route, models);
    if (path === "/api/agents") return fulfillJson(route, [{ name: "build" }, { name: "plan" }]);
    if (path === "/api/tools") return fulfillJson(route, []);
    if (path === "/api/chat/active") return fulfillJson(route, options.activeJobs ?? []);
    if (path === "/api/config/api-key") {
      return fulfillJson(route, { is_configured: true, masked_key: "sk-or-...mock", is_valid: true });
    }
    if (path === "/api/config/openyak-account") {
      return method === "DELETE"
        ? fulfillJson(route, { success: true })
        : fulfillJson(route, { is_connected: true, proxy_url: "https://proxy.test", has_refresh_token: true });
    }
    if (path === "/api/config/openai-subscription/login") {
      if (options.openaiLoginStatus && options.openaiLoginStatus !== 200) {
        return route.fulfill({
          status: options.openaiLoginStatus,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Authentication launch unavailable" }),
        });
      }
      return fulfillJson(route, { auth_url: "https://chatgpt.test/auth" });
    }
    if (path === "/api/config/openai-subscription") {
      return fulfillJson(route, {
        is_connected: options.openaiSubscriptionConnected ?? true,
        email: options.openaiSubscriptionConnected === false ? "" : "chatgpt@openyak.test",
      });
    }
    if (path === "/api/config/local") {
      if (method !== "GET") {
        state.providerSaves.push(requestJson(request));
      }
      return fulfillJson(route, {
        base_url: "http://localhost:11434/v1",
        is_configured: true,
        is_connected: true,
        status: "connected",
      });
    }
    if (path === "/api/config/providers") {
      return fulfillJson(route, [
        {
          id: "openrouter",
          name: "OpenRouter",
          is_configured: true,
          enabled: true,
          masked_key: "sk-or-...mock",
          model_count: 1,
          status: "connected",
        },
        {
          id: "anthropic",
          name: "Anthropic",
          is_configured: false,
          enabled: false,
          masked_key: null,
          model_count: 0,
          status: "unconfigured",
        },
        {
          id: "custom_acme",
          name: "Acme Local Proxy",
          is_configured: true,
          enabled: true,
          masked_key: "sk-acme-...mock",
          base_url: "http://localhost:9888/v1",
          model_count: 1,
          status: "connected",
        },
      ]);
    }
    if (path.startsWith("/api/config/providers/")) {
      state.providerSaves.push(requestJson(request));
      return fulfillJson(route, { success: true });
    }
    if (path === "/api/config/custom" || path.startsWith("/api/config/custom/")) {
      state.providerSaves.push(method === "DELETE" ? { deleted: path } : requestJson(request));
      return fulfillJson(route, { success: true });
    }
    if (path === "/api/ollama/status") {
      if (options.ollamaStatusCode && options.ollamaStatusCode !== 200) {
        return route.fulfill({
          status: options.ollamaStatusCode,
          contentType: "application/json",
          body: JSON.stringify({ detail: "Ollama status unavailable" }),
        });
      }
      return fulfillJson(route, {
        binary_installed: false,
        running: false,
        port: 11434,
        base_url: null,
        version: null,
        models_dir: null,
        disk_usage_bytes: 0,
      });
    }
    if (path === "/api/usage") {
      return fulfillJson(route, {
        total_cost: 0.12,
        total_tokens: { input: 12000, output: 4200, reasoning: 900, cache_read: 0, cache_write: 0 },
        total_sessions: 2,
        total_messages: 8,
        avg_tokens_per_session: 8550,
        avg_response_time: 4.2,
        response_time: { avg: 4.2, median: 3.8, p95: 7.1, min: 1.1, max: 8.0, count: 4 },
        by_model: [
          {
            model_id: "openyak/best-free",
            provider_id: "openyak-proxy",
            total_cost: 0.12,
            total_tokens: { input: 12000, output: 4200, reasoning: 900, cache_read: 0, cache_write: 0 },
            message_count: 8,
          },
        ],
        by_session: [
          { session_id: "session-alpha", title: "Quarterly planning notes", total_cost: 0.12, total_tokens: 17100, message_count: 8, time_created: now },
        ],
        daily: [
          { date: "2026-04-24", cost: 0.04, tokens: 5000, messages: 2 },
          { date: "2026-04-25", cost: 0.08, tokens: 12100, messages: 6 },
        ],
      });
    }

    if (path === "/api/sessions/search") {
      const query = `${url.searchParams.get("q") ?? url.searchParams.get("query") ?? ""}`.toLowerCase();
      if (query.includes("long")) {
        return fulfillJson(route, [
          { session: getSession("session-long"), snippet: "Long conversation load test" },
          { session: getSession("session-compact"), snippet: "Context compression checkpoint" },
        ]);
      }
      if (state.promptBodies.length > 0 && query.includes("preflight")) {
        return fulfillJson(route, [
          { session: createdSession, snippet: "Create a UI preflight checklist" },
          { session: getSession("session-alpha"), snippet: "quarterly plan and retention" },
        ]);
      }
      return fulfillJson(route, [{ session: getSession("session-alpha"), snippet: "quarterly plan and retention" }]);
    }
    if (path === "/api/sessions" && method === "GET") {
      return fulfillJson(route, allSessions());
    }
    if (path === "/api/sessions" && method === "POST") return fulfillJson(route, createdSession);
    const sessionExportMatch = path.match(/^\/api\/sessions\/([^/]+)\/export-(pdf|md)$/);
    if (sessionExportMatch) {
      const [, sessionId, format] = sessionExportMatch;
      state.sessionExports.push(`${sessionId}.${format}`);
      if (format === "pdf") {
        return route.fulfill({
          status: 200,
          contentType: "application/pdf",
          headers: { "Content-Disposition": "attachment; filename=\"conversation.pdf\"" },
          body: Buffer.from("%PDF-1.4\n% OpenYak mock export\n%%EOF\n"),
        });
      }
      return route.fulfill({
        status: 200,
        contentType: "text/markdown",
        headers: { "Content-Disposition": "attachment; filename=\"conversation.md\"" },
        body: "# OpenYak mock export\n\nGUI session export exercised.",
      });
    }
    const sessionDetailMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionDetailMatch) {
      const sessionId = decodeURIComponent(sessionDetailMatch[1]);
      if (method === "PATCH") {
        const body = (requestJson(request) ?? {}) as Record<string, unknown>;
        state.sessionUpdates.push({ id: sessionId, ...body });
        if (sessionId !== createdSession.id) {
          const current = sessionRecords.get(sessionId) ?? cloneJson(sessionAlpha);
          sessionRecords.set(sessionId, {
            ...current,
            ...body,
            time_updated: now,
          });
        }
        return fulfillJson(route, getSession(sessionId));
      }
      if (method === "DELETE") {
        state.sessionDeletes.push(sessionId);
        return fulfillJson(route, { success: true });
      }
      return fulfillJson(route, getSession(sessionId));
    }
    if (path.endsWith("/todos")) {
      return fulfillJson(route, { todos: [{ content: "Draft outline", status: "completed" }] });
    }
    if (path.endsWith("/files")) {
      return fulfillJson(route, {
        files: [
          { name: "plan.md", path: "/Users/alex/openyak-demo/plan.md", type: "file", tool: "write" },
          { name: "office-brief.docx", path: "/Users/alex/openyak-demo/docs/office-brief.docx", type: "file", tool: "write" },
          { name: "office-matrix.xlsx", path: "/Users/alex/openyak-demo/data/office-matrix.xlsx", type: "file", tool: "write" },
          { name: "office-report.pdf", path: "/Users/alex/openyak-demo/docs/office-report.pdf", type: "file", tool: "write" },
          { name: "office-deck.pptx", path: "/Users/alex/openyak-demo/slides/office-deck.pptx", type: "file", tool: "write" },
        ],
      });
    }
    if (path.startsWith("/api/messages/")) {
      const sessionId = decodeURIComponent(path.split("/").pop() ?? "session-alpha");
      const limit = Number(url.searchParams.get("limit") ?? 50);
      const offset = Number(url.searchParams.get("offset") ?? -1);
      if (sessionId === "session-new") return fulfillJson(route, createdMessagePageForState(state));
      if (sessionId === "session-artifacts") return fulfillJson(route, artifactMessagePage);
      if (sessionId === "session-long") return fulfillJson(route, paginatedMessages(longConversationMessages, limit, offset));
      if (sessionId === "session-compact") return fulfillJson(route, compactMessagePage(state.compactRequests.length > 0));
      return fulfillJson(route, sessionMessagePageForState(sessionId, state));
    }
    if (path === "/api/chat/compact" && method === "POST") {
      const body = requestJson(request) as Record<string, unknown> | null;
      state.compactRequests.push(body);
      return fulfillJson(route, {
        stream_id: "stream-manual-compact",
        session_id: typeof body?.session_id === "string" ? body.session_id : "session-compact",
      });
    }
    if (path === "/api/chat/prompt" && method === "POST") {
      const body = requestJson(request) as Record<string, unknown> | null;
      const text = String(body?.text ?? "");
      state.promptBodies.push(body);
      const promptError = options.promptErrors?.find((error) =>
        text.toLowerCase().includes(error.match.toLowerCase()),
      );
      if (promptError) {
        return route.fulfill({
          status: promptError.status,
          contentType: "application/json",
          body: JSON.stringify({ detail: promptError.detail }),
        });
      }
      let streamId = "stream-ui-1";
      const naturalOfficeKind = naturalOfficeKindFromText(text);
      if (naturalOfficeKind) streamId = `stream-natural-${naturalOfficeKind}`;
      if (/auto compress/i.test(text)) streamId = "stream-auto-compact";
      if (/permission/i.test(text)) streamId = "stream-permission";
      if (/question/i.test(text)) streamId = "stream-question";
      if (/plan review/i.test(text)) streamId = "stream-plan";
      if (/slow stream|stop generation/i.test(text)) streamId = "stream-slow";
      return fulfillJson(route, { stream_id: streamId, session_id: "session-new" });
    }
    if (path === "/api/chat/edit" && method === "POST") {
      const body = requestJson(request) as Record<string, unknown> | null;
      state.editBodies.push(body);
      const sessionId = typeof body?.session_id === "string" ? body.session_id : "session-alpha";
      return fulfillJson(route, {
        stream_id: `stream-edit-${sessionId}`,
        session_id: sessionId,
      });
    }
    if (path === "/api/chat/respond") {
      state.chatResponses.push(requestJson(request));
      return fulfillJson(route, { success: true });
    }
    if (path === "/api/chat/abort") {
      state.abortRequests.push(requestJson(request));
      return fulfillJson(route, { success: true });
    }

    if (path === "/api/files/upload" && method === "POST") {
      const postData = request.postDataBuffer();
      const knownUploadNames = [
        "sample-preflight.csv",
        "broken-upload.txt",
        "customer-feedback-notes.docx",
        "budget-review.xlsx",
        "qbr-board-deck.pptx",
        "vendor-renewal-notes.pdf",
        "launch-readiness-memo.docx",
        "launch-budget.xlsx",
        "launch-board-deck.pptx",
        "vendor-terms-summary.pdf",
        "dragged-note.md",
      ];
      const filename =
        knownUploadNames.find((name) => postData?.includes(Buffer.from(name))) ?? "upload-preflight.txt";
      if (options.failUploads?.includes(filename)) {
        return route.fulfill({
          status: 500,
          contentType: "application/json",
          body: JSON.stringify({ detail: `Failed to store ${filename}` }),
        });
      }
      state.fileUploads.push(filename);
      return fulfillJson(route, {
        file_id: `file-${state.fileUploads.length}`,
        name: filename,
        path: `/tmp/openyak-ui/${filename}`,
        size: 128,
        mime_type: uploadedFilePart(filename, state.fileUploads.length - 1).data.mime_type,
        source: "uploaded",
        content_hash: `hash-${state.fileUploads.length}`,
      });
    }
    if (path === "/api/files/search") {
      return fulfillJson(route, [
        {
          name: "release-notes.md",
          relative_path: "docs/release-notes.md",
          absolute_path: "/Users/alex/openyak-demo/docs/release-notes.md",
        },
        {
          name: "preflight-matrix.csv",
          relative_path: "data/preflight-matrix.csv",
          absolute_path: "/Users/alex/openyak-demo/data/preflight-matrix.csv",
        },
      ]);
    }
    if (path === "/api/files/attach") {
      const body = requestJson(request) as { paths?: string[] } | null;
      state.attachedPaths.push(...(body?.paths ?? []));
      return fulfillJson(route, (body?.paths ?? []).map((filePath, index) => {
        const name = filePath.replace(/\\/g, "/").split("/").pop() ?? `file-${index}`;
        const isDirectory = name === "drag-folder" || !name.includes(".");
        const isImage = /\.(png|jpg|jpeg|gif|webp)$/i.test(name);
        return {
          file_id: `attached-${index}`,
          name,
          path: filePath,
          size: isDirectory ? 0 : 256,
          mime_type: isDirectory ? "inode/directory" : isImage ? "image/png" : name.endsWith(".csv") ? "text/csv" : "text/markdown",
          source: "referenced",
          content_hash: `attached-hash-${index}`,
        };
      }));
    }
    if (path === "/api/files/ingest") return fulfillJson(route, { success: true });
    if (path === "/api/files/content-binary") {
      const body = requestJson(request) as { path?: string } | null;
      const filePath = body?.path ?? "";
      const name = filePath.replace(/\\/g, "/").split("/").pop() ?? "";
      state.binaryReads.push(filePath);
      if (options.binaryFailures?.some((pattern) => filePath.includes(pattern) || name === pattern)) {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ detail: `File not found: ${filePath}` }),
        });
      }
      const fixtures = await getOfficeFixtures();
      const fixture = fixtures[name];
      if (!fixture) {
        return route.fulfill({
          status: 404,
          contentType: "application/json",
          body: JSON.stringify({ detail: `Unhandled binary fixture: ${filePath}` }),
        });
      }
      return fulfillJson(route, {
        ...fixture,
        path: filePath,
      });
    }
    if (path === "/api/files/content") {
      return fulfillJson(route, {
        content: "# plan.md\n\nWorkspace file preview loaded through the GUI.",
        mime_type: "text/markdown",
      });
    }
    if (path === "/api/files/browse-directory") {
      return fulfillJson(route, { path: "/Users/alex/openyak-demo" });
    }
    if (path === "/api/files/list-directory") {
      return fulfillJson(route, {
        path: "/Users/alex/openyak-demo",
        parent: "/Users/alex",
        entries: [
          { name: "docs", path: "/Users/alex/openyak-demo/docs", is_directory: true },
          { name: "src", path: "/Users/alex/openyak-demo/src", is_directory: true },
        ],
      });
    }

    if (path === "/api/automations" && method === "GET") {
      return fulfillJson(route, automationList);
    }
    if (path === "/api/automations" && method === "POST") {
      const body = requestJson(request) as Record<string, unknown>;
      state.automationCreates.push(body);
      const automation = createdAutomation({
        id: body.id ?? `automation-${state.automationCreates.length + 1}`,
        ...body,
      });
      automationList.unshift(automation);
      return fulfillJson(route, automation);
    }
    if (path === "/api/automations/templates") {
      return fulfillJson(route, [
        {
          id: "daily-brief",
          name: "Daily Brief",
          description: "Summarize new work every morning",
          prompt: "Summarize new work",
          schedule_config: { type: "cron", cron: "0 8 * * *" },
          category: "productivity",
          icon: "Sunrise",
        },
      ]);
    }
    if (path === "/api/automations/from-template") {
      const automation = createdAutomation({ id: "automation-template", name: "Daily Brief" });
      automationList.unshift(automation);
      return fulfillJson(route, automation);
    }
    const automationRunsMatch = path.match(/^\/api\/automations\/([^/]+)\/runs$/);
    if (automationRunsMatch) {
      const automationId = decodeURIComponent(automationRunsMatch[1]);
      return fulfillJson(route, [
        {
          id: "run-1",
          automation_id: automationId,
          status: findAutomation(automationId)?.last_run_status ?? "success",
          session_id: findAutomation(automationId)?.last_session_id ?? "session-alpha",
          triggered_by: state.automationRuns.includes(automationId) ? "manual" : "schedule",
          started_at: findAutomation(automationId)?.last_run_at ?? "2026-04-26T09:00:00.000Z",
          finished_at: "2026-04-26T09:01:00.000Z",
          error: null,
        },
        {
          id: "run-2",
          automation_id: automationId,
          status: "success",
          session_id: "session-alpha",
          triggered_by: "schedule",
          started_at: "2026-04-26T09:00:00.000Z",
          finished_at: "2026-04-26T09:01:00.000Z",
          error: null,
        },
      ]);
    }
    const automationRunMatch = path.match(/^\/api\/automations\/([^/]+)\/run$/);
    if (automationRunMatch) {
      const automationId = decodeURIComponent(automationRunMatch[1]);
      state.automationRuns.push(automationId);
      const automation = findAutomation(automationId);
      if (automation) {
        automation.last_run_at = now;
        automation.last_run_status = "success";
        automation.last_session_id = "session-alpha";
        automation.run_count = Number(automation.run_count ?? 0) + 1;
      }
      return fulfillJson(route, { status: "running" });
    }
    const automationDetailMatch = path.match(/^\/api\/automations\/([^/]+)$/);
    if (automationDetailMatch && method === "PATCH") {
      const automationId = decodeURIComponent(automationDetailMatch[1]);
      const body = (requestJson(request) ?? {}) as Record<string, unknown>;
      state.automationUpdates.push(body);
      const index = automationList.findIndex((a) => a.id === automationId);
      const updated = createdAutomation({
        ...(index >= 0 ? automationList[index] : {}),
        id: automationId,
        ...body,
      });
      if (index >= 0) automationList[index] = updated;
      else automationList.unshift(updated);
      return fulfillJson(route, updated);
    }
    if (automationDetailMatch && method === "DELETE") {
      const automationId = decodeURIComponent(automationDetailMatch[1]);
      state.automationDeletes.push(automationId);
      const index = automationList.findIndex((a) => a.id === automationId);
      if (index >= 0) automationList.splice(index, 1);
      return fulfillJson(route, { success: true });
    }
    if (path.startsWith("/api/automations/")) return fulfillJson(route, { success: true });

    if (path === "/api/connectors") {
      if (method === "POST") {
        state.connectorCreates.push(requestJson(request));
        return fulfillJson(route, { success: true });
      }
      return fulfillJson(route, {
        connectors: {
          github: {
            id: "github",
            name: "GitHub",
            url: "https://api.githubcopilot.com/mcp/",
            type: "remote",
            description: "Work with pull requests and issues",
            category: "dev-tools",
            enabled: true,
            connected: true,
            status: "connected",
            error: null,
            tools_count: 12,
            source: "builtin",
            referenced_by: ["github"],
          },
          notion: {
            id: "notion",
            name: "Notion",
            url: "https://mcp.notion.com/mcp",
            type: "remote",
            description: "Search and update pages",
            category: "productivity",
            enabled: false,
            connected: false,
            status: "disconnected",
            error: null,
            tools_count: 4,
            source: "builtin",
            referenced_by: [],
          },
        },
      });
    }
    if (path.startsWith("/api/connectors/")) {
      const connectorError = options.connectorErrors?.find((error) =>
        path.toLowerCase().includes(error.match.toLowerCase()),
      );
      if (connectorError) {
        return route.fulfill({
          status: connectorError.status,
          contentType: "application/json",
          body: JSON.stringify({ detail: connectorError.detail }),
        });
      }
      return fulfillJson(route, { success: true });
    }
    if (path === "/api/plugins/status") {
      return fulfillJson(route, {
        plugins: {
          github: {
            name: "github",
            version: "0.1.0",
            description: "GitHub workflows",
            author: "OpenYak",
            enabled: true,
            source: "builtin",
            skills_count: 3,
            mcp_count: 1,
          },
        },
      });
    }
    if (path.startsWith("/api/plugins/")) {
      return fulfillJson(route, {
        name: "github",
        version: "0.1.0",
        description: "GitHub workflows",
        author: "OpenYak",
        enabled: true,
        source: "builtin",
        skills_count: 3,
        mcp_count: 1,
        skills: [{ name: "gh-fix-ci", description: "Fix CI failures" }],
        connector_ids: ["github"],
      });
    }
    if (path === "/api/skills") {
      return fulfillJson(route, [
        { name: "browser", description: "Inspect local browser targets", location: "bundled/browser", source: "bundled", enabled: true },
        { name: "documents", description: "Create and edit documents", location: "bundled/documents", source: "bundled", enabled: false },
      ]);
    }
    if (path === "/api/skills/store/search") {
      return fulfillJson(route, {
        success: true,
        data: {
          skills: [
            {
              id: "browser",
              name: "browser",
              author: "OpenAI",
              description: "Browser automation skill",
              githubUrl: "https://github.com/openai/browser",
              skillUrl: "https://github.com/openai/browser/tree/main/browser",
              stars: 42,
              updatedAt: 1777224000000,
            },
          ],
          pagination: { page: 1, limit: 20, total: 1, totalPages: 1, hasNext: false, hasPrev: false },
        },
      });
    }
    if (path.startsWith("/api/skills/") || path === "/api/skills/install") return fulfillJson(route, { success: true, skills: [] });

    if (path === "/api/remote/status") {
      return fulfillJson(route, {
        enabled: state.remoteEnabled,
        tunnel_url: state.remoteEnabled ? "https://remote.openyak.test" : null,
        token_preview: state.remoteEnabled ? "remote..." : null,
        active_tasks: 1,
        tunnel_mode: "cloud",
        permission_mode: "auto",
      });
    }
    if (path === "/api/remote/enable") {
      state.remoteEnabled = true;
      return fulfillJson(route, { token: "remote-token", tunnel_url: "https://remote.openyak.test" });
    }
    if (path === "/api/remote/disable") {
      state.remoteEnabled = false;
      return fulfillJson(route, { success: true });
    }
    if (path === "/api/remote/rotate-token") return fulfillJson(route, { token: "rotated-token" });
    if (path === "/api/remote/config") {
      state.remoteConfigUpdates.push(requestJson(request));
      return fulfillJson(route, { success: true });
    }
    if (path === "/api/remote/provider-info") {
      const statuses = Array.isArray(options.remoteProviderInfoStatus)
        ? options.remoteProviderInfoStatus
        : options.remoteProviderInfoStatus
          ? [options.remoteProviderInfoStatus]
          : [];
      const status = statuses[Math.min(remoteProviderInfoCalls, statuses.length - 1)] ?? 200;
      remoteProviderInfoCalls += 1;
      if (status !== 200) {
        return route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify({ detail: status === 401 ? "Remote token expired" : "Desktop tunnel unavailable" }),
        });
      }
      return fulfillJson(route, { providers: ["openrouter"], primary: "openrouter" });
    }
    if (path === "/api/remote/qr") {
      return route.fulfill({ status: 200, contentType: "image/png", body: Buffer.from("") });
    }

    if (path === "/api/workspace-memory/list") {
      return fulfillJson(route, [
        {
          workspace_path: "/Users/alex/openyak-demo",
          content: "# Project Memory\nPrefer concise release notes.",
          line_count: 2,
          time_updated: now,
        },
      ]);
    }
    if (path === "/api/workspace-memory/export") return fulfillJson(route, { exported_to: "/tmp/openyak-memory.md" });
    if (path === "/api/workspace-memory/refresh") return fulfillJson(route, { status: "refreshed" });
    if (path === "/api/workspace-memory") {
      if (method === "GET") {
        return fulfillJson(route, {
          workspace_path: url.searchParams.get("workspace_path") ?? "/Users/alex/openyak-demo",
          content: "# Project Memory\nPrefer concise release notes.",
          time_updated: now,
        });
      }
      if (method === "PUT") {
        state.memoryUpdates.push(requestJson(request));
        return fulfillJson(route, { status: "updated" });
      }
      if (method === "DELETE") return fulfillJson(route, { removed: true });
      return fulfillJson(route, { success: true });
    }
    if (path === "/api/channels" || path === "/api/channels/status") return fulfillJson(route, { channels: {}, running: false });
    if (path === "/api/channels/add") {
      state.channelAdds.push(requestJson(request));
      return fulfillJson(route, { ok: true, message: "Connected" });
    }
    if (path === "/api/channels/remove") {
      state.channelRemoves.push(requestJson(request));
      return fulfillJson(route, { ok: true, message: "Disconnected" });
    }

    return route.fulfill({
      status: 404,
      contentType: "application/json",
      body: JSON.stringify({ detail: `Unhandled preflight mock: ${method} ${path}` }),
    });
  };

  await page.route("**/api/**", handler);
  await page.route("**/health", handler);
  await page.route("https://proxy.test/**", handler);
  await page.route("https://api.open-yak.com/**", handler);
  await page.route("http://localhost:8000/api/**", handler);

  return state;
}
