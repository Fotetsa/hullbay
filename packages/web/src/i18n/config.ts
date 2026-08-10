import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import translationFR from './locales/fr.json';
import translationEN from './locales/en.json';

const resources = {
  fr: { translation: translationFR },
  en: { translation: translationEN }
};

i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: 'fr', // Langue par défaut
    fallbackLng: 'en', // Langue de secours si une clé manque
    interpolation: {
      escapeValue: false, // React protège déjà contre les failles XSS
    }
  });

export default i18n;