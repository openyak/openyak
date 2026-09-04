import type { ProjectFileReference } from '../../shared/protocol'

const lineFragment = /#L(\d+)(?:C(\d+))?$/i
const lineSuffix = /:(\d+)(?::(\d+))?$/
const scheme = /^[a-z][a-z\d+.-]*:/i
const windowsAbsolutePath = /^[a-z]:[\\/]/i

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * Parse the location formats emitted by agents and Markdown renderers. The project
 * host remains the authority: parsing never grants filesystem access.
 */
export function markdownFileReference(value: string): ProjectFileReference | null {
  let target = value.trim()
  if (!target || target.startsWith('#')) return null

  if (target.startsWith('file://')) {
    try {
      const url = new URL(target)
      target = `${url.pathname}${url.hash}`
    } catch {
      return null
    }
  } else if (scheme.test(target) && !windowsAbsolutePath.test(target)
    && !/^[^:/\\]+\.[^:/\\]+:\d+(?::\d+)?$/.test(target)) {
    return null
  }

  let line: number | undefined
  let column: number | undefined
  const fragment = lineFragment.exec(target)
  if (fragment) {
    line = Number(fragment[1])
    column = fragment[2] ? Number(fragment[2]) : undefined
    target = target.slice(0, fragment.index)
  } else {
    const suffix = lineSuffix.exec(target)
    if (suffix) {
      line = Number(suffix[1])
      column = suffix[2] ? Number(suffix[2]) : undefined
      target = target.slice(0, suffix.index)
    } else {
      // A normal Markdown heading fragment belongs to the file, not its pathname.
      target = target.replace(/#.*$/, '')
    }
  }

  target = decodePath(target)
  if (!target || target.includes('\0') || target.includes('\n') || target.includes('\r')) return null
  return {
    path: target,
    ...(line && line > 0 ? { line } : {}),
    ...(column && column > 0 ? { column } : {}),
  }
}

/** Inline code is only a candidate. The main process verifies existence and containment. */
export function inlineFileReference(value: string): ProjectFileReference | null {
  const target = value.trim()
  if (!target || /\s/.test(target) || /^https?:\/\//i.test(target)) return null
  const reference = markdownFileReference(target)
  if (!reference) return null
  const basename = reference.path.split(/[\\/]/).at(-1) ?? ''
  if (!reference.path.includes('/') && !reference.path.includes('\\') && !basename.includes('.')) {
    return null
  }
  return reference
}
