import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './en.json';
import zh from './zh.json';

const resources = { en, zh };

i18n.use(initReactI18next).init({
  resources,
  lng: localStorage.getItem('hpath.lang') || undefined,
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
