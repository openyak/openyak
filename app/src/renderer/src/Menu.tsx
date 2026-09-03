import { useEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { IconCheck, IconChevronDown } from './icons'

export interface MenuItem {
  id: string
  label: string
  description?: string
  icon?: ReactNode
  checked?: boolean
  disabled?: boolean
  onSelect?: () => void
}

export type MenuEntry = MenuItem | { section: string } | { separator: true }

/** Close a popover on outside click or Escape while it is open. */
export function useDismiss(ref: RefObject<HTMLElement | null>, open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) close()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [ref, open, close])
}

interface Props {
  /** Contents of the trigger pill. */
  trigger: ReactNode
  entries: MenuEntry[]
  /** Which edge of the trigger the popover aligns to. */
  align?: 'start' | 'end'
  /** Popover opens above the trigger (composer) or below it (elsewhere). */
  side?: 'top' | 'bottom'
  className?: string
  /** Class for the trigger button; defaults to a pill. */
  triggerClassName?: string
  disabled?: boolean
  title?: string
  ariaLabel?: string
  /** Hide the chevron (icon-only triggers). */
  plain?: boolean
  /** Put each item's description on the same line as its label. */
  inlineDesc?: boolean
}

/**
 * A pill button that opens a small popover list. Closes on outside click, Escape, or
 * selection. No portal: the composer and sidebar have room for it.
 */
export function Menu({
  trigger,
  entries,
  align = 'start',
  side = 'top',
  className,
  triggerClassName = 'pill',
  disabled,
  title,
  ariaLabel,
  plain,
  inlineDesc,
}: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  useDismiss(ref, open, () => setOpen(false))

  return (
    <div className={`menu${className ? ` ${className}` : ''}`} ref={ref}>
      <button
        type="button"
        className={`${triggerClassName}${open ? ' pill-open' : ''}`}
        title={title}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
        {!plain && <IconChevronDown size={12} className="pill-chevron" />}
      </button>
      {open && (
        <div
          className={`popover popover-${side} popover-${align}${inlineDesc ? ' popover-inline' : ''}`}
          role="menu"
        >
          {entries.map((e, i) => {
            if ('separator' in e) return <div key={i} className="popover-separator" />
            if ('section' in e)
              return (
                <div key={i} className="popover-section">
                  {e.section}
                </div>
              )
            return (
              <button
                key={e.id}
                type="button"
                role="menuitemradio"
                aria-checked={!!e.checked}
                className={`popover-item${e.checked ? ' checked' : ''}`}
                disabled={e.disabled}
                onClick={() => {
                  setOpen(false)
                  e.onSelect?.()
                }}
              >
                {e.icon && <span className="popover-item-icon">{e.icon}</span>}
                <span className="popover-item-body">
                  <span className="popover-item-label">{e.label}</span>
                  {e.description && <span className="popover-item-desc">{e.description}</span>}
                </span>
                {e.checked && <IconCheck size={14} className="popover-item-check" />}
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
