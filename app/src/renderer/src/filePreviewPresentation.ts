export type FilePreviewKind = 'markdown' | 'html' | 'pdf' | 'docx' | 'image' | 'source' | 'unsupported'

const imageExtensions = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'])
const languageAliases: Record<string, string> = {
  cjs: 'javascript',
  h: 'c',
  hpp: 'cpp',
  js: 'javascript',
  kt: 'kotlin',
  kts: 'kotlin',
  mjs: 'javascript',
  ps1: 'powershell',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  sh: 'bash',
  ts: 'typescript',
  yml: 'yaml',
  zsh: 'bash',
}

export function codePreviewLanguage(extensionValue: string): string {
  const extension = extensionValue.toLowerCase()
  return (languageAliases[extension] ?? extension) || 'plain'
}

export function filePreviewKind(
  extensionValue: string,
  hasText: boolean,
  hasRenderedHtml: boolean,
): FilePreviewKind {
  const extension = extensionValue.toLowerCase()
  if (extension === 'md' || extension === 'markdown') return hasText ? 'markdown' : 'unsupported'
  if (extension === 'html' || extension === 'htm') return 'html'
  if (extension === 'pdf') return 'pdf'
  if (extension === 'docx') return hasRenderedHtml ? 'docx' : 'unsupported'
  if (imageExtensions.has(extension)) return 'image'
  return hasText ? 'source' : 'unsupported'
}
