export interface CodeBlockPresentation {
  language: string | null
  label: string
  diagram: boolean
}

const LANGUAGE_LABELS: Record<string, string> = {
  bash: 'Shell',
  css: 'CSS',
  diff: 'Diff',
  go: 'Go',
  html: 'HTML',
  js: 'JavaScript',
  javascript: 'JavaScript',
  json: 'JSON',
  jsx: 'JavaScript',
  markdown: 'Markdown',
  md: 'Markdown',
  mermaid: 'Mermaid',
  plaintext: 'Text',
  py: 'Python',
  python: 'Python',
  rs: 'Rust',
  rust: 'Rust',
  sh: 'Shell',
  shell: 'Shell',
  sql: 'SQL',
  text: 'Text',
  ts: 'TypeScript',
  tsx: 'TypeScript',
  typescript: 'TypeScript',
  txt: 'Text',
  yaml: 'YAML',
  yml: 'YAML',
  zsh: 'Zsh',
}

export function codeBlockPresentation(className: string | undefined): CodeBlockPresentation {
  const language = /(?:^|\s)language-([^\s]+)/.exec(className ?? '')?.[1]?.toLowerCase() ?? null
  const label = language
    ? LANGUAGE_LABELS[language] ?? language.replace(/(^|[-_])(\w)/g, (_, __, char: string) => char.toUpperCase())
    : 'Code'
  return { language, label, diagram: language === 'mermaid' }
}
