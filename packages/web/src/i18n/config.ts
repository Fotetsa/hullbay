import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import fr from './locales/fr.json';
import en from './locales/en.json';

const resources = {
  fr: { translation: fr },
  en: { translation: en }
};

const LANGUAGE_KEY = "user-language";

// Récupérer la langue de l'utilisateur à partir du localStorage
const userLanguage = localStorage.getItem(LANGUAGE_KEY) || 'en';


i18n
  .use(initReactI18next)
  .init({
    resources,
    lng: userLanguage,
    fallbackLng: 'fr',
    interpolation: {
      escapeValue: false, 
    }
  });

export default i18n;