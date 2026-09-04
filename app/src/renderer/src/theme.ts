import type { ThemePreference } from '../../shared/protocol'

export const THEME_KEY = 'openyak.theme'

export function normalizeThemePreference(value: unknown): ThemePreference {
  return value === 'light' || value === 'dark' || value === 'system' ? value : 'system'
}

export function readThemePreference(): ThemePreference {
  try {
    return normalizeThemePreference(localStorage.getItem(THEME_KEY))
  } catch {
    return 'system'
  }
}
