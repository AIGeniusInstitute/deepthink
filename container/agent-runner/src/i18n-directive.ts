/**
 * Build the system-prompt directive that tells the agent which language to use
 * for user-facing replies. Extracted as a pure function so tests can pin the
 * exact phrasing without booting the SDK.
 */

export const DEFAULT_LANGUAGE = 'zh-CN';

const LANGUAGE_NAMES: Record<string, string> = {
  'zh-CN': 'Simplified Chinese (简体中文)',
  en: 'English',
  es: 'Spanish (Español)',
  hi: 'Hindi (हिन्दी)',
  ar: 'Arabic (العربية)',
  bn: 'Bengali (বাংলা)',
  pt: 'Portuguese (Português)',
  ru: 'Russian (Русский)',
  ja: 'Japanese (日本語)',
  de: 'German (Deutsch)',
  fr: 'French (Français)',
  id: 'Indonesian (Bahasa Indonesia)',
  ur: 'Urdu (اردو)',
  mr: 'Marathi (मराठी)',
  te: 'Telugu (తెలుగు)',
  tr: 'Turkish (Türkçe)',
  ta: 'Tamil (தமிழ்)',
  ko: 'Korean (한국어)',
  vi: 'Vietnamese (Tiếng Việt)',
  it: 'Italian (Italiano)',
  pl: 'Polish (Polski)',
  uk: 'Ukrainian (Українська)',
  nl: 'Dutch (Nederlands)',
  th: 'Thai (ไทย)',
  gu: 'Gujarati (ગુજરાતી)',
  ms: 'Malay (Bahasa Melayu)',
  kn: 'Kannada (ಕನ್ನಡ)',
  fa: 'Persian (فارسی)',
  sv: 'Swedish (Svenska)',
  cs: 'Czech (Čeština)',
};

/**
 * Returns the system-prompt fragment that instructs the agent to reply in the
 * user's preferred language. Always returns a non-empty string so the directive
 * is explicit even when the user has not configured a language.
 */
export function buildLanguageDirective(userLanguage: string | undefined): string {
  const code = userLanguage && userLanguage.trim() ? userLanguage.trim() : DEFAULT_LANGUAGE;
  const name = LANGUAGE_NAMES[code] ?? code;
  return `<response-language>
The user's preferred response language is **${code}** (${name}).
You MUST respond to the user in ${name} for all non-code text: explanations, summaries, status updates, error messages, and conversational replies.
Tool inputs (file paths, shell commands, code identifiers) remain language-neutral.
If the user explicitly requests a different language in a specific message, follow that request for that message only — otherwise stay in ${name}.
</response-language>`;
}
