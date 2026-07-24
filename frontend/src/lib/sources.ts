import type { PartData, ToolPart } from "@/types/message";
import type { EvidenceOrigin } from "@/types/subagent";

export interface Source {
  url: string;
  title: string;
  snippet?: string;
  favicon?: string;
  domain: string;
  /** Direct producer metadata from source discovery, when available. */
  tool?: string;
  /** Every parent/child producer retained after URL deduplication. */
  origins?: EvidenceOrigin[];
}

const SENSITIVE_QUERY_KEYS = new Set([
  "accesstoken",
  "accesskeyid",
  "apikey",
  "apitoken",
  "appsecret",
  "auth",
  "authkey",
  "authtoken",
  "authorization",
  "awsaccesskeyid",
  "bearer",
  "clientkey",
  "clientsecret",
  "code",
  "credential",
  "idtoken",
  "githubtoken",
  "githubpat",
  "ghtoken",
  "jwt",
  "key",
  "oauthaccesstoken",
  "oauthrefreshtoken",
  "oauthtoken",
  "password",
  "passwordresettoken",
  "pat",
  "personalaccesstoken",
  "privatekey",
  "privateaccesstoken",
  "privatetoken",
  "refreshtoken",
  "sastoken",
  "secret",
  "secretkey",
  "secrettoken",
  "securitytoken",
  "sessiontoken",
  "sig",
  "signature",
  "signingsecret",
  "token",
  "webhooksecret",
  "webhooktoken",
  "xamzcredential",
  "xamzsecuritytoken",
  "xamzsignature",
  "xgoogcredential",
  "xgoogsignature",
  "xmscredential",
  "xmssignature",
]);
const SENSITIVE_PATH_KEYS = new Set([
  "accesstoken",
  "accesskeyid",
  "apikey",
  "apitoken",
  "auth",
  "authorization",
  "authtoken",
  "awsaccesskeyid",
  "clientsecret",
  "credential",
  "credentials",
  "idtoken",
  "oauthtoken",
  "password",
  "passwordresettoken",
  "personalaccesstoken",
  "privatekey",
  "privatetoken",
  "refreshtoken",
  "resetpassword",
  "secret",
  "secretkey",
  "secrettoken",
  "session",
  "sessiontoken",
  "token",
  "webhooksecret",
  "webhooktoken",
]);
const MAX_SOURCE_URL_CHARS = 4_096;
const SOURCE_TITLE_CHARS = 240;
const SOURCE_SNIPPET_CHARS = 600;
const SECRET_ASSIGNMENT =
  /\b(authorization|password|passphrase|api[-_ ]?(?:key|token)|access[-_ ]?(?:key[-_ ]?id|token)|aws[-_ ]?access[-_ ]?key[-_ ]?id|refresh[-_ ]?token|auth[-_ ]?token|id[-_ ]?token|oauth[-_ ]?token|github[-_ ]?(?:token|pat)|session[-_ ]?token|security[-_ ]?token|sas[-_ ]?token|personal[-_ ]?access[-_ ]?token|private[-_ ]?token|client[-_ ]?secret|signing[-_ ]?secret|webhook[-_ ]?secret|secret[-_ ]?key|private[-_ ]?key|jwt|bearer|token|secret|credential)\b\s*[:=]\s*(?:bearer\s+)?(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi;

function metadataKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function cleanSourceText(
  value: unknown,
  limit: number,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(SECRET_ASSIGNMENT, (_match, key: string) => `${key}=[redacted]`)
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  if (cleaned.length <= limit) return cleaned;
  return `${cleaned.slice(0, limit - 1).trimEnd()}…`;
}

function supportsLegacyStructuredSources(tool: string): boolean {
  const normalized = tool.toLowerCase();
  return (
    normalized === "web_search" ||
    normalized === "web_fetch" ||
    normalized.startsWith("mcp_")
  );
}

function hasSensitivePath(pathname: string): boolean {
  let segments: string[];
  try {
    segments = decodeURIComponent(pathname)
      .split("/")
      .filter(Boolean);
  } catch {
    return true;
  }
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index].trim();
    const assignment = segment.match(/^([^:=]+)[:=](.+)$/);
    if (
      assignment &&
      SENSITIVE_PATH_KEYS.has(metadataKey(assignment[1])) &&
      assignment[2].trim().length > 0
    ) {
      return true;
    }
    if (
      SENSITIVE_PATH_KEYS.has(metadataKey(segments[index])) &&
      index + 1 < segments.length &&
      segments[index + 1].trim().length > 0
    ) {
      return true;
    }
  }
  return false;
}

/** Validate and canonicalize the only URL shape rendered as an external link. */
export function canonicalizeExternalSourceUrl(url: string): string | null {
  if (
    !url ||
    url.length > MAX_SOURCE_URL_CHARS ||
    /[\u0000-\u001f\u007f]/.test(url)
  ) {
    return null;
  }
  try {
    const parsed = new URL(url.trim());
    const protocol = parsed.protocol.toLowerCase();
    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (
      (protocol !== "http:" && protocol !== "https:") ||
      !hostname ||
      /\s/.test(hostname) ||
      parsed.username ||
      parsed.password ||
      hasSensitivePath(parsed.pathname)
    ) {
      return null;
    }
    for (const key of parsed.searchParams.keys()) {
      if (SENSITIVE_QUERY_KEYS.has(metadataKey(key))) return null;
    }

    parsed.protocol = protocol;
    parsed.hostname = hostname;
    if (
      (protocol === "http:" && parsed.port === "80") ||
      (protocol === "https:" && parsed.port === "443")
    ) {
      parsed.port = "";
    }
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Only canonical, secret-free web URLs are interactive. */
export function isSafeExternalSourceUrl(url: string): boolean {
  return canonicalizeExternalSourceUrl(url) !== null;
}

interface SearchResult {
  url: string;
  title: string;
  snippet?: string;
}

const STRUCTURED_URL_KEYS = new Set([
  "url",
  "uri",
  "href",
  "link",
  "weburl",
  "permalink",
  "sourceurl",
  "canonicalurl",
  "externalurl",
  "pageurl",
  "documenturl",
]);
const STRUCTURED_TITLE_KEYS = ["title", "name", "label"] as const;
const STRUCTURED_SNIPPET_KEYS = [
  "snippet",
  "description",
  "summary",
] as const;
const MAX_STRUCTURED_DEPTH = 6;
const MAX_STRUCTURED_NODES = 250;
const MAX_STRUCTURED_SOURCES = 50;
const MAX_STRUCTURED_JSON_CHARS = 100_000;

function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function getFavicon(url: string): string {
  try {
    const domain = new URL(url).hostname;
    return `https://www.google.com/s2/favicons?sz=32&domain=${domain}`;
  } catch {
    return "";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function buildSource(
  url: unknown,
  title: unknown,
  snippet: unknown,
  tool: string,
): Source | null {
  if (typeof url !== "string") return null;
  const canonicalUrl = canonicalizeExternalSourceUrl(url);
  if (!canonicalUrl) return null;
  const domain = getDomain(canonicalUrl);
  const cleanTitle = cleanSourceText(title, SOURCE_TITLE_CHARS);
  return {
    url: canonicalUrl,
    title: cleanTitle ?? domain,
    snippet: cleanSourceText(snippet, SOURCE_SNIPPET_CHARS),
    favicon: getFavicon(canonicalUrl),
    domain,
    tool,
  };
}

function sourceEvidenceEnvelope(
  metadata: Record<string, unknown> | null,
  tool: string,
): Source[] | null {
  const envelope = metadata?.source_evidence;
  if (
    !isRecord(envelope) ||
    envelope.schema_version !== 1 ||
    !Array.isArray(envelope.items)
  ) {
    return null;
  }

  const sources: Source[] = [];
  const seen = new Set<string>();
  let inspectedItems = 0;
  for (const item of envelope.items) {
    if (inspectedItems >= MAX_STRUCTURED_SOURCES) break;
    inspectedItems += 1;
    if (!isRecord(item)) continue;
    const source = buildSource(item.url, item.title, item.snippet, tool);
    if (!source || seen.has(source.url)) continue;
    seen.add(source.url);
    sources.push(source);
  }
  return sources;
}

function firstString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function structuredKey(key: string): string {
  return key.toLowerCase().replaceAll("_", "").replaceAll("-", "");
}

function parseStructuredJsonOutput(output: string | null): unknown | null {
  if (!output) return null;
  const trimmed = output.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > MAX_STRUCTURED_JSON_CHARS ||
    (!trimmed.startsWith("{") && !trimmed.startsWith("["))
  ) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return parsed !== null && typeof parsed === "object" ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Discover explicit URL fields from bounded, structured connector metadata.
 * Ordinary strings are never URL-scanned; JSON strings are parsed only when
 * they are clearly serialized objects or arrays.
 */
function extractStructuredSources(
  metadata: unknown,
  tool: string,
): Source[] {
  const sources: Source[] = [];
  const seen = new Set<string>();
  let visitedNodes = 0;

  const addSource = (
    url: string,
    title?: string,
    snippet?: string,
  ) => {
    if (sources.length >= MAX_STRUCTURED_SOURCES) return;
    const source = buildSource(url, title, snippet, tool);
    if (!source || seen.has(source.url)) return;
    seen.add(source.url);
    sources.push(source);
  };

  const visit = (
    value: unknown,
    depth: number,
    inheritedTitle?: string,
    inheritedSnippet?: string,
    urlField = false,
  ) => {
    if (
      depth > MAX_STRUCTURED_DEPTH ||
      visitedNodes >= MAX_STRUCTURED_NODES ||
      sources.length >= MAX_STRUCTURED_SOURCES
    ) {
      return;
    }
    visitedNodes += 1;

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (urlField) {
        addSource(trimmed, inheritedTitle, inheritedSnippet);
        return;
      }
      if (
        trimmed.length <= MAX_STRUCTURED_JSON_CHARS &&
        (trimmed.startsWith("{") || trimmed.startsWith("["))
      ) {
        try {
          visit(JSON.parse(trimmed), depth + 1);
        } catch {
          // Structured-looking but invalid JSON is ordinary text, not evidence.
        }
      }
      return;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (
          visitedNodes >= MAX_STRUCTURED_NODES ||
          sources.length >= MAX_STRUCTURED_SOURCES
        ) {
          break;
        }
        visit(
          item,
          depth + 1,
          inheritedTitle,
          inheritedSnippet,
          urlField,
        );
      }
      return;
    }
    if (!value || typeof value !== "object") return;

    const record = value as Record<string, unknown>;
    const title = firstString(record, STRUCTURED_TITLE_KEYS) ?? inheritedTitle;
    const snippet =
      firstString(record, STRUCTURED_SNIPPET_KEYS) ?? inheritedSnippet;

    // Avoid Object.entries here: a connector can return an enormous object,
    // and eagerly materializing every pair would defeat the traversal budget.
    for (const key in record) {
      if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
      if (
        visitedNodes >= MAX_STRUCTURED_NODES ||
        sources.length >= MAX_STRUCTURED_SOURCES
      ) {
        break;
      }
      if (structuredKey(key) === "sourceevidence") continue;
      const child = record[key];
      const isUrlField = STRUCTURED_URL_KEYS.has(structuredKey(key));
      visit(child, depth + 1, title, snippet, isUrlField);
    }
  };

  visit(metadata, 0);
  return sources;
}

/**
 * Extract sources from a single tool part (web_search / web_fetch).
 */
export function extractSourcesFromTool(tool: ToolPart): Source[] {
  if (tool.state.status !== "completed") return [];
  const metadata = tool.state.metadata as Record<string, unknown> | null;
  const envelopeSources = sourceEvidenceEnvelope(metadata, tool.tool);
  if (envelopeSources !== null) return envelopeSources;

  const sources: Source[] = [];
  const seen = new Set<string>();
  const append = (source: Source | null) => {
    if (
      !source ||
      seen.has(source.url) ||
      sources.length >= MAX_STRUCTURED_SOURCES
    ) {
      return;
    }
    seen.add(source.url);
    sources.push(source);
  };

  if (tool.tool === "web_search" && metadata) {
    const results = metadata.results as SearchResult[] | undefined;
    if (Array.isArray(results)) {
      for (const r of results) {
        if (sources.length >= MAX_STRUCTURED_SOURCES) break;
        if (r.url) {
          append(buildSource(r.url, r.title, r.snippet, tool.tool));
        }
      }
    }
  } else if (tool.tool === "web_fetch" && metadata) {
    const url = metadata.url as string | undefined;
    if (url) {
      append(
        buildSource(
          url,
          tool.state.title?.replace(/^Fetched\s+/, ""),
          undefined,
          tool.tool,
        ),
      );
    }
  }

  // Legacy discovery is limited to tools whose contract actually returns
  // external web/connector evidence. Local read/shell JSON must never become
  // a Sources entry merely because it happens to contain a URL-shaped field.
  if (supportsLegacyStructuredSources(tool.tool)) {
    const structuredInputs = [
      metadata,
      parseStructuredJsonOutput(tool.state.output),
    ];
    for (const input of structuredInputs) {
      if (!input) continue;
      for (const source of extractStructuredSources(input, tool.tool)) {
        append(source);
      }
    }
  }

  return sources;
}

/**
 * Extract unique sources from tool parts (web_search + web_fetch).
 */
export function extractSources(parts: PartData[]): Source[] {
  const seen = new Set<string>();
  const sources: Source[] = [];

  for (const part of parts) {
    if (part.type !== "tool") continue;
    for (const s of extractSourcesFromTool(part as ToolPart)) {
      const canonicalUrl = canonicalizeExternalSourceUrl(s.url);
      if (!canonicalUrl || seen.has(canonicalUrl)) continue;
      seen.add(canonicalUrl);
      sources.push(
        canonicalUrl === s.url
          ? s
          : {
              ...s,
              url: canonicalUrl,
              domain: getDomain(canonicalUrl),
              favicon: getFavicon(canonicalUrl),
            },
      );
    }
  }

  return sources;
}
