import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type RefObject,
} from 'react'
import { createPortal } from 'react-dom'
import { IconCheck, IconChevronDown } from './icons'

export interface MenuItem {
  id: string
  label: string
  description?: string
  icon?: ReactNode
  checked?: boolean
  disabled?: boolean
  danger?: boolean
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
  /** Use the denser menu treatment for short action lists. */
  compact?: boolean
  onOpenChange?: (open: boolean) => void
}

interface MenuSurfaceProps {
  entries: MenuEntry[]
  className?: string
  inlineDesc?: boolean
  compact?: boolean
  style?: CSSProperties
  surfaceRef?: RefObject<HTMLDivElement | null>
  autoFocus?: boolean
  onSelect?: () => void
}

export function MenuSurface({
  entries,
  className,
  inlineDesc,
  compact,
  style,
  surfaceRef,
  autoFocus,
  onSelect,
}: MenuSurfaceProps) {
  useEffect(() => {
    if (!autoFocus) return
    surfaceRef?.current?.querySelector<HTMLButtonElement>('.popover-item:not(:disabled)')?.focus()
  }, [autoFocus, surfaceRef])

  return (
    <div
      ref={surfaceRef}
      className={`popover${compact ? ' popover-compact' : ''}${inlineDesc ? ' popover-inline' : ''}${className ? ` ${className}` : ''}`}
      role="menu"
      style={style}
    >
      {entries.map((entry, index) => {
        if ('separator' in entry)
          return <div key={index} className="popover-separator" role="separator" />
        if ('section' in entry)
          return (
            <div key={index} className="popover-section">
              {entry.section}
            </div>
          )
        return (
          <button
            key={entry.id}
            type="button"
            role={entry.checked === undefined ? 'menuitem' : 'menuitemradio'}
            aria-checked={entry.checked === undefined ? undefined : entry.checked}
            className={`popover-item${entry.checked ? ' checked' : ''}${entry.danger ? ' is-danger' : ''}`}
            disabled={entry.disabled}
            onClick={() => {
              onSelect?.()
              entry.onSelect?.()
            }}
          >
            {entry.icon && <span className="popover-item-icon">{entry.icon}</span>}
            <span className="popover-item-body">
              <span className="popover-item-label">{entry.label}</span>
              {entry.description && <span className="popover-item-desc">{entry.description}</span>}
            </span>
            {entry.checked && <IconCheck size={14} className="popover-item-check" />}
          </button>
        )
      })}
    </div>
  )
}

interface ContextMenuProps {
  entries: MenuEntry[]
  x: number
  y: number
  className?: string
  compact?: boolean
  autoFocus?: boolean
  onClose: () => void
}

/** A menu surface positioned at the pointer and kept inside the viewport. */
export function ContextMenu({
  entries,
  x,
  y,
  className,
  compact,
  autoFocus,
  onClose,
}: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: x, top: y })
  useDismiss(ref, true, onClose)

  useLayoutEffect(() => {
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    const gutter = 8
    setPosition({
      left: Math.max(gutter, Math.min(x, window.innerWidth - rect.width - gutter)),
      top: Math.max(gutter, Math.min(y, window.innerHeight - rect.height - gutter)),
    })
  }, [x, y])

  useEffect(() => {
    const dismiss = () => onClose()
    window.addEventListener('resize', dismiss)
    window.addEventListener('scroll', dismiss, true)
    return () => {
      window.removeEventListener('resize', dismiss)
      window.removeEventListener('scroll', dismiss, true)
    }
  }, [onClose])

  return createPortal(
    <MenuSurface
      entries={entries}
      compact={compact}
      className={`popover-context${className ? ` ${className}` : ''}`}
      style={position}
      surfaceRef={ref}
      autoFocus={autoFocus}
      onSelect={onClose}
    />,
    document.body,
  )
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
  compact,
  onOpenChange,
}: Props) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)
  const updateOpen = useCallback(
    (next: boolean) => {
      setOpen(next)
      onOpenChange?.(next)
    },
    [onOpenChange],
  )
  useDismiss(ref, open, () => updateOpen(false))

  return (
    <div className={`menu${className ? ` ${className}` : ''}`} ref={ref}>
      <button
        type="button"
        className={`${triggerClassName}${open ? ' pill-open' : ''}`}
        title={open ? undefined : title}
        aria-label={ariaLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => updateOpen(!open)}
      >
        {trigger}
        {!plain && <IconChevronDown size={12} className="pill-chevron" />}
      </button>
      {open && (
        <MenuSurface
          entries={entries}
          compact={compact}
          inlineDesc={inlineDesc}
          className={`popover-${side} popover-${align}`}
          onSelect={() => updateOpen(false)}
        />
      )}
    </div>
  )
}
