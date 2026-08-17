import { useTranslation } from 'react-i18next'
import { Select } from '@medusajs/ui'

/**
 * Composant de sélection de langue (FR/EN).
 * Persiste le choix dans localStorage et recharge i18n.
 */
export function LanguageSwitch() {
  const { i18n } = useTranslation()

  const languages = [
    { value: 'en', label: 'English' },
    { value: 'fr', label: 'Français' }
  ]

  const handleChange = (value: string) => {
    i18n.changeLanguage(value)
    localStorage.setItem('user-language', value)
  }

  return (
    <Select value={i18n.language} onValueChange={handleChange}>
      <Select.Trigger>
        <Select.Value />
      </Select.Trigger>
      <Select.Content>
        {languages.map((lang) => (
          <Select.Item key={lang.value} value={lang.value}>
            {lang.label}
          </Select.Item>
        ))}
      </Select.Content>
    </Select>
  )
}
