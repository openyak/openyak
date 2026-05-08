import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import LanguageDetector from "i18next-browser-languagedetector";

import enCommon from "./locales/en/common.json";
import enChat from "./locales/en/chat.json";
import enSettings from "./locales/en/settings.json";
import enUsage from "./locales/en/usage.json";
import enPlugins from "./locales/en/plugins.json";
import enAutomations from "./locales/en/automations.json";

import zhCommon from "./locales/zh/common.json";
import zhChat from "./locales/zh/chat.json";
import zhSettings from "./locales/zh/settings.json";
import zhUsage from "./locales/zh/usage.json";
import zhPlugins from "./locales/zh/plugins.json";
import zhAutomations from "./locales/zh/automations.json";

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: {
        common: enCommon,
        chat: enChat,
        settings: enSettings,
        usage: enUsage,
        plugins: enPlugins,
        automations: enAutomations,
      },
      zh: {
        common: zhCommon,
        chat: zhChat,
        settings: zhSettings,
        usage: zhUsage,
        plugins: zhPlugins,
        automations: zhAutomations,
      },
    },
    fallbackLng: "en",
    defaultNS: "common",
    ns: ["common", "chat", "settings", "usage", "plugins", "automations"],
    interpolation: {
      escapeValue: false,
    },
    detection: {
      order: ["localStorage", "navigator"],
      lookupLocalStorage: "openyak-language",
      caches: ["localStorage"],
    },
  });

export default i18n;
