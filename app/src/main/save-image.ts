import path from 'node:path'

export interface ImageSaveDialogResult {
  canceled: boolean
  filePath?: string
}

export interface ImageSaveRequest {
  mimeType: string
  data: string
  suggestedName?: string
}

export interface ValidatedImageSaveRequest extends ImageSaveRequest {
  extension: string
  bytes: Uint8Array
}

type ChooseImagePath = (image: ValidatedImageSaveRequest) => Promise<ImageSaveDialogResult>
type WriteImageFile = (filePath: string, data: Uint8Array) => Promise<void>

const MAX_IMAGE_BYTES = 10 * 1024 * 1024
const MIME_EXTENSIONS: Record<string, string> = {
  'image/avif': 'avif',
  'image/bmp': 'bmp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'image/heif': 'heif',
  'image/vnd.microsoft.icon': 'ico',
  'image/x-icon': 'ico',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/tiff': 'tiff',
  'image/webp': 'webp',
}

function validateImageSaveRequest(value: unknown): ValidatedImageSaveRequest {
  if (!value || typeof value !== 'object') throw new Error('Expected an image attachment')
  const input = value as Partial<ImageSaveRequest>
  const mimeType = typeof input.mimeType === 'string' ? input.mimeType : ''
  if (!/^image\/[a-z0-9.+-]+$/i.test(mimeType)) throw new Error('Unsupported image type')
  const extension = MIME_EXTENSIONS[mimeType] ?? 'img'
  if (
    typeof input.data !== 'string' ||
    input.data.length === 0 ||
    input.data.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4 ||
    input.data.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)
  ) {
    throw new Error('Expected valid base64 image data')
  }
  const bytes = Buffer.from(input.data, 'base64')
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES) {
    throw new Error('Image attachment exceeds the supported size')
  }
  const suggestedName =
    typeof input.suggestedName === 'string' && input.suggestedName.trim()
      ? path.basename(input.suggestedName.trim())
      : `attached-image.${extension}`
  return { mimeType, data: input.data, suggestedName, extension, bytes }
}

export async function saveImageAttachment(
  value: unknown,
  choosePath: ChooseImagePath,
  writeFile: WriteImageFile,
): Promise<boolean> {
  const image = validateImageSaveRequest(value)
  const result = await choosePath(image)
  if (result.canceled || !result.filePath) return false
  await writeFile(result.filePath, image.bytes)
  return true
}
