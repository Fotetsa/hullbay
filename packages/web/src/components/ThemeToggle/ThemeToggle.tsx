import { useEffect, useState } from "react"
import { Switch } from "@medusajs/ui"
import { Moon, Sun } from "@medusajs/icons"
import {
  applyTheme,
  getInitialTheme,
  saveTheme,
  type Theme,
} from "../../lib/theme"

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("light")

  useEffect(() => {
    const initialTheme = getInitialTheme()

    setTheme(initialTheme)
    applyTheme(initialTheme)
  }, [])

  const handleThemeChange = (checked: boolean) => {
    const nextTheme: Theme = checked ? "dark" : "light"

    setTheme(nextTheme)
    applyTheme(nextTheme)
    saveTheme(nextTheme)
  }

  const isDark = theme === "dark"

  return (
    <div className="flex items-center justify-between px-3 py-2">
      <div className="flex items-center gap-2">
        {isDark ? <Moon /> : <Sun />}

        <span className="text-sm text-ui-fg-subtle">
          {isDark ? "Mode sombre" : "Mode clair"}
        </span>
      </div>

      <Switch
        checked={isDark}
        onCheckedChange={handleThemeChange}
        aria-label="Changer le thème"
      />
    </div>
  )
}