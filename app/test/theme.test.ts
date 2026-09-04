import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeThemePreference } from '../src/renderer/src/theme.ts'

test('theme preferences preserve supported choices', () => {
  assert.equal(normalizeThemePreference('system'), 'system')
  assert.equal(normalizeThemePreference('light'), 'light')
  assert.equal(normalizeThemePreference('dark'), 'dark')
})

test('unknown or missing theme preferences follow the system', () => {
  assert.equal(normalizeThemePreference(null), 'system')
  assert.equal(normalizeThemePreference('sepia'), 'system')
})
