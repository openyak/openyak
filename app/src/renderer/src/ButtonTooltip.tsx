import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

interface ActiveTooltip {
  button: HTMLButtonElement
  text: string
}

interface TooltipPosition {
  left: number
  top: number
  side: 'top' | 'bottom'
}

const compact = (value: string) => {
  const text = value.replace(/\s+/g, ' ').trim()
  if (!text) return null
  return text.length > 88 ? `${text.slice(0, 85)}…` : text
}

function buttonTooltip(button: HTMLButtonElement): string | null {
  const explicit = button.dataset.tooltip
  if (explicit) return compact(explicit)

  const accessibleName = button.getAttribute('aria-label')
  if (accessibleName) return compact(accessibleName)

  const title = button.getAttribute('title')
  if (title && !/^[-a-z]+(?:_[-a-z]+)+$/i.test(title)) return compact(title)

  const menuLabel = button.querySelector<HTMLElement>('.popover-item-label')?.innerText
  if (menuLabel) return compact(menuLabel)

  return compact(button.innerText)
}

/**
 * One consistent tooltip layer for every button in the renderer. Event delegation keeps
 * buttons lightweight and also covers controls mounted later inside menus and dialogs.
 */
export function ButtonTooltip() {
  const tooltipId = useId()
  const tooltipRef = useRef<HTMLDivElement>(null)
  const targetRef = useRef<HTMLButtonElement | null>(null)
  const timerRef = useRef<number | null>(null)
  const nativeTitleRef = useRef<string | null>(null)
  const pointerDownAt = useRef(0)
  const [active, setActive] = useState<ActiveTooltip | null>(null)
  const [position, setPosition] = useState<TooltipPosition | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current === null) return
    window.clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  const restoreNativeTitle = useCallback(() => {
    const target = targetRef.current
    if (target && nativeTitleRef.current !== null && target.isConnected) {
      target.setAttribute('title', nativeTitleRef.current)
    }
    nativeTitleRef.current = null
  }, [])

  const dismiss = useCallback(() => {
    clearTimer()
    restoreNativeTitle()
    targetRef.current = null
    setActive(null)
    setPosition(null)
  }, [clearTimer, restoreNativeTitle])

  useEffect(() => {
    const schedule = (button: HTMLButtonElement, delay: number) => {
      if (button.dataset.tooltipIgnore === 'true') return
      const text = buttonTooltip(button)
      if (!text) return

      if (targetRef.current !== button) {
        dismiss()
        targetRef.current = button
        nativeTitleRef.current = button.getAttribute('title')
        if (nativeTitleRef.current !== null) button.removeAttribute('title')
      }

      clearTimer()
      timerRef.current = window.setTimeout(() => {
        if (!button.isConnected) return dismiss()
        setPosition(null)
        setActive({ button, text })
      }, delay)
    }

    const buttonFrom = (target: EventTarget | null) =>
      target instanceof Element ? target.closest<HTMLButtonElement>('button') : null

    const onPointerOver = (event: PointerEvent) => {
      const button = buttonFrom(event.target)
      if (!button || (event.relatedTarget instanceof Node && button.contains(event.relatedTarget))) return
      schedule(button, 420)
    }
    const onPointerOut = (event: PointerEvent) => {
      const button = buttonFrom(event.target)
      if (!button || button !== targetRef.current) return
      if (event.relatedTarget instanceof Node && button.contains(event.relatedTarget)) return
      if (document.activeElement !== button) dismiss()
    }
    const onFocusIn = (event: FocusEvent) => {
      const button = buttonFrom(event.target)
      if (!button || performance.now() - pointerDownAt.current < 140) return
      schedule(button, 80)
    }
    const onFocusOut = (event: FocusEvent) => {
      const button = buttonFrom(event.target)
      if (!button || button !== targetRef.current || button.matches(':hover')) return
      dismiss()
    }
    const onPointerDown = () => {
      pointerDownAt.current = performance.now()
      dismiss()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss()
    }

    document.addEventListener('pointerover', onPointerOver)
    document.addEventListener('pointerout', onPointerOut)
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    document.addEventListener('pointerdown', onPointerDown, true)
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('scroll', dismiss, true)
    window.addEventListener('resize', dismiss)
    return () => {
      document.removeEventListener('pointerover', onPointerOver)
      document.removeEventListener('pointerout', onPointerOut)
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      document.removeEventListener('pointerdown', onPointerDown, true)
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('scroll', dismiss, true)
      window.removeEventListener('resize', dismiss)
      dismiss()
    }
  }, [clearTimer, dismiss])

  useLayoutEffect(() => {
    const tooltip = tooltipRef.current
    if (!active || !tooltip || !active.button.isConnected) return

    const anchor = active.button.getBoundingClientRect()
    const width = tooltip.offsetWidth
    const height = tooltip.offsetHeight
    const gap = 9
    const edge = 8
    const centered = anchor.left + anchor.width / 2 - width / 2
    const left = Math.min(Math.max(centered, edge), window.innerWidth - width - edge)
    const hasRoomAbove = anchor.top >= height + gap + edge
    const top = hasRoomAbove ? anchor.top - height - gap : anchor.bottom + gap
    setPosition({ left, top, side: hasRoomAbove ? 'top' : 'bottom' })
  }, [active])

  if (!active) return null

  return createPortal(
    <div
      ref={tooltipRef}
      id={tooltipId}
      role="tooltip"
      className={`button-tooltip${position ? ` is-ready is-${position.side}` : ''}`}
      style={position ? { left: position.left, top: position.top } : undefined}
    >
      {active.text}
    </div>,
    document.body,
  )
}
