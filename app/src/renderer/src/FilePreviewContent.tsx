import { useEffect, useMemo, useRef } from 'react'
import { Highlight, themes } from 'prism-react-renderer'
import Markdown from 'react-markdown'
import rehypeHighlight from 'rehype-highlight'
import remarkGfm from 'remark-gfm'
import { IconFile } from './icons'
import { markdownComponents, useDarkAppearance } from './MarkdownBlocks'
import { codePreviewLanguage, filePreviewKind } from './filePreviewPresentation'

interface Props {
  name: string
  extension: string
  previewUrl: string
  content: string | null
  renderedHtml?: string
  truncated: boolean
  line?: number
  column?: number
  trustedArtifact?: boolean
  onOpen: () => void
}

function docxDocument(content: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="color-scheme" content="light"><style>
    *{box-sizing:border-box}html{background:#e9e9e7}body{max-width:850px;min-height:calc(100vh - 48px);margin:24px auto;padding:64px 72px;background:#fff;color:#202124;font:15px/1.62 ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;box-shadow:0 1px 5px rgba(0,0,0,.16)}
    h1,h2,h3,h4{line-height:1.25;margin:1.35em 0 .55em}p{margin:.7em 0}img{max-width:100%;height:auto}table{width:100%;border-collapse:collapse;margin:1em 0}td,th{padding:7px 9px;border:1px solid #d2d5d9;text-align:left}a{color:#0969da}pre,code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}blockquote{margin:1em 0;padding-left:1em;border-left:3px solid #d0d7de;color:#57606a}
    @media(max-width:700px){html{background:#fff}body{margin:0;padding:28px 24px;box-shadow:none}}
  </style></head><body>${content}</body></html>`
}

function SourcePreview({
  content,
  extension,
  line,
  name,
  truncated,
}: Pick<Props, 'content' | 'extension' | 'line' | 'name' | 'truncated'>) {
  const container = useRef<HTMLDivElement>(null)
  const dark = useDarkAppearance()
  const language = codePreviewLanguage(extension)

  useEffect(() => {
    if (!line) return
    container.current
      ?.querySelector<HTMLElement>(`[data-line="${line}"]`)
      ?.scrollIntoView({ block: 'center' })
  }, [line, name])

  return (
    <div className="workbench-content project-file-content" ref={container}>
      <Highlight theme={dark ? themes.vsDark : themes.vsLight} code={content ?? ''} language={language}>
        {({ className, style, tokens, getLineProps, getTokenProps }) => (
          <pre
            className={`${className} project-file-source`}
            style={{ ...style, background: 'transparent' }}
            aria-label={name}
          >
            {tokens.map((tokensForLine, index) => {
              const number = index + 1
              const lineProps = getLineProps({ line: tokensForLine })
              return (
                <span
                  {...lineProps}
                  className={`${lineProps.className ?? ''} project-file-line${number === line ? ' is-target' : ''}`.trim()}
                  data-line={number}
                  key={number}
                >
                  <span className="project-file-line-number" aria-hidden="true">{number}</span>
                  <span className="project-file-line-text">
                    {tokensForLine.map((token, tokenIndex) => (
                      <span {...getTokenProps({ token })} key={`${number}:${tokenIndex}`} />
                    ))}
                  </span>
                </span>
              )
            })}
            {truncated && <span className="project-file-truncated">Preview truncated at 1 MB</span>}
          </pre>
        )}
      </Highlight>
    </div>
  )
}

export function FilePreviewContent(props: Props) {
  const kind = filePreviewKind(props.extension, props.content !== null, Boolean(props.renderedHtml))
  const docx = useMemo(
    () => props.renderedHtml ? docxDocument(props.renderedHtml) : undefined,
    [props.renderedHtml],
  )

  if (kind === 'markdown') {
    return (
      <div className="workbench-content workbench-markdown md">
        <Markdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeHighlight]}
          components={markdownComponents}
        >
          {props.content ?? ''}
        </Markdown>
        {props.truncated && <div className="file-preview-notice">Preview truncated at 1 MB</div>}
      </div>
    )
  }

  if (kind === 'html') {
    return (
      <div className="workbench-content file-preview-frame">
        <iframe
          src={props.previewUrl}
          title={props.name}
          sandbox={props.trustedArtifact
            ? 'allow-scripts allow-forms allow-modals allow-popups allow-same-origin'
            : 'allow-same-origin'}
        />
      </div>
    )
  }

  if (kind === 'pdf') {
    return (
      <div className="workbench-content file-preview-frame">
        <iframe src={props.previewUrl} title={props.name} />
      </div>
    )
  }

  if (kind === 'docx' && docx) {
    return (
      <div className="workbench-content file-preview-frame file-preview-docx">
        <iframe srcDoc={docx} title={props.name} sandbox="" />
      </div>
    )
  }

  if (kind === 'image') {
    return (
      <div className="workbench-content file-preview-image">
        <img src={props.previewUrl} alt={props.name} />
      </div>
    )
  }

  if (kind === 'source') {
    return (
      <SourcePreview
        content={props.content}
        extension={props.extension}
        line={props.line}
        name={props.name}
        truncated={props.truncated}
      />
    )
  }

  return (
    <div className="workbench-content artifact-empty">
      <IconFile size={32} />
      <strong>Preview isn’t available for this file type</strong>
      <span>Open it in the default app or reveal it in Finder.</span>
      <button type="button" onClick={props.onOpen}>Open {props.name}</button>
    </div>
  )
}
