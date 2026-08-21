const THEME_KEY = "hullbay-theme"

export type Theme = "light" | "dark"

export function getStoredTheme(): Theme | null {
  const stored = localStorage.getItem(THEME_KEY)

  if (stored === "light" || stored === "dark") {
    return stored
  }

  return null
}

export function getSystemTheme(): Theme {
  return window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light"
}

export function getInitialTheme(): Theme {
  return getStoredTheme() ?? getSystemTheme()
}

export function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark")
}

export function saveTheme(theme: Theme) {
  localStorage.setItem(THEME_KEY, theme)
}