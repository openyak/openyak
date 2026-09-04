import type { AvailableCommand } from '../../shared/protocol'

const commandName = (command: AvailableCommand): string =>
  command.name.startsWith('$') || command.name.startsWith('/') ? command.name : `/${command.name}`

export function commandsFromEventData(data: unknown): AvailableCommand[] {
  if (data == null || typeof data !== 'object') return []
  const value = data as { availableCommands?: unknown }
  if (!Array.isArray(value.availableCommands)) return []
  return value.availableCommands.flatMap((candidate) => {
    if (candidate == null || typeof candidate !== 'object') return []
    const command = candidate as Record<string, unknown>
    if (typeof command.name !== 'string' || typeof command.description !== 'string') return []
    return [command as unknown as AvailableCommand]
  })
}

export function filterCommands(commands: AvailableCommand[], value: string): AvailableCommand[] {
  const query = value.trim().replace(/^[$/]/, '').toLowerCase()
  return commands
    .filter((command) => {
      if (!query) return true
      return `${command.name} ${command.description}`.toLowerCase().includes(query)
    })
    .slice(0, 12)
}

export function insertedCommand(command: AvailableCommand): string {
  return `${commandName(command)}${command.input?.hint ? ' ' : ''}`
}

export function hasCommandQuery(value: string): boolean {
  return /^[$/][^\s]*$/.test(value.trim())
}
