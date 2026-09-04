import { useMemo, useState } from 'react'
import type { ElicitationRequest, ElicitationResponse } from '../../shared/protocol'
import { IconHand } from './icons'
import { elicitationFields } from './elicitationPresentation'

type FormValue = string | number | boolean | string[]

export function ElicitationCard({
  request,
  agentName,
  onRespond,
}: {
  request: ElicitationRequest
  agentName: string
  onRespond: (response: ElicitationResponse) => void
}) {
  const fields = useMemo(
    () => (request.mode === 'form' ? elicitationFields(request) : []),
    [request],
  )
  const [values, setValues] = useState<Record<string, FormValue>>(() =>
    Object.fromEntries(
      fields.flatMap((field) =>
        field.defaultValue === undefined ? [] : [[field.key, field.defaultValue]],
      ),
    ),
  )

  const setValue = (key: string, value: FormValue) =>
    setValues((current) => ({ ...current, [key]: value }))
  const missingRequired = fields.some((field) => {
    if (!field.required) return false
    const value = values[field.key]
    return value === undefined || value === '' || (Array.isArray(value) && value.length === 0)
  })

  const submit = () => {
    const content = Object.fromEntries(
      Object.entries(values).filter(
        ([, value]) => value !== '' && (!Array.isArray(value) || value.length > 0),
      ),
    )
    onRespond({ action: 'accept', content })
  }

  if (request.mode === 'url') {
    let host = request.url
    try {
      host = new URL(request.url).host
    } catch {
      // The main process validates the URL again before opening it.
    }
    return (
      <div className="permission elicitation">
        <div className="permission-head">
          <IconHand size={15} />
          <span>{agentName} wants to open a secure page</span>
        </div>
        <div className="permission-title">{request.message}</div>
        <div className="elicitation-url-host">{host}</div>
        <div className="permission-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => {
              void window.openyak
                .openExternal(request.url)
                .then(() => onRespond({ action: 'accept' }))
                .catch(() => onRespond({ action: 'cancel' }))
            }}
          >
            Open page
          </button>
          <button type="button" className="btn" onClick={() => onRespond({ action: 'decline' })}>
            Not now
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => onRespond({ action: 'cancel' })}>
            Cancel
          </button>
        </div>
      </div>
    )
  }

  return (
    <form
      className="permission elicitation"
      onSubmit={(event) => {
        event.preventDefault()
        if (!missingRequired) submit()
      }}
    >
      <div className="permission-head">
        <IconHand size={15} />
        <span>{agentName} has a question</span>
      </div>
      <div className="permission-title">{request.message}</div>
      <div className="elicitation-fields">
        {fields.map((field) => (
          <fieldset key={field.key} className="elicitation-field">
            <legend>
              {field.label}
              {field.required && <span aria-label="required"> *</span>}
            </legend>
            {field.description && <div className="elicitation-description">{field.description}</div>}
            {field.kind === 'single-select' &&
              field.choices.map((choice) => (
                <label key={String(choice.value)} className="elicitation-choice">
                  <input
                    type="radio"
                    name={field.key}
                    checked={values[field.key] === choice.value}
                    onChange={() => setValue(field.key, choice.value)}
                  />
                  <span>
                    <strong>{choice.label}</strong>
                    {choice.description && <small>{choice.description}</small>}
                  </span>
                </label>
              ))}
            {field.kind === 'multi-select' &&
              field.choices.map((choice) => {
                const current = Array.isArray(values[field.key]) ? (values[field.key] as string[]) : []
                const value = String(choice.value)
                return (
                  <label key={value} className="elicitation-choice">
                    <input
                      type="checkbox"
                      checked={current.includes(value)}
                      onChange={(event) =>
                        setValue(
                          field.key,
                          event.target.checked
                            ? [...current, value]
                            : current.filter((item) => item !== value),
                        )
                      }
                    />
                    <span>
                      <strong>{choice.label}</strong>
                      {choice.description && <small>{choice.description}</small>}
                    </span>
                  </label>
                )
              })}
            {field.kind === 'boolean' && (
              <label className="elicitation-choice">
                <input
                  type="checkbox"
                  checked={values[field.key] === true}
                  onChange={(event) => setValue(field.key, event.target.checked)}
                />
                <span>Yes</span>
              </label>
            )}
            {field.kind === 'text' && (
              <input
                className="elicitation-input"
                value={
                  typeof values[field.key] === 'string' ? (values[field.key] as string) : ''
                }
                required={field.required}
                onChange={(event) => setValue(field.key, event.target.value)}
              />
            )}
            {field.kind === 'number' && (
              <input
                className="elicitation-input"
                type="number"
                step="any"
                value={
                  typeof values[field.key] === 'number' ? (values[field.key] as number) : ''
                }
                required={field.required}
                onChange={(event) =>
                  setValue(field.key, event.target.value === '' ? '' : Number(event.target.value))
                }
              />
            )}
          </fieldset>
        ))}
      </div>
      <div className="permission-actions">
        <button type="submit" className="btn btn-primary" disabled={missingRequired}>
          Submit
        </button>
        <button type="button" className="btn" onClick={() => onRespond({ action: 'decline' })}>
          Skip
        </button>
        <button type="button" className="btn btn-ghost" onClick={() => onRespond({ action: 'cancel' })}>
          Cancel
        </button>
      </div>
    </form>
  )
}
