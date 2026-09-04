import { useEffect, useId, useRef } from 'react'
import { ArtifactPanel } from './ArtifactPanel'
import { IconClose, IconFile } from './icons'
import { ProjectFilePanel } from './ProjectFilePanel'
import type { WorkbenchTab } from './workbenchTabs'

interface Props {
  tabs: WorkbenchTab[]
  active: WorkbenchTab
  projectName?: string
  onSelect: (key: string) => void
  onClose: (key: string) => void
  onOpen: (tab: WorkbenchTab) => void
  onReveal: (tab: WorkbenchTab) => void
  onOpenPublished: (tab: WorkbenchTab) => void
}

export function WorkbenchPanel({
  tabs,
  active,
  projectName,
  onSelect,
  onClose,
  onOpen,
  onReveal,
  onOpenPublished,
}: Props) {
  const activeElement = useRef<HTMLDivElement>(null)
  const id = useId()

  useEffect(() => {
    activeElement.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }, [active.key])

  const moveSelection = (direction: -1 | 1) => {
    const index = tabs.findIndex((tab) => tab.key === active.key)
    const next = tabs[(index + direction + tabs.length) % tabs.length]
    if (next) onSelect(next.key)
  }

  return (
    <aside className="workbench-panel" aria-label={`File preview: ${active.label}`}>
      <div
        className="workbench-tabbar titlebar"
        role="tablist"
        aria-label="Open files"
        onKeyDown={(event) => {
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
                onClick={() => onClose(tab.key)}
                aria-label={`Close ${tab.label}`}
              >
                <IconClose size={12} />
              </button>
            </div>
          )
        })}
      </div>
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
              onClose={() => onClose(active.key)}
              onOpen={() => onOpen(active)}
              onReveal={() => onReveal(active)}
              onOpenPublished={active.preview.sourceUrl ? () => onOpenPublished(active) : undefined}
            />
          ) : (
            <ProjectFilePanel
              file={active.preview}
              projectName={projectName}
              onClose={() => onClose(active.key)}
              onOpen={() => onOpen(active)}
              onReveal={() => onReveal(active)}
            />
          )}
        </section>
      </div>
    </aside>
  )
}
