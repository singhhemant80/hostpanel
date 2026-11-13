import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import hi from "./locales/hi.json";

/** Add a language: drop a JSON file in ./locales and list it here. */
export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "hi", label: "हिन्दी" },
] as const;

const saved = (() => {
  try {
    return localStorage.getItem("hp_lang");
  } catch {
    return null;
  }
})();

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, hi: { translation: hi } },
  lng: saved ?? (navigator.language.startsWith("hi") ? "hi" : "en"),
  fallbackLng: "en",
  interpolation: { escapeValue: false },
});

export function setLanguage(code: string): void {
  void i18n.changeLanguage(code);
  document.documentElement.lang = code;
  try {
    localStorage.setItem("hp_lang", code);
  } catch {
    /* storage unavailable */
  }
}

export default i18n;
