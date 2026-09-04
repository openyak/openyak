import { open, realpath, stat } from 'node:fs/promises'
import path from 'node:path'
import type {
  ProjectFileReference,
  ResolvedProjectFile,
} from '../shared/protocol'

const maxPreviewBytes = 1024 * 1024

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

function reference(value: unknown): ProjectFileReference | null {
  if (value == null || typeof value !== 'object') return null
  const candidate = value as { path?: unknown; line?: unknown; column?: unknown }
  if (typeof candidate.path !== 'string' || !candidate.path || candidate.path.includes('\0')) return null
  const line = Number.isInteger(candidate.line) && Number(candidate.line) > 0
    ? Number(candidate.line)
    : undefined
  const column = Number.isInteger(candidate.column) && Number(candidate.column) > 0
    ? Number(candidate.column)
    : undefined
  return { path: candidate.path, ...(line ? { line } : {}), ...(column ? { column } : {}) }
}

/** Resolve through real paths so a project symlink cannot expose a file outside the project. */
export async function resolveProjectFile(
  rootValue: unknown,
  referenceValue: unknown,
): Promise<ResolvedProjectFile | null> {
  if (typeof rootValue !== 'string' || !rootValue) return null
  const input = reference(referenceValue)
  if (!input) return null
  try {
    const root = await realpath(rootValue)
    const unresolved = path.resolve(root, input.path)
    // macOS can spell the same directory /var and /private/var. Authorize the
    // canonical target, not a lexical alias, before stat/read/open.
    const file = await realpath(unresolved)
    if (!within(root, file)) return null
    const info = await stat(file)
    if (!info.isFile()) return null
    return {
      path: file,
      relativePath: path.relative(root, file),
      name: path.basename(file),
      extension: path.extname(file).slice(1).toLowerCase(),
      size: info.size,
      ...(input.line ? { line: input.line } : {}),
      ...(input.column ? { column: input.column } : {}),
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EACCES') return null
    throw error
  }
}

export async function readTextPreview(file: string, size: number): Promise<{ content: string | null; truncated: boolean }> {
  const length = Math.min(size, maxPreviewBytes)
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    const bytes = buffer.subarray(0, bytesRead)
    if (bytes.includes(0)) return { content: null, truncated: size > bytesRead }
    return { content: bytes.toString('utf8'), truncated: size > bytesRead }
  } finally {
    await handle.close()
  }
}

export async function inspectProjectFile(
  rootValue: unknown,
  referenceValue: unknown,
): Promise<ResolvedProjectFile & { content: string | null; truncated: boolean }> {
  const resolved = await resolveProjectFile(rootValue, referenceValue)
  if (!resolved) throw new Error('File is not available in the active project')
  return { ...resolved, ...(await readTextPreview(resolved.path, resolved.size)) }
}
