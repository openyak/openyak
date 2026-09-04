// Real workbench components with isolated data; host actions only record callbacks.
import React, { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { WorkbenchPanel } from '../src/renderer/src/WorkbenchPanel'
import { activateWorkbenchTab, activeTabForTask, closeWorkbenchTab, emptyWorkbenchState, openWorkbenchTab, projectFileTab, artifactTab } from '../src/renderer/src/workbenchTabs'
import '../src/renderer/src/styles.css'

const report = projectFileTab('qa', {
  path: '/workspace/Mac_配置评估报告.md', relativePath: 'Mac_配置评估报告.md', name: 'Mac_配置评估报告.md',
  extension: 'md', size: 3024, previewUrl: '', truncated: false,
  content: '# Mac 配置评估报告\n\n**生成日期：** 2026 年 9 月 4 日\n\n## 一、配置概览\n\n| 项目 | 配置 |\n| --- | --- |\n| 芯片 | Apple M4 Max |\n| 内存 | 128 GB |\n\n这是用于页签布局验证的示例报告。',
})
const code = projectFileTab('qa', {
  path: '/workspace/src/preview.ts', relativePath: 'src/preview.ts', name: 'preview.ts',
  extension: 'ts', size: 132, previewUrl: '', truncated: false, content: 'export const preview = "Ready"\n',
})
const artifact = artifactTab('qa', {
  path: '/workspace/NOTES.md', name: 'NOTES.md', extension: 'md', size: 80,
  previewUrl: '', truncated: false, content: '# Notes\n\nArtifact preview remains available.',
})
const longReport = projectFileTab('qa', {
  ...report.preview,
  path: '/workspace/reports/very-long-report-name-for-truncation-and-scroll-regression.md',
  name: 'very-long-report-name-for-truncation-and-scroll-regression.md',
  relativePath: 'reports/very-long-report-name-for-truncation-and-scroll-regression.md',
})
const themeRules = new Set<CSSMediaRule>()
function theme(dark: boolean) {
  for (const sheet of document.styleSheets) for (const rule of sheet.cssRules) {
    if (rule instanceof CSSMediaRule && rule.conditionText.includes('prefers-color-scheme')) themeRules.add(rule)
  }
  for (const rule of themeRules) rule.media.mediaText = dark ? 'all' : 'not all'
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light'
}
function Preview() {
  const [state, setState] = useState(() => openWorkbenchTab(emptyWorkbenchState(), report))
  const [width, setWidth] = useState('100%')
  const [action, setAction] = useState('')
  const active = activeTabForTask(state, 'qa')
  return <main style={{ height: '100vh', display: 'flex', flexDirection: 'column', padding: 12, gap: 12 }}>
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12 }}>
      <button onClick={() => setState(s => openWorkbenchTab(s, report))}>Open report</button>
      <button onClick={() => setState(s => openWorkbenchTab(s, code))}>Open code</button>
      <button onClick={() => setState(s => openWorkbenchTab(s, artifact))}>Open artifact</button>
      <button onClick={() => setState(s => openWorkbenchTab(s, longReport))}>Open long file</button>
      <label>Panel width <select value={width} onChange={e => setWidth(e.target.value)}><option value="100%">Full</option><option value="340px">Narrow</option></select></label>
      <label>Theme <select defaultValue="system" onChange={e => theme(e.target.value === 'dark')}><option value="system" disabled>System</option><option value="dark">Dark</option><option value="light">Light</option></select></label>
      <output aria-label="Last action">{action}</output>
    </div>
    <div style={{ width, maxWidth: '100%', flex: 1, minHeight: 0, display: 'grid', border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
      {active ? <WorkbenchPanel tabs={state.tabs} active={active}
        onSelect={key => setState(s => activateWorkbenchTab(s, key))}
        onClose={key => setState(s => closeWorkbenchTab(s, key))}
        onOpen={tab => setAction(`Open ${tab.label}`)}
        onReveal={tab => setAction(`Reveal ${tab.label}`)}
        onOpenPublished={() => setAction('Published')} /> : <p>No open files</p>}
    </div>
  </main>
}
createRoot(document.getElementById('root')!).render(<Preview />)
