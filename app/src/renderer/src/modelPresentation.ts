import type { AgentConfigOption, AgentId } from '../../shared/protocol'

type SelectOption = Extract<AgentConfigOption, { type: 'select' }>
type Choice = SelectOption['options'][number]

export function isDefaultModelChoice(choice: Choice): boolean {
  return choice.value === 'default' || /^default\b/i.test(choice.name)
}

/** Claude advertises both "Default → Opus" and explicit Opus; expose one choice. */
export function displayedModelChoices(agent: AgentId, option: SelectOption): Choice[] {
  if (agent !== 'claude') return option.options
  const explicit = option.options.filter((choice) => !isDefaultModelChoice(choice))
  return explicit.length > 0 ? explicit : option.options
}

/** Resolve Claude's provider-default alias to the explicit model shown in the UI. */
export function displayedCurrentModel(agent: AgentId, option: SelectOption): Choice | undefined {
  const current = option.options.find((choice) => choice.value === option.current_value)
  if (agent === 'claude' && current && isDefaultModelChoice(current)) {
    return displayedModelChoices(agent, option)[0] ?? current
  }
  return current
}
