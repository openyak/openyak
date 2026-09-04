// Isolated browser harness: real component and normalizer, no agents or file writes.
import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { PermissionCard } from '../src/renderer/src/PermissionCard'
import { codexApproval } from '../src/main/runtime/approval'
import type { PermissionRequest } from '../src/shared/protocol'
import '../src/renderer/src/styles.css'

const file = codexApproval('item/fileChange/requestApproval', { reason: 'Create the report requested in this message.' }, {
  type: 'tool_call', id: 'file', title: 'fileChange', raw_input: { changes: [{ path: '/workspace/reports/live-report.md', diff: 'diff --git a/live-report.md b/live-report.md\n--- /dev/null\n+++ b/live-report.md\n@@ -0,0 +1,3 @@\n+# Report\n+\n+The report is ready.' }] },
})
const command = codexApproval('item/commandExecution/requestApproval', { command: 'pnpm test --filter report-preview', cwd: '/workspace/reports', reason: 'Verify the report preview.', availableDecisions: ['accept', 'acceptForSession', 'decline', 'cancel'] }, undefined)
const fixtures: Record<string, Partial<PermissionRequest>> = {
  Files: file, Command: command,
  Claude: { title: 'Allow Write?', tool_call: { rawInput: { file_path: '/workspace/report.md', content: '# Report' } }, options: [{ id: 'allow', label: 'Allow once', kind: 'allow_once' }, { id: 'deny', label: 'Decline', kind: 'reject_once' }] },
  Unsupported: codexApproval('item/commandExecution/requestApproval', { availableDecisions: [{ futurePermission: {} }] }, undefined),
}
// Electron uses nativeTheme to control this media query; the browser harness
// toggles the same stylesheet rule without duplicating production theme tokens.
const themeRules = new Set<CSSMediaRule>()
function previewTheme(dark: boolean) {
  for (const sheet of document.styleSheets) for (const rule of sheet.cssRules) {
    if (rule instanceof CSSMediaRule && rule.conditionText.includes('prefers-color-scheme')) themeRules.add(rule)
  }
  for (const rule of themeRules) rule.media.mediaText = dark ? 'all' : 'not all'
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}
function Preview() {
  useEffect(() => previewTheme(false), [])
  const [fixture, setFixture] = useState('Files')
  const [revision, setRevision] = useState(0)
  const [responses, setResponses] = useState<(string | null)[]>([])
  const [width, setWidth] = useState('768px')
  const request = { request_id: `${fixture}-${revision}`, task_id: 'qa', agent: 'codex', title: '', tool_call: {}, options: [], ...fixtures[fixture] } as PermissionRequest
  return <main style={{ padding: '32px 16px', width: '100%', overflow: 'auto', height: '100vh' }}>
    <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 32 }}>
      <label>Scenario <select value={fixture} onChange={e => { setFixture(e.target.value); setResponses([]) }}>{Object.keys(fixtures).map(name => <option key={name}>{name}</option>)}</select></label>
      <label>Width <select value={width} onChange={e => setWidth(e.target.value)}><option value="768px">Desktop</option><option value="340px">Narrow</option></select></label>
      <label>Theme <select onChange={e => previewTheme(e.target.value === 'dark')}><option value="light">Light</option><option value="dark">Dark</option></select></label>
      <button onClick={() => { setRevision(n => n + 1); setResponses([]) }}>Reset</button>
    </div>
    <div style={{ width: '100%', maxWidth: width, margin: 'auto' }}>
      <p style={{ color: 'var(--text-tertiary)', fontSize: 13, marginBottom: 20 }}>Working · Awaiting approval</p>
      <PermissionCard key={request.request_id} request={request} agentName={fixture === 'Claude' ? 'Claude Code' : 'Codex'} onChoose={id => setResponses(previous => [...previous, id])} />
      <output aria-label="Responses" style={{ display: 'block', marginTop: 24 }}>{JSON.stringify(responses)}</output>
      <textarea placeholder="Composer focus test" style={{ width: '100%', marginTop: 32 }} />
    </div>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
