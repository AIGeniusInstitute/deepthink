import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import LanguageDetector from 'i18next-browser-languagedetector';

import zhCN from './locales/zh-CN/common.json';
import en from './locales/en/common.json';
import es from './locales/es/common.json';
import hi from './locales/hi/common.json';
import ar from './locales/ar/common.json';
import bn from './locales/bn/common.json';
import pt from './locales/pt/common.json';
import ru from './locales/ru/common.json';
import ja from './locales/ja/common.json';
import de from './locales/de/common.json';
import fr from './locales/fr/common.json';
import id from './locales/id/common.json';
import ur from './locales/ur/common.json';
import mr from './locales/mr/common.json';
import te from './locales/te/common.json';
import tr from './locales/tr/common.json';
import ta from './locales/ta/common.json';
import ko from './locales/ko/common.json';
import vi from './locales/vi/common.json';
import it from './locales/it/common.json';
import pl from './locales/pl/common.json';
import uk from './locales/uk/common.json';
import nl from './locales/nl/common.json';
import th from './locales/th/common.json';
import gu from './locales/gu/common.json';
import ms from './locales/ms/common.json';
import kn from './locales/kn/common.json';
import fa from './locales/fa/common.json';
import sv from './locales/sv/common.json';
import cs from './locales/cs/common.json';

import { DEFAULT_LANGUAGE, isRtlLanguage } from './languages';

export const APP_I18N = i18n;

export function applyHtmlLangDir(code: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.lang = code;
  document.documentElement.dir = isRtlLanguage(code) ? 'rtl' : 'ltr';
}

i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      'zh-CN': { common: zhCN },
      en: { common: en },
      es: { common: es },
      hi: { common: hi },
      ar: { common: ar },
      bn: { common: bn },
      pt: { common: pt },
      ru: { common: ru },
      ja: { common: ja },
      de: { common: de },
      fr: { common: fr },
      id: { common: id },
      ur: { common: ur },
      mr: { common: mr },
      te: { common: te },
      tr: { common: tr },
      ta: { common: ta },
      ko: { common: ko },
      vi: { common: vi },
      it: { common: it },
      pl: { common: pl },
      uk: { common: uk },
      nl: { common: nl },
      th: { common: th },
      gu: { common: gu },
      ms: { common: ms },
      kn: { common: kn },
      fa: { common: fa },
      sv: { common: sv },
      cs: { common: cs },
    },
    lng: DEFAULT_LANGUAGE,
    fallbackLng: DEFAULT_LANGUAGE,
    ns: ['common'],
    defaultNS: 'common',
    interpolation: { escapeValue: false },
    detection: {
      order: ['localStorage', 'navigator', 'htmlTag'],
      lookupLocalStorage: 'dt_lang',
      caches: ['localStorage'],
    },
  });

// Keep <html lang/dir> in sync with the active language.
i18n.on('languageChanged', (code: string) => {
  applyHtmlLangDir(code);
});
applyHtmlLangDir(i18n.language || DEFAULT_LANGUAGE);

export default i18n;
