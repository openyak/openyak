import { useEffect, useId, useRef } from 'react'
import { ArtifactPanel } from './ArtifactPanel'
import { IconClose, IconFile, IconFolder } from './icons'
import { ProjectFilePanel } from './ProjectFilePanel'
import type { WorkbenchTab } from './workbenchTabs'

interface Props {
  tabs: WorkbenchTab[]
  active: WorkbenchTab
  onSelect: (key: string) => void
  onClose: (key: string) => void
  onOpen: (tab: WorkbenchTab) => void
  onReveal: (tab: WorkbenchTab) => void
  onOpenPublished: (tab: WorkbenchTab) => void
}

export function WorkbenchPanel({
  tabs,
  active,
  onSelect,
  onClose,
  onOpen,
  onReveal,
  onOpenPublished,
}: Props) {
  const activeElement = useRef<HTMLDivElement>(null)
  const tabbar = useRef<HTMLDivElement>(null)
  const focusSelection = useRef(false)
  const id = useId()
  const bytes = active.preview.size
  const size = bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024
    ? `${Math.round(bytes / 1024)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  const metadata = active.kind === 'artifact' && active.preview.version
    ? `${size} · v${active.preview.version}` : size

  useEffect(() => {
    activeElement.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    if (focusSelection.current) {
      activeElement.current?.querySelector<HTMLButtonElement>('[role="tab"]')?.focus()
      focusSelection.current = false
    }
  }, [active.key, tabs.length])

  useEffect(() => {
    const element = tabbar.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      activeElement.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const moveSelection = (direction: -1 | 1) => {
    const index = tabs.findIndex((tab) => tab.key === active.key)
    const next = tabs[(index + direction + tabs.length) % tabs.length]
    if (next) {
      focusSelection.current = next.key !== active.key
      if (!focusSelection.current) activeElement.current?.querySelector<HTMLButtonElement>('[role="tab"]')?.focus()
      onSelect(next.key)
    }
  }

  return (
    <aside className="workbench-panel" aria-label={`File preview: ${active.label}`}>
      <header className="workbench-header titlebar">
      <div
        className="workbench-tabbar"
        ref={tabbar}
        role="tablist"
        aria-label="Open files"
        onKeyDown={(event) => {
          if (event.key === 'Home' || event.key === 'End') {
            event.preventDefault()
            const next = tabs[event.key === 'Home' ? 0 : tabs.length - 1]
            focusSelection.current = next.key !== active.key
            if (!focusSelection.current) activeElement.current?.querySelector<HTMLButtonElement>('[role="tab"]')?.focus()
            onSelect(next.key)
            return
          }
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
          event.preventDefault()
          moveSelection(event.key === 'ArrowLeft' ? -1 : 1)
        }}
      >
        {tabs.map((tab, index) => {
          const selected = tab.key === active.key
          const tabId = `${id}-tab-${index}`
          return (
            <div
              className={`workbench-tab${selected ? ' is-active' : ''}`}
              key={tab.key}
              ref={selected ? activeElement : undefined}
              title={tab.preview.path}
            >
              <button
                type="button"
                className="workbench-tab-select"
                role="tab"
                id={tabId}
                aria-controls={`${id}-panel`}
                aria-selected={selected}
                tabIndex={selected ? 0 : -1}
                onClick={() => onSelect(tab.key)}
              >
                <IconFile size={14} />
                <span>{tab.label}</span>
              </button>
              <button
                type="button"
                className="workbench-tab-close"
                onClick={() => { focusSelection.current = true; onClose(tab.key) }}
                aria-label={`Close ${tab.label}`}
              >
                <IconClose size={12} />
              </button>
            </div>
          )
        })}
      </div>
      <div className="workbench-actions">
        <span className="workbench-file-meta" title={`${active.preview.path} · ${metadata}`}>{metadata}</span>
        {active.kind === 'artifact' && active.preview.sourceUrl && (
          <button type="button" className="workbench-open" onClick={() => onOpenPublished(active)}>Published</button>
        )}
        <button type="button" className="icon-btn small" onClick={() => onReveal(active)} aria-label="Reveal in Finder" title={active.preview.path}>
          <IconFolder size={15} />
        </button>
        <button type="button" className="workbench-open" onClick={() => onOpen(active)}>Open</button>
      </div>
      </header>
      <div className="workbench-tabpanels">
        <section
          className="workbench-tabpanel"
          role="tabpanel"
          id={`${id}-panel`}
          aria-labelledby={`${id}-tab-${tabs.findIndex((tab) => tab.key === active.key)}`}
          key={active.key}
        >
          {active.kind === 'artifact' ? (
            <ArtifactPanel
              artifact={active.preview}
              onOpen={() => onOpen(active)}
            />
          ) : (
            <ProjectFilePanel
              file={active.preview}
              onOpen={() => onOpen(active)}
            />
          )}
        </section>
      </div>
    </aside>
  )
}
