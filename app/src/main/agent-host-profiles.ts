import type { NewSessionMeta } from '@agentclientprotocol/claude-agent-acp'

type ClaudeOptions = NonNullable<NonNullable<NewSessionMeta['claudeCode']>['options']>

/**
 * Desktop-host additions for ACP sessions.
 *
 * Provider-specific values live at this one adapter boundary. They are public
 * Claude Agent SDK options, not copied prompt text, private Desktop skills, or
 * an OpenYak-maintained tool list. Presets and discovery therefore continue to
 * follow the bundled Claude Code version automatically.
 */
export function agentHostProfiles(): Record<string, unknown> {
  const options = {
    tools: { type: 'preset', preset: 'claude_code' },
    skills: 'all',
    settings: { enableArtifact: true },
    extraArgs: { chrome: null },
  } satisfies ClaudeOptions

  const meta = {
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      snapshot: true,
    },
    claudeCode: {
      options,
      // Public adapter surface: only SDK user messages are needed because structured
      // `tool_use_result` lives on the user-side tool-result message. Core normalizes
      // those into provider-neutral artifact.* events and retains the raw envelope.
      emitRawSDKMessages: [{ type: 'user' }],
    },
  } satisfies NewSessionMeta & {
    systemPrompt: {
      type: 'preset'
      preset: 'claude_code'
      snapshot: true
    }
  }

  return {
    claude: {
      _meta: meta,
    },
  }
}
