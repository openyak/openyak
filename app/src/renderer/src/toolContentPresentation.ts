import type { Part } from '../../shared/protocol'

type ToolPart = Extract<Part, { type: 'tool_call' }>

export interface ToolImageContent {
  data: string
  mimeType: string
  uri: string | null
}

export interface ToolAudioContent {
  data: string
  mimeType: string
}

export interface ToolResourceContent {
  name: string
  uri: string
  mimeType: string | null
}

export interface ToolRichContent {
  texts: string[]
  images: ToolImageContent[]
  audio: ToolAudioContent[]
  resources: ToolResourceContent[]
}

const record = (value: unknown): Record<string, unknown> | null =>
  value != null && typeof value === 'object' ? (value as Record<string, unknown>) : null

const string = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null

const mimeType = (value: Record<string, unknown>): string | null =>
  string(value.mimeType) ?? string(value.mime_type)

/** Read only the ACP and MCP content containers; never infer meaning from provider tool names. */
function protocolBlocks(part: ToolPart): unknown[] {
  const blocks: unknown[] = []

  for (const entry of part.content ?? []) {
    const wrapper = record(entry)
    if (wrapper?.type === 'content') blocks.push(wrapper.content)
  }

  const rawOutput = record(part.raw_output)
  const result = record(rawOutput?.result)
  if (Array.isArray(result?.content)) blocks.push(...result.content)

  return blocks
}

export function toolRichContent(part: ToolPart): ToolRichContent {
  const content: ToolRichContent = { texts: [], images: [], audio: [], resources: [] }
  const seen = new Set<string>()

  const add = (key: string, action: () => void) => {
    if (seen.has(key)) return
    seen.add(key)
    action()
  }

  for (const value of protocolBlocks(part)) {
    const block = record(value)
    if (!block) continue

    if (block.type === 'text') {
      const text = string(block.text)
      if (text) add(`text:${text}`, () => content.texts.push(text))
      continue
    }

    if (block.type === 'image') {
      const data = string(block.data)
      const mime = mimeType(block)
      if (data && mime?.startsWith('image/')) {
        add(`image:${mime}:${data}`, () => content.images.push({
          data,
          mimeType: mime,
          uri: string(block.uri),
        }))
      }
      continue
    }

    if (block.type === 'audio') {
      const data = string(block.data)
      const mime = mimeType(block)
      if (data && mime?.startsWith('audio/')) {
        add(`audio:${mime}:${data}`, () => content.audio.push({ data, mimeType: mime }))
      }
      continue
    }

    if (block.type === 'resource_link') {
      const uri = string(block.uri)
      if (!uri) continue
      const name = string(block.title) ?? string(block.name) ?? uri
      add(`resource:${uri}`, () => content.resources.push({
        name,
        uri,
        mimeType: mimeType(block),
      }))
      continue
    }

    if (block.type !== 'resource') continue
    const resource = record(block.resource)
    if (!resource) continue
    const uri = string(resource.uri)
    const text = string(resource.text)
    const blob = string(resource.blob)
    const mime = mimeType(resource)
    if (text) add(`text:${text}`, () => content.texts.push(text))
    if (blob && mime?.startsWith('image/')) {
      add(`image:${mime}:${blob}`, () => content.images.push({ data: blob, mimeType: mime, uri }))
    } else if (blob && mime?.startsWith('audio/')) {
      add(`audio:${mime}:${blob}`, () => content.audio.push({ data: blob, mimeType: mime }))
    } else if (uri) {
      add(`resource:${uri}`, () => content.resources.push({ name: uri, uri, mimeType: mime }))
    }
  }

  return content
}

export function hasToolRichContent(part: ToolPart): boolean {
  const content = toolRichContent(part)
  return content.texts.length + content.images.length + content.audio.length + content.resources.length > 0
}
