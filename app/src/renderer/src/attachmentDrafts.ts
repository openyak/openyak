import type { Attachment, Part } from '../../shared/protocol'

export type AttachmentDraft =
  | { id: string; type: 'image'; name: string; mime_type: string; data: string }
  | { id: string; type: 'file'; name: string; path: string }

export interface AttachmentBatch {
  drafts: AttachmentDraft[]
  notices: string[]
}

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
let nextDraft = 1
const uid = () => String(nextDraft++)

function basename(path: string): string {
  const parts = path.replace(/[\\/]+$/, '').split(/[\\/]/)
  return parts[parts.length - 1] || path
}

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

export async function draftsFromFiles(files: Iterable<File>): Promise<AttachmentBatch> {
  const drafts: AttachmentDraft[] = []
  const notices: string[] = []
  for (const file of files) {
    const path = window.openyak.pathForFile(file)
    if (file.type.startsWith('image/') && file.size <= MAX_IMAGE_BYTES) {
      try {
        drafts.push({
          id: uid(),
          type: 'image',
          name: file.name || 'Image',
          mime_type: file.type,
          data: await readBase64(file),
        })
      } catch {
        notices.push(`${file.name || 'Image'} could not be read`)
      }
    } else if (path) {
      drafts.push({ id: uid(), type: 'file', name: basename(path), path })
      if (file.type.startsWith('image/') && file.size > MAX_IMAGE_BYTES) {
        notices.push(`${file.name || 'Image'} was attached as a file because it exceeds 10 MB`)
      }
    } else if (file.type.startsWith('image/') && file.size > MAX_IMAGE_BYTES) {
      notices.push(`${file.name || 'Image'} exceeds the 10 MB image limit`)
    } else {
      notices.push(`${file.name || 'File'} could not be attached`)
    }
  }
  return { drafts, notices }
}

export function draftsFromPaths(paths: string[]): AttachmentDraft[] {
  return paths.map((path) => ({ id: uid(), type: 'file', name: basename(path), path }))
}

export function draftsFromParts(parts: Part[]): AttachmentDraft[] {
  return parts.flatMap((part): AttachmentDraft[] => {
    if (part.type === 'image') {
      return [
        {
          id: uid(),
          type: 'image',
          name: 'Attached image',
          mime_type: part.mime_type,
          data: part.data,
        },
      ]
    }
    if (part.type === 'file') {
      return [{ id: uid(), type: 'file', name: part.name, path: part.path }]
    }
    return []
  })
}

export function toAttachment(draft: AttachmentDraft): Attachment {
  return draft.type === 'image'
    ? { type: 'image', mime_type: draft.mime_type, data: draft.data }
    : { type: 'file', path: draft.path }
}

function key(draft: AttachmentDraft): string {
  return draft.type === 'file'
    ? `file:${draft.path}`
    : `image:${draft.mime_type}:${draft.data.length}:${draft.data.slice(0, 24)}`
}

export function mergeDrafts(
  current: AttachmentDraft[],
  incoming: AttachmentDraft[],
): { drafts: AttachmentDraft[]; duplicateNames: string[] } {
  const seen = new Set(current.map(key))
  const unique: AttachmentDraft[] = []
  const duplicateNames: string[] = []
  for (const draft of incoming) {
    const draftKey = key(draft)
    if (seen.has(draftKey)) {
      duplicateNames.push(draft.name)
      continue
    }
    seen.add(draftKey)
    unique.push(draft)
  }
  return { drafts: [...current, ...unique], duplicateNames }
}
