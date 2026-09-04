import assert from 'node:assert/strict'
import test from 'node:test'
import {
  artifactName,
  artifactsFromParts,
  shouldAutoPreviewArtifact,
} from '../src/renderer/src/artifactPresentation.ts'

test('consumes normalized artifact events and ignores provider tool calls', () => {
  assert.deepEqual(
    artifactsFromParts([
      {
        type: 'tool_call',
        id: 'provider-tool',
        title: 'Anything',
        kind: 'other',
        status: 'completed',
        raw_input: { file_path: '/tmp/guessed.html' },
        _meta: { claudeCode: { toolName: 'Artifact' } },
      },
      {
        type: 'event',
        kind: '_claude/sdkMessage',
        data: { message: { tool_use_result: { path: '/tmp/raw.html' } } },
      },
      {
        type: 'event',
        kind: 'artifact.created',
        data: {
          schema_version: 1,
          tool_call_id: 'tool-1',
          operation: 'publish',
          artifact: {
            id: 'artifact-1',
            path: '/tmp/report.html',
            url: 'https://claude.ai/code/artifact/artifact-1',
            title: 'Quarterly report',
            version: 'v1',
          },
        },
      },
      {
        type: 'event',
        kind: 'artifact.listed',
        data: {
          schema_version: 1,
          tool_call_id: 'tool-2',
          operation: 'list',
          artifacts: [{ title: 'Remote artifact', url: 'https://claude.ai/code/artifact/remote' }],
        },
      },
    ]),
    [
      {
        key: 'tool-1:artifact-1:v1',
        kind: 'artifact.created',
        operation: 'publish',
        artifact: {
          id: 'artifact-1',
          path: '/tmp/report.html',
          url: 'https://claude.ai/code/artifact/artifact-1',
          title: 'Quarterly report',
          version: 'v1',
        },
      },
      {
        key: 'tool-2:https://claude.ai/code/artifact/remote:',
        kind: 'artifact.listed',
        operation: 'list',
        artifact: { title: 'Remote artifact', url: 'https://claude.ai/code/artifact/remote' },
      },
    ],
  )
})

test('auto-preview uses the common local reference, not a provider payload', () => {
  assert.equal(shouldAutoPreviewArtifact({ path: '/tmp/dashboard.html' }), true)
  assert.equal(shouldAutoPreviewArtifact({ path: '/tmp/chart.PNG' }), true)
  assert.equal(shouldAutoPreviewArtifact({ path: '/tmp/component.tsx' }), false)
  assert.equal(shouldAutoPreviewArtifact({ url: 'https://example.com/artifact' }), false)
  assert.equal(artifactName({ title: 'Report', path: '/tmp/report.html' }), 'Report')
})
