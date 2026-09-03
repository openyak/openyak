import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { Project } from '../../shared/protocol'
import { useDismiss } from './Menu'
import { IconCheck, IconFolder, IconPlus, IconSearch } from './icons'

interface Props {
  projects: Project[]
  selectedId: string | null
  onChoose: (id: string) => void
  onAdd: () => void
}

export function ProjectPicker({ projects, selectedId, onChoose, onAdd }: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)
  const selected = projects.find((project) => project.id === selectedId) ?? null

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
  }, [])
  useDismiss(rootRef, open, close)

  useEffect(() => {
    if (!open) return
    const frame = requestAnimationFrame(() => searchRef.current?.focus())
    return () => cancelAnimationFrame(frame)
  }, [open])

  const normalizedQuery = query.trim().toLocaleLowerCase()
  const matches = normalizedQuery
    ? projects.filter((project) =>
        `${project.name}\n${project.path}`.toLocaleLowerCase().includes(normalizedQuery),
      )
    : projects

  const choose = (id: string) => {
    close()
    if (id !== selectedId) onChoose(id)
  }

  const moveFocus = (event: KeyboardEvent<HTMLElement>, direction: 1 | -1) => {
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')]
    if (buttons.length === 0) return
    event.preventDefault()
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
    const next = current < 0 ? (direction === 1 ? 0 : buttons.length - 1) : current + direction
    buttons[(next + buttons.length) % buttons.length]?.focus()
  }

  return (
    <div className="menu project-picker" ref={rootRef}>
      <button
        type="button"
        data-tooltip="Choose project"
        className={`chip project-picker-trigger${open ? ' pill-open' : ''}`}
        title={selected?.path ?? 'Choose the folder your agents will work in'}
        aria-label={`Project: ${selected?.name ?? 'none'}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          if (open) close()
          else setOpen(true)
        }}
      >
        <IconFolder size={15} />
        <span className="pill-label">{selected?.name ?? 'Choose project'}</span>
      </button>

      {open && (
        <div
          className="popover popover-top popover-start project-popover"
          role="dialog"
          aria-label="Choose project"
        >
          {projects.length > 0 && (
            <label className="project-search">
              <IconSearch size={16} />
              <input
                ref={searchRef}
                type="search"
                value={query}
                placeholder="Search projects"
                aria-label="Search projects"
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault()
                    listRef.current?.querySelector<HTMLButtonElement>('button')?.focus()
                  }
                  if (event.key === 'Enter' && matches[0]) {
                    event.preventDefault()
                    choose(matches[0].id)
                  }
                }}
              />
            </label>
          )}

          <div
            ref={listRef}
            className="project-list"
            role="listbox"
            aria-label="Projects"
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') moveFocus(event, 1)
              if (event.key === 'ArrowUp') moveFocus(event, -1)
            }}
          >
            {matches.map((project) => {
              const checked = project.id === selectedId
              return (
                <button
                  key={project.id}
                  type="button"
                  role="option"
                  aria-selected={checked}
                  className={`project-option${checked ? ' checked' : ''}`}
                  title={project.path}
                  onClick={() => choose(project.id)}
                >
                  <IconFolder size={17} />
                  <span>{project.name}</span>
                  {checked && <IconCheck size={15} className="project-check" />}
                </button>
              )
            })}
            {matches.length === 0 && (
              <div className="project-empty" role="status">
                {projects.length === 0 ? 'No projects yet' : 'No matching projects'}
              </div>
            )}
          </div>

          {projects.length > 0 && <div className="popover-separator project-separator" />}
          <button
            type="button"
            className="project-action"
            onClick={() => {
              close()
              onAdd()
            }}
          >
            <IconPlus size={16} />
            <span>New project</span>
          </button>
        </div>
      )}
    </div>
  )
}
