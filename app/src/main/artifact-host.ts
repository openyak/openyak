import { net, protocol } from 'electron'
import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { ArtifactPreview, ArtifactReference } from '../shared/protocol'
import { renderDocx } from './document-preview'
import { readTextPreview } from './project-file-host'

const artifactSessionTtlMs = 60 * 60 * 1000
const sessions = new Map<string, { root: string; expiresAt: number }>()
const grantedPaths = new Map<string, Set<string>>()

const artifactCsp = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.tailwindcss.com https://code.jquery.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "connect-src 'self' https://fonts.googleapis.com https://fonts.gstatic.com",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ')

export function artifactScheme(): Electron.CustomScheme {
  return {
    scheme: 'openyak-artifact',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  }
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/** Grant one exact absolute path that arrived through a normalized artifact.* event. */
export function grantArtifactPath(taskValue: unknown, fileValue: unknown): void {
  if (typeof taskValue !== 'string' || typeof fileValue !== 'string' || !path.isAbsolute(fileValue)) {
    return
  }
  const paths = grantedPaths.get(taskValue) ?? new Set<string>()
  paths.add(path.resolve(fileValue))
  grantedPaths.set(taskValue, paths)
}

export function forgetArtifactGrants(taskValue: unknown): void {
  if (typeof taskValue === 'string') grantedPaths.delete(taskValue)
}

function resolveAllowed(
  taskValue: unknown,
  rootValue: unknown,
  fileValue: unknown,
): { root: string; file: string } {
  if (typeof taskValue !== 'string' || typeof rootValue !== 'string' || typeof fileValue !== 'string') {
    throw new Error('Artifact task, root, and path are required')
  }
  const root = path.resolve(rootValue)
  const file = path.resolve(root, fileValue)
  if (within(root, file)) return { root, file }
  if (!grantedPaths.get(taskValue)?.has(file)) {
    throw new Error('Artifact is outside the active project and was not declared by the Agent')
  }
  // Official Artifact scratchpads can be outside the Project. Scope relative resources
  // to that Artifact's directory rather than exposing the rest of the filesystem.
  return { root: path.dirname(file), file }
}

export function installArtifactProtocol(): void {
  protocol.handle('openyak-artifact', async (request) => {
    const url = new URL(request.url)
    const session = sessions.get(url.hostname)
    if (!session) return new Response('Artifact preview expired', { status: 404 })
    if (session.expiresAt < Date.now()) {
      sessions.delete(url.hostname)
      return new Response('Artifact preview expired', { status: 404 })
    }
    session.expiresAt = Date.now() + artifactSessionTtlMs
    const relative = decodeURIComponent(url.pathname.replace(/^\//, ''))
    const file = path.resolve(session.root, relative)
    if (!within(session.root, file)) return new Response('Forbidden', { status: 403 })
    const response = await net.fetch(pathToFileURL(file).toString())
    const headers = new Headers(response.headers)
    headers.set('Content-Security-Policy', artifactCsp)
    headers.set('X-Content-Type-Options', 'nosniff')
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    })
  })
}

export async function inspectArtifact(
  taskValue: unknown,
  rootValue: unknown,
  artifactValue: unknown,
): Promise<ArtifactPreview> {
  if (artifactValue == null || typeof artifactValue !== 'object') {
    throw new Error('Artifact reference is required')
  }
  const artifact = artifactValue as ArtifactReference
  const { root, file } = resolveAllowed(taskValue, rootValue, artifact.path)
  const info = await stat(file)
  if (!info.isFile()) throw new Error('Artifact is not a file')
  const token = randomUUID()
  for (const [key, session] of sessions) {
    if (session.expiresAt < Date.now()) sessions.delete(key)
  }
  sessions.set(token, { root, expiresAt: Date.now() + artifactSessionTtlMs })
  const relative = path.relative(root, file).split(path.sep).map(encodeURIComponent).join('/')
  const extension = path.extname(file).slice(1).toLowerCase()
  const text = await readTextPreview(file, info.size)
  return {
    path: file,
    name: path.basename(file),
    extension,
    size: info.size,
    previewUrl: `openyak-artifact://${token}/${relative}`,
    ...text,
    ...(extension === 'docx' ? { renderedHtml: await renderDocx(file) } : {}),
    ...(typeof artifact.url === 'string' ? { sourceUrl: artifact.url } : {}),
    ...(typeof artifact.title === 'string' ? { title: artifact.title } : {}),
    ...(typeof artifact.id === 'string' ? { artifactId: artifact.id } : {}),
    ...(typeof artifact.version === 'string' ? { version: artifact.version } : {}),
  }
}

export function resolveArtifactPath(taskValue: unknown, rootValue: unknown, fileValue: unknown): string {
  return resolveAllowed(taskValue, rootValue, fileValue).file
}
