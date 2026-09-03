import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';

import en from './en.json';
import zh from './zh.json';

// i18next expects resources[lng][namespace]; the JSON files hold flat
// top-level sections (topbar/sidebar/...), so wrap them as the default
// "translation" namespace. Without the wrapper every t() call misses and
// renders the raw key.
const resources = { en: { translation: en }, zh: { translation: zh } };

i18n.use(initReactI18next).init({
  resources,
  lng: localStorage.getItem('hpath.lang') || undefined,
  fallbackLng: 'en',
  interpolation: {
    escapeValue: false,
  },
});

export default i18n;
