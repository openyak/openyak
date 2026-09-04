export type Point = { x: number; y: number }
export type ScrollPosition = { left: number; top: number }

const INLINE_DIAGRAM_FALLBACK_WIDTH = 720
const INLINE_DIAGRAM_MIN_SCALE = 0.78
const INLINE_DIAGRAM_MAX_WIDTH = 3200

/** Keep Mermaid text near its authored size; wide diagrams scroll instead of shrinking to prose. */
export function inlineDiagramMinWidth(svg: string): number {
  const match = svg.match(
    /viewBox\s*=\s*["']\s*[-+]?\d*\.?\d+(?:e[-+]?\d+)?\s+[-+]?\d*\.?\d+(?:e[-+]?\d+)?\s+([-+]?\d*\.?\d+(?:e[-+]?\d+)?)\s+[-+]?\d*\.?\d+(?:e[-+]?\d+)?\s*["']/i,
  )
  const viewBoxWidth = match ? Number(match[1]) : Number.NaN
  if (!Number.isFinite(viewBoxWidth) || viewBoxWidth <= 0) {
    return INLINE_DIAGRAM_FALLBACK_WIDTH
  }
  return Math.min(
    INLINE_DIAGRAM_MAX_WIDTH,
    Math.max(INLINE_DIAGRAM_FALLBACK_WIDTH, Math.ceil(viewBoxWidth * INLINE_DIAGRAM_MIN_SCALE)),
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
