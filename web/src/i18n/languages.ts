/**
 * Frontend mirror of src/i18n-languages.ts.
 *
 * Keep in sync with the backend file when adding/removing languages.
 * Used by:
 * - web/src/i18n/config.ts (resource registration)
 * - web/src/components/settings/LanguageSection.tsx (switcher dropdown)
 */

export interface LanguageMeta {
  code: string;
  /** English name */
  name: string;
  /** Native name (endonym) */
  native: string;
  /** Right-to-left script */
  rtl: boolean;
}

export const SUPPORTED_LANGUAGES: readonly LanguageMeta[] = [
  { code: 'zh-CN', name: 'Chinese (Simplified)', native: '简体中文', rtl: false },
  { code: 'en', name: 'English', native: 'English', rtl: false },
  { code: 'es', name: 'Spanish', native: 'Español', rtl: false },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी', rtl: false },
  { code: 'ar', name: 'Arabic', native: 'العربية', rtl: true },
  { code: 'bn', name: 'Bengali', native: 'বাংলা', rtl: false },
  { code: 'pt', name: 'Portuguese', native: 'Português', rtl: false },
  { code: 'ru', name: 'Russian', native: 'Русский', rtl: false },
  { code: 'ja', name: 'Japanese', native: '日本語', rtl: false },
  { code: 'de', name: 'German', native: 'Deutsch', rtl: false },
  { code: 'fr', name: 'French', native: 'Français', rtl: false },
  { code: 'id', name: 'Indonesian', native: 'Bahasa Indonesia', rtl: false },
  { code: 'ur', name: 'Urdu', native: 'اردو', rtl: true },
  { code: 'mr', name: 'Marathi', native: 'मराठी', rtl: false },
  { code: 'te', name: 'Telugu', native: 'తెలుగు', rtl: false },
  { code: 'tr', name: 'Turkish', native: 'Türkçe', rtl: false },
  { code: 'ta', name: 'Tamil', native: 'தமிழ்', rtl: false },
  { code: 'ko', name: 'Korean', native: '한국어', rtl: false },
  { code: 'vi', name: 'Vietnamese', native: 'Tiếng Việt', rtl: false },
  { code: 'it', name: 'Italian', native: 'Italiano', rtl: false },
  { code: 'pl', name: 'Polish', native: 'Polski', rtl: false },
  { code: 'uk', name: 'Ukrainian', native: 'Українська', rtl: false },
  { code: 'nl', name: 'Dutch', native: 'Nederlands', rtl: false },
  { code: 'th', name: 'Thai', native: 'ไทย', rtl: false },
  { code: 'gu', name: 'Gujarati', native: 'ગુજરાતી', rtl: false },
  { code: 'ms', name: 'Malay', native: 'Bahasa Melayu', rtl: false },
  { code: 'kn', name: 'Kannada', native: 'ಕನ್ನಡ', rtl: false },
  { code: 'fa', name: 'Persian', native: 'فارسی', rtl: true },
  { code: 'sv', name: 'Swedish', native: 'Svenska', rtl: false },
  { code: 'cs', name: 'Czech', native: 'Čeština', rtl: false },
];

export const LANGUAGE_CODES: readonly string[] = SUPPORTED_LANGUAGES.map(
  (l) => l.code,
);

export const DEFAULT_LANGUAGE = 'zh-CN';

export function isRtlLanguage(code: string): boolean {
  return SUPPORTED_LANGUAGES.find((l) => l.code === code)?.rtl ?? false;
}

export function getLanguageMeta(code: string): LanguageMeta | undefined {
  return SUPPORTED_LANGUAGES.find((l) => l.code === code);
}
