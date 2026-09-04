import assert from 'node:assert/strict'
import test from 'node:test'
import {
  commandsFromEventData,
  filterCommands,
  hasCommandQuery,
  insertedCommand,
} from '../src/renderer/src/commandPresentation.ts'

const commands = [
  { name: 'status', description: 'Show session status' },
  { name: '$documents', description: 'Create and edit Word documents', input: { hint: 'request' } },
]

test('reads ACP available command events without provider assumptions', () => {
  assert.deepEqual(commandsFromEventData({ availableCommands: commands }), commands)
  assert.deepEqual(commandsFromEventData({ availableCommands: [{ name: 1 }] }), [])
})

test('filters and inserts slash commands and skills', () => {
  assert.equal(filterCommands(commands, '/stat')[0]?.name, 'status')
  assert.equal(filterCommands(commands, '$doc')[0]?.name, '$documents')
  assert.equal(insertedCommand(commands[0]), '/status')
  assert.equal(insertedCommand(commands[1]), '$documents ')
  assert.equal(hasCommandQuery('/skills'), true)
  assert.equal(hasCommandQuery('please /skills'), false)
})
