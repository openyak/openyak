import { useState } from 'react'

interface Props {
  disabled: boolean
  placeholder: string
  streaming: boolean
  onSend: (text: string) => void
  onCancel: () => void
}

export function Composer({ disabled, placeholder, streaming, onSend, onCancel }: Props) {
  const [text, setText] = useState('')
  const canSend = !disabled && !streaming && text.trim().length > 0

  const submit = () => {
    if (!canSend) return
    onSend(text.trim())
    setText('')
  }

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          rows={1}
          placeholder={placeholder}
          value={text}
          disabled={disabled}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault()
              submit()
            }
          }}
        />
        {streaming ? (
          <button className="send stop" onClick={onCancel} title="Stop" aria-label="Stop">
            ■
          </button>
        ) : (
          <button
            className="send"
            onClick={submit}
            disabled={!canSend}
            title="Send (Enter; Shift+Enter for a newline)"
            aria-label="Send"
          >
            ↑
          </button>
        )}
      </div>
    </div>
  )
}
