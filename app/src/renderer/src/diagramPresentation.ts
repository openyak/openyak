export type Point = { x: number; y: number }
export type ScrollPosition = { left: number; top: number }

export type DiagramSize = { width: number; height: number }
export type InlineDiagramStyle = { width: string; maxWidth: '100%' }

/** Read the intrinsic Mermaid canvas without interpreting diagram source or provider output. */
export function diagramViewBoxSize(svg: string): DiagramSize | null {
  const match = svg.match(
    /viewBox\s*=\s*["']\s*[-+]?\d*\.?\d+(?:e[-+]?\d+)?\s+[-+]?\d*\.?\d+(?:e[-+]?\d+)?\s+([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s+([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s*["']/i,
  )
  const width = match ? Number(match[1]) : Number.NaN
  const height = match ? Number(match[2]) : Number.NaN
  return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
    ? { width, height }
    : null
}

/** Match Codex-style inline sizing: natural size when it fits, responsive shrink otherwise. */
export function inlineDiagramStyle(svg: string): InlineDiagramStyle {
  const size = diagramViewBoxSize(svg)
  return { width: size ? `${size.width}px` : 'auto', maxWidth: '100%' }
}

/** Overflow is intrinsic, even though CSS fits the displayed SVG into the available width. */
export function diagramOverflows(naturalWidth: number, availableWidth: number): boolean {
  return (
    Number.isFinite(naturalWidth) &&
    Number.isFinite(availableWidth) &&
    naturalWidth > 0 &&
    availableWidth > 0 &&
    naturalWidth > availableWidth + 1
  )
}

export function draggedScrollPosition(
  startScroll: ScrollPosition,
  dragOrigin: Point,
  pointer: Point,
): ScrollPosition {
  return {
    left: Math.max(0, startScroll.left + dragOrigin.x - pointer.x),
    top: Math.max(0, startScroll.top + dragOrigin.y - pointer.y),
  }
}
