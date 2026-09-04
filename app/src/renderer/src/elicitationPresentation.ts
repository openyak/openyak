import type {
  ElicitationEnumOption,
  ElicitationPropertySchema,
  FormElicitationRequest,
} from '../../shared/protocol'

export type ElicitationFieldKind =
  | 'text'
  | 'number'
  | 'boolean'
  | 'single-select'
  | 'multi-select'

export interface ElicitationChoice {
  value: string | number
  label: string
  description?: string
}

export interface ElicitationField {
  key: string
  label: string
  description?: string
  required: boolean
  kind: ElicitationFieldKind
  choices: ElicitationChoice[]
  defaultValue?: string | number | boolean | string[]
}

function choices(options: ElicitationEnumOption[] | undefined): ElicitationChoice[] {
  return (options ?? []).flatMap((option) => {
    if (typeof option.const !== 'string' && typeof option.const !== 'number') return []
    return [
      {
        value: option.const,
        label: option.title || String(option.const),
        ...(option.description ? { description: option.description } : {}),
      },
    ]
  })
}

function enumChoices(values: Array<string | number> | undefined): ElicitationChoice[] {
  return (values ?? []).map((value) => ({ value, label: String(value) }))
}

function describeField(
  key: string,
  schema: ElicitationPropertySchema,
  required: boolean,
): ElicitationField {
  const single = choices(schema.oneOf)
  const multiple = choices(schema.items?.anyOf)
  const plainSingle = enumChoices(schema.enum)
  const plainMultiple = enumChoices(schema.items?.enum)
  const available = single.length
    ? single
    : multiple.length
      ? multiple
      : plainSingle.length
        ? plainSingle
        : plainMultiple
  let kind: ElicitationFieldKind = 'text'
  if (schema.type === 'boolean') kind = 'boolean'
  else if (schema.type === 'number' || schema.type === 'integer') kind = 'number'
  else if (schema.type === 'array') kind = 'multi-select'
  else if (available.length) kind = 'single-select'
  return {
    key,
    label: schema.title || key,
    ...(schema.description ? { description: schema.description } : {}),
    required,
    kind,
    choices: available,
    ...(schema.default !== undefined ? { defaultValue: schema.default } : {}),
  }
}

/** Translate the ACP schema structurally; provider field names and option labels stay opaque. */
export function elicitationFields(request: FormElicitationRequest): ElicitationField[] {
  const required = new Set(request.requestedSchema.required ?? [])
  return Object.entries(request.requestedSchema.properties ?? {}).map(([key, schema]) =>
    describeField(key, schema, required.has(key)),
  )
}
