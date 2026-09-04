import { net, protocol } from 'electron'
import { randomUUID } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ProjectFilePreview } from '../shared/protocol'
import { renderDocx } from './document-preview'
import { inspectProjectFile } from './project-file-host'

const scheme = 'openyak-project-file'
const sessionTtlMs = 60 * 60 * 1000
const sessions = new Map<string, { root: string; expiresAt: number }>()

const projectFileCsp = [
  "default-src 'none'",
  "script-src 'none'",
  "style-src 'self' 'unsafe-inline'",
  "font-src 'self' data:",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function projectFileScheme(): Electron.CustomScheme {
  return {
    scheme,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  }
}

export function installProjectFileProtocol(): void {
  protocol.handle(scheme, async (request) => {
    const url = new URL(request.url)
    const session = sessions.get(url.hostname)
    if (!session || session.expiresAt < Date.now()) {
      sessions.delete(url.hostname)
      return new Response('File preview expired', { status: 404 })
    }
    session.expiresAt = Date.now() + sessionTtlMs
    try {
      const relative = decodeURIComponent(url.pathname.replace(/^\//, ''))
      const candidate = path.resolve(session.root, relative)
      if (!within(session.root, candidate)) return new Response('Forbidden', { status: 403 })
      const file = await realpath(candidate)
      if (!within(session.root, file)) return new Response('Forbidden', { status: 403 })
      const response = await net.fetch(pathToFileURL(file).toString())
      const headers = new Headers(response.headers)
      headers.set('Content-Security-Policy', projectFileCsp)
      headers.set('X-Content-Type-Options', 'nosniff')
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      })
    } catch {
      return new Response('File not found', { status: 404 })
    }
  })
}

export async function inspectProjectFilePreview(
  rootValue: unknown,
  referenceValue: unknown,
): Promise<ProjectFilePreview> {
  if (typeof rootValue !== 'string' || !rootValue) {
    throw new Error('File is not available in the active project')
  }
  const root = await realpath(rootValue)
  const preview = await inspectProjectFile(root, referenceValue)
  const token = randomUUID()
  for (const [key, session] of sessions) {
    if (session.expiresAt < Date.now()) sessions.delete(key)
  }
  sessions.set(token, { root, expiresAt: Date.now() + sessionTtlMs })
  const relative = path.relative(root, preview.path).split(path.sep).map(encodeURIComponent).join('/')
  return {
    ...preview,
    previewUrl: `${scheme}://${token}/${relative}`,
    ...(preview.extension === 'docx' ? { renderedHtml: await renderDocx(preview.path) } : {}),
  }
}
