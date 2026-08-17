import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import fr from './locales/fr.json';
import en from './locales/en.json';

const resources = {
  fr: { translation: fr },
  en: { translation: en }
};

// Configuration du détecteur de langue avec priorité : localStorage > navigateur
const detectionOptions = {
  order: ['localStorage', 'navigator'],
  lookupLocalStorage: 'user-language',
  caches: ['localStorage'],
  // Ne détecter que les langues supportées
  checkWhitelist: true
};

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources,
    fallbackLng: 'en',
    supportedLngs: ['en', 'fr'],
    detection: detectionOptions,
    interpolation: {
      escapeValue: false, 
    }
  });

export default i18n;