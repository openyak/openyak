import assert from 'node:assert/strict'
import test from 'node:test'
import { agentHostProfiles } from '../src/main/agent-host-profiles.ts'

test('Claude host profile delegates prompts, tools, and skills to official presets', () => {
  const profile = agentHostProfiles() as {
    claude: {
      _meta: {
        systemPrompt: Record<string, unknown>
        claudeCode: { options: Record<string, unknown>; emitRawSDKMessages: unknown }
      }
    }
  }

  assert.deepEqual(profile.claude._meta.systemPrompt, {
    type: 'preset',
    preset: 'claude_code',
    snapshot: true,
  })
  assert.deepEqual(profile.claude._meta.claudeCode.options.tools, {
    type: 'preset',
    preset: 'claude_code',
  })
  assert.equal(profile.claude._meta.claudeCode.options.skills, 'all')
  assert.deepEqual(profile.claude._meta.claudeCode.emitRawSDKMessages, [{ type: 'user' }])
  assert.equal(typeof profile.claude._meta.systemPrompt.prompt, 'undefined')
})
