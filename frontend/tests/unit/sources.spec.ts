import { expect, test } from "@playwright/test";
import {
  extractSources,
  extractSourcesFromTool,
  isSafeExternalSourceUrl,
} from "../../src/lib/sources";
import type { ToolPart } from "../../src/types/message";

function completedTool(
  metadata: Record<string, unknown> | null,
  output = "Ordinary output mentioning https://ignored.example/output",
  tool = "mcp__connector__search",
): ToolPart {
  return {
    type: "tool",
    tool,
    call_id: "connector-1",
    state: {
      status: "completed",
      input: {},
      output,
      metadata,
      title: "Connector search",
      time_start: null,
      time_end: null,
      time_compacted: null,
    },
  };
}

test("extracts bounded structured connector links without guessing from text", () => {
  const sources = extractSourcesFromTool(
    completedTool({
      records: [
        {
          name: "Connector guide",
          description: "Authoritative connector evidence.",
          href: "https://docs.example.com/connector",
        },
      ],
      serialized: JSON.stringify({
        result: {
          title: "Release record",
          link: "https://records.example.com/release",
        },
      }),
      note: "Read https://ignored.example/note next.",
      unsafe: {
        title: "Credential URL",
        url: "https://user:secret@example.com/private",
      },
    }),
  );

  expect(sources).toEqual([
    {
      url: "https://docs.example.com/connector",
      title: "Connector guide",
      snippet: "Authoritative connector evidence.",
      favicon:
        "https://www.google.com/s2/favicons?sz=32&domain=docs.example.com",
      domain: "docs.example.com",
      tool: "mcp__connector__search",
    },
    {
      url: "https://records.example.com/release",
      title: "Release record",
      snippet: undefined,
      favicon:
        "https://www.google.com/s2/favicons?sz=32&domain=records.example.com",
      domain: "records.example.com",
      tool: "mcp__connector__search",
    },
  ]);
});

test("extracts explicit source keys from JSON tool output with empty metadata", () => {
  const sources = extractSourcesFromTool(
    completedTool(
      null,
      JSON.stringify({
        results: [
          {
            title: "MCP page",
            webUrl: "https://mcp.example.com/page",
          },
          {
            name: "Canonical record",
            canonicalUrl: "https://records.example.com/canonical",
          },
          {
            label: "Permalinked issue",
            permalink: "https://issues.example.com/issue/42",
          },
          {
            title: "Source document",
            sourceUrl: "https://docs.example.com/source",
          },
        ],
      }),
    ),
  );

  expect(sources.map(({ url, title }) => ({ url, title }))).toEqual([
    { url: "https://mcp.example.com/page", title: "MCP page" },
    {
      url: "https://records.example.com/canonical",
      title: "Canonical record",
    },
    {
      url: "https://issues.example.com/issue/42",
      title: "Permalinked issue",
    },
    { url: "https://docs.example.com/source", title: "Source document" },
  ]);
});

test("does not guess sources from ordinary non-JSON tool output", () => {
  expect(
    extractSourcesFromTool(
      completedTool(
        null,
        "Review https://ignored.example/plain-text before continuing.",
      ),
    ),
  ).toEqual([]);
});

test("treats a valid source_evidence envelope as authoritative", () => {
  const sources = extractSourcesFromTool(
    completedTool(
      {
        source_evidence: {
          schema_version: 1,
          items: [
            {
              url: "HTTPS://EXAMPLE.COM:443/reference#envelope",
              title: "Envelope source",
              snippet: "Persisted before raw output truncation.",
            },
            {
              url: "https://example.com/private?access_token=secret",
              title: "Rejected signed source",
            },
            { title: "Malformed item without a URL" },
          ],
        },
        raw: {
          url: "https://example.com/reference#raw-metadata",
        },
      },
      JSON.stringify({
        webUrl: "https://raw.example.com/from-output",
      }),
    ),
  );

  expect(sources.map(({ url, title, snippet }) => ({ url, title, snippet })))
    .toEqual([
      {
        url: "https://example.com/reference",
        title: "Envelope source",
        snippet: "Persisted before raw output truncation.",
      },
    ]);

  expect(
    extractSourcesFromTool(
      completedTool({
        source_evidence: { schema_version: 1, items: [] },
        raw: { url: "https://must-not-revive.example.com" },
      }),
    ),
  ).toEqual([]);
});

test("rejects secret-bearing and non-web URLs in legacy and direct branches", () => {
  for (const unsafeUrl of [
    "https://example.com/private?token=secret",
    "https://example.com/private?access_token=secret",
    "https://example.com/private?X-Amz-Signature=secret",
    "https://example.com/private?key=secret",
    "https://example.com/private?code=secret",
    "https://example.com/private?refresh_token=secret",
    "https://example.com/private?auth-token=secret",
    "https://example.com/private?AWSAccessKeyId=secret",
    "https://example.com/private?access_key_id=secret",
    "https://example.com/private?session_token=secret",
    "https://example.com/private?security-token=secret",
    "https://example.com/private?secret_key=secret",
    "https://example.com/private?jwt=secret",
    "https://example.com/private?bearer=secret",
    "https://example.com/private?sas_token=secret",
    "https://example.com/private?oauth_token=secret",
    "https://example.com/private?github_token=secret",
    "https://example.com/private?github_pat=secret",
    "https://example.com/private?gh_token=secret",
    "https://example.com/private?api_token=secret",
    "https://example.com/private?personal_access_token=secret",
    "https://example.com/private?private_token=secret",
    "https://example.com/private?password_reset_token=secret",
    "https://example.com/private?signing_secret=secret",
    "https://example.com/auth/private",
    "https://example.com/authorization/private",
    "https://example.com/id_token/private",
    "https://example.com/client_secret/private",
    "https://example.com/token=private",
    "https://example.com/token:private",
    "https://example.com/%74oken%2Fprivate",
    "https://example.com/api/token/secret-value",
    "https://example.com/api/secret/secret-value",
    "https://example.com/api/session/secret-value",
    "https://example.com/api/credential/secret-value",
    "https://example.com/reset-password/private-value",
    "https://example.com/oauth/access_token/private-value",
    "https://example.com/api/credentials/private-value",
    "https://example.com/api/%74oken/secret-value",
    "https://user:secret@example.com/private",
    "data:text/html,unsafe",
    "file:///tmp/unsafe",
  ]) {
    expect(isSafeExternalSourceUrl(unsafeUrl)).toBe(false);
  }
  for (const safeUrl of [
    "https://example.com/docs/reset-password",
    "https://example.com/docs/token-economy",
    "https://example.com/oauth/token",
  ]) {
    expect(isSafeExternalSourceUrl(safeUrl)).toBe(true);
  }

  expect(
    extractSourcesFromTool(
      completedTool(
        {
          results: [
            {
              url: "https://example.com/private?x-amz-signature=secret",
              title: "Signed result",
            },
            {
              url: "data:text/html,unsafe",
              title: "Data result",
            },
          ],
        },
        "",
        "web_search",
      ),
    ),
  ).toEqual([]);

  expect(
    extractSourcesFromTool(
      completedTool(
        { url: "file:///tmp/unsafe" },
        "",
        "web_fetch",
      ),
    ),
  ).toEqual([]);
});

test("canonicalizes URLs before deduplicating across tool parts", () => {
  const first = completedTool(
    {
      source_evidence: {
        schema_version: 1,
        items: [
          {
            url: "HTTPS://EXAMPLE.COM:443/release#first",
            title: "Canonical release",
          },
        ],
      },
    },
    "",
  );
  const second = completedTool(
    null,
    JSON.stringify({
      canonicalUrl: "https://example.com/release#second",
      title: "Raw duplicate",
    }),
  );

  expect(extractSources([first, second])).toHaveLength(1);
  expect(extractSources([first, second])[0]).toMatchObject({
    url: "https://example.com/release",
    title: "Canonical release",
  });
});

test("bounds authoritative envelope inspection without falling back to raw data", () => {
  const sources = extractSourcesFromTool(
    completedTool({
      source_evidence: {
        schema_version: 1,
        items: Array.from({ length: 75 }, (_, index) => ({
          url: `https://evidence.example.com/item/${index}`,
          title: `Evidence ${index}`,
        })),
      },
      raw: { url: "https://must-not-revive.example.com" },
    }),
  );

  expect(sources).toHaveLength(50);
  expect(sources.at(-1)?.title).toBe("Evidence 49");
  expect(
    sources.some((source) => source.url.includes("must-not-revive")),
  ).toBe(false);
});

test("cleans secret assignments from authoritative titles and snippets", () => {
  const [source] = extractSourcesFromTool(
    completedTool({
      source_evidence: {
        schema_version: 1,
        items: [
          {
            url: "https://evidence.example.com/safe",
            title: "Release password=hunter2",
            snippet:
              "oauth_token=oauth-secret idToken=id-secret AWSAccessKeyId=aws-secret private_token=private-secret personal_access_token=pat-secret Authorization: Bearer bearer-secret useful evidence",
          },
        ],
      },
    }),
  );

  expect(source.title).toContain("password=[redacted]");
  expect(source.snippet).toContain("oauth_token=[redacted]");
  expect(source.snippet).toContain("Authorization=[redacted]");
  expect(`${source.title} ${source.snippet}`).not.toMatch(
    /hunter2|oauth-secret|id-secret|aws-secret|private-secret|pat-secret|bearer-secret/,
  );
});

test("does not infer Sources from local read or bash JSON output", () => {
  const output = JSON.stringify({
    title: "Local config",
    url: "https://must-not-become-source.example.com",
  });

  for (const tool of [
    "read",
    "bash",
    "code_execute",
    "search",
    "research",
    "http_debug",
    "browser_log",
  ]) {
    expect(extractSourcesFromTool(completedTool(null, output, tool))).toEqual(
      [],
    );
  }
});

test("structured fallback stops at its actual node budget for huge containers", () => {
  const hugeRecord: Record<string, unknown> = {
    first: {
      title: "Early dictionary source",
      url: "https://budget.example.com/dictionary",
    },
  };
  for (let index = 0; index < 300_000; index += 1) {
    hugeRecord[`padding_${index}`] = index;
  }
  const hugeList = new Array<unknown>(1_000_000).fill(null);
  hugeList[0] = {
    title: "Early list source",
    url: "https://budget.example.com/list",
  };

  const dictionarySources = extractSourcesFromTool(
    completedTool({ payload: hugeRecord }),
  );
  const listSources = extractSourcesFromTool(
    completedTool({ payload: hugeList }),
  );

  expect(dictionarySources.map((source) => source.title)).toEqual([
    "Early dictionary source",
  ]);
  expect(listSources.map((source) => source.title)).toEqual([
    "Early list source",
  ]);
});
