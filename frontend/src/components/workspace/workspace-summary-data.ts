import { extractSources, type Source } from "@/lib/sources";
import type { WorkspaceFile } from "@/stores/workspace-store";
import type { FileAttachment } from "@/types/chat";
import type {
  AgentRunStatus,
  FilePart,
  MessageResponse,
  PartData,
} from "@/types/message";
import type {
  EvidenceOrigin,
  SubagentEvidenceOrigin,
  SubagentOutput,
  SubagentRun,
  SubagentSource,
  SubagentsResponse,
} from "@/types/subagent";

export interface SummaryInput {
  id: string;
  name: string;
  path: string;
  mimeType: string;
  source: "referenced" | "uploaded";
}

export interface TaskSummaryEvidence {
  sources: Source[];
  inputs: SummaryInput[];
}

export interface ParentEvidenceContext {
  sessionId: string;
  agentTitle: string;
  agent: string;
  status: AgentRunStatus;
}

function collectRuns(
  subagents: SubagentsResponse | null | undefined,
): SubagentRun[] {
  // Keep both live and settled snapshots. Evidence and origins are merged
  // independently below, so a terminal replay cannot erase earlier findings.
  return [...(subagents?.active ?? []), ...(subagents?.done ?? [])];
}

function normalizeOutputType(type: string): WorkspaceFile["type"] {
  if (
    type === "instructions" ||
    type === "uploaded" ||
    type === "referenced"
  ) {
    return type;
  }
  return "generated";
}

function outputKey(path: string, name: string): string {
  const normalizedPath = path.trim().replaceAll("\\", "/").replace(/\/+/g, "/");
  return normalizedPath || name.trim();
}

function originKey(origin: EvidenceOrigin): string {
  return [
    origin.source,
    origin.sessionId,
    origin.agentRunId ?? "",
    origin.agent,
    origin.tool ?? "",
  ].join("\u0000");
}

function mergeOrigins(
  ...originGroups: Array<EvidenceOrigin[] | undefined>
): EvidenceOrigin[] {
  const originByProducer = new Map<string, EvidenceOrigin>();
  for (const origins of originGroups) {
    for (const origin of origins ?? []) {
      originByProducer.set(originKey(origin), origin);
    }
  }
  return [...originByProducer.values()];
}

function parentOrigin(
  context: ParentEvidenceContext,
  tool: string | null,
  overrides: Partial<Pick<EvidenceOrigin, "sessionId" | "agent">> = {},
): EvidenceOrigin {
  return {
    sessionId: overrides.sessionId ?? context.sessionId,
    agentTitle: context.agentTitle,
    agent: overrides.agent ?? context.agent,
    status: context.status,
    tool,
    source: "parent",
  };
}

function childOrigin(
  run: SubagentRun,
  tool: string | null,
): EvidenceOrigin {
  return {
    sessionId: run.session_id,
    agentRunId: run.agent_run_id,
    agentTitle: run.title,
    agent: run.agent,
    status: run.status,
    tool,
    source: run.source,
  };
}

function childOrigins(
  run: SubagentRun,
  origins: SubagentEvidenceOrigin[] | undefined,
  fallbackTool: string | undefined,
): EvidenceOrigin[] {
  if (!origins?.length) {
    return [childOrigin(run, fallbackTool ?? null)];
  }
  return origins.map((origin) => ({
    sessionId: origin.session_id || run.session_id,
    agentRunId: origin.agent_run_id || run.agent_run_id,
    agentTitle: origin.agent_title || run.title,
    agent: run.agent,
    status: origin.status || run.status,
    tool: origin.tool || fallbackTool || null,
    source: run.source,
  }));
}

function outputWithLineage(
  output: SubagentOutput,
  run: SubagentRun,
): WorkspaceFile {
  return {
    name: output.name,
    path: output.path,
    type: normalizeOutputType(output.type),
    tool: output.tool,
    origins: childOrigins(run, output.origins, output.tool),
  };
}

/**
 * Merge parent files with delegated outputs without persisting child evidence
 * into the parent's session-local Workspace store.
 */
export function collectTaskSummaryOutputs(
  parentFiles: WorkspaceFile[],
  subagents: SubagentsResponse | null | undefined,
  parent: ParentEvidenceContext,
): WorkspaceFile[] {
  const fileByPath = new Map<string, WorkspaceFile>();

  for (const file of parentFiles) {
    fileByPath.set(outputKey(file.path, file.name), {
      ...file,
      origins: mergeOrigins(
        file.origins,
        [parentOrigin(parent, file.tool ?? null)],
      ),
    });
  }
  for (const run of collectRuns(subagents)) {
    for (const output of run.outputs ?? []) {
      if (!output?.name) continue;
      const childFile = outputWithLineage(output, run);
      const key = outputKey(childFile.path, childFile.name);
      const parentFile = fileByPath.get(key);
      fileByPath.set(
        key,
        parentFile
          ? {
              ...parentFile,
              origins: mergeOrigins(parentFile.origins, childFile.origins),
            }
          : childFile,
      );
    }
  }

  return [...fileByPath.values()];
}

function canonicalSourceKey(url: string): string {
  try {
    const normalized = new URL(url);
    normalized.hash = "";
    if (normalized.pathname.length > 1) {
      normalized.pathname = normalized.pathname.replace(/\/+$/, "");
    }
    return normalized.toString();
  } catch {
    return url.trim();
  }
}

function sourceWithLineage(
  source: SubagentSource,
  run: SubagentRun,
): Source {
  return {
    url: source.url,
    title: source.title,
    domain: source.domain,
    snippet: source.snippet,
    favicon: source.favicon,
    tool: source.tool,
    origins: childOrigins(run, source.origins, source.tool),
  };
}

function mergeSource(
  sourceByUrl: Map<string, Source>,
  source: Source,
  origins: EvidenceOrigin[],
) {
  const key = canonicalSourceKey(source.url);
  const existing = sourceByUrl.get(key);
  if (!existing) {
    sourceByUrl.set(key, {
      ...source,
      origins: mergeOrigins(source.origins, origins),
    });
    return;
  }

  // Preserve the first reader-facing identity. Later producers may fill
  // missing optional details, but never replace the existing source wholesale.
  sourceByUrl.set(key, {
    ...existing,
    snippet: existing.snippet ?? source.snippet,
    favicon: existing.favicon ?? source.favicon,
    tool: existing.tool ?? source.tool,
    origins: mergeOrigins(existing.origins, source.origins, origins),
  });
}

function toSummaryInput(
  file: FilePart | FileAttachment,
): SummaryInput {
  return {
    id: file.file_id,
    name: file.name,
    path: file.path,
    mimeType: file.mime_type,
    source: file.source ?? "uploaded",
  };
}

/**
 * Build the read-only evidence index shown in the task summary.
 *
 * Persisted messages remain the source of truth. Streaming sources and pending
 * attachments are layered on top so the summary stays useful while work is
 * still running, then naturally deduplicates once the turn is persisted.
 */
export function collectTaskSummaryEvidence(
  messages: MessageResponse[],
  streamingParts: PartData[] = [],
  pendingAttachments: FileAttachment[] = [],
  subagents?: SubagentsResponse | null,
  parent?: ParentEvidenceContext,
): TaskSummaryEvidence {
  const sourceByUrl = new Map<string, Source>();
  const inputByPath = new Map<string, SummaryInput>();

  for (const message of messages) {
    for (const source of extractSources(message.parts.map((part) => part.data))) {
      const fallbackParent: ParentEvidenceContext = parent ?? {
        sessionId: message.session_id,
        agentTitle: "Parent task",
        agent: message.data.agent ?? "primary",
        status: "completed",
      };
      mergeSource(sourceByUrl, source, [
        parentOrigin(fallbackParent, source.tool ?? null, {
          sessionId: message.session_id,
          agent: message.data.agent ?? fallbackParent.agent,
        }),
      ]);
    }

    if (message.data.role !== "user") continue;
    for (const part of message.parts) {
      if (part.data.type !== "file") continue;
      const input = toSummaryInput(part.data);
      inputByPath.set(input.path || input.id, input);
    }
  }

  for (const source of extractSources(streamingParts)) {
    const fallbackParent: ParentEvidenceContext = parent ?? {
      sessionId: messages[0]?.session_id ?? "parent",
      agentTitle: "Parent task",
      agent: "primary",
      status: "running",
    };
    mergeSource(sourceByUrl, source, [
      parentOrigin(fallbackParent, source.tool ?? null),
    ]);
  }
  for (const attachment of pendingAttachments) {
    const input = toSummaryInput(attachment);
    inputByPath.set(input.path || input.id, input);
  }
  for (const run of collectRuns(subagents)) {
    for (const source of run.sources ?? []) {
      if (!source?.url) continue;
      const childSource = sourceWithLineage(source, run);
      mergeSource(sourceByUrl, childSource, childSource.origins ?? []);
    }
  }

  return {
    sources: [...sourceByUrl.values()],
    inputs: [...inputByPath.values()],
  };
}
