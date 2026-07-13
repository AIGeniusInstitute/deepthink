import { describe, it, expect } from 'vitest';
import {
  SUPPORTED_LANGUAGES,
  LANGUAGE_CODES,
  DEFAULT_LANGUAGE,
  isSupportedLanguage,
  isRtlLanguage,
  getLanguageMeta,
} from '../../src/i18n-languages.js';

describe('i18n-languages', () => {
  it('exposes 30 supported languages', () => {
    expect(SUPPORTED_LANGUAGES.length).toBe(30);
    expect(LANGUAGE_CODES.length).toBe(30);
  });

  it('defaults to zh-CN', () => {
    expect(DEFAULT_LANGUAGE).toBe('zh-CN');
    expect(LANGUAGE_CODES).toContain(DEFAULT_LANGUAGE);
  });

  it('each language has a unique code, non-empty name and native, and a boolean rtl', () => {
    const codes = new Set<string>();
    for (const lang of SUPPORTED_LANGUAGES) {
      expect(typeof lang.code).toBe('string');
      expect(lang.code.length).toBeGreaterThan(0);
      expect(typeof lang.name).toBe('string');
      expect(lang.name.length).toBeGreaterThan(0);
      expect(typeof lang.native).toBe('string');
      expect(lang.native.length).toBeGreaterThan(0);
      expect(typeof lang.rtl).toBe('boolean');
      expect(codes.has(lang.code)).toBe(false);
      codes.add(lang.code);
    }
  });

  it('marks ar, ur, fa as RTL and everything else as LTR', () => {
    expect(isRtlLanguage('ar')).toBe(true);
    expect(isRtlLanguage('ur')).toBe(true);
    expect(isRtlLanguage('fa')).toBe(true);
    expect(isRtlLanguage('en')).toBe(false);
    expect(isRtlLanguage('zh-CN')).toBe(false);
    expect(isRtlLanguage('unknown')).toBe(false);
  });

  it('isSupportedLanguage returns true for known codes only', () => {
    expect(isSupportedLanguage('en')).toBe(true);
    expect(isSupportedLanguage('zh-CN')).toBe(true);
    expect(isSupportedLanguage('xx-YY')).toBe(false);
    expect(isSupportedLanguage('')).toBe(false);
  });

  it('getLanguageMeta returns metadata or undefined', () => {
    expect(getLanguageMeta('en')?.native).toBe('English');
    expect(getLanguageMeta('ja')?.name).toBe('Japanese');
    expect(getLanguageMeta('xx-YY')).toBeUndefined();
  });

  it('whitelist includes the most-spoken world languages', () => {
    // Sanity: these 10 codes must always be present.
    for (const code of ['zh-CN', 'en', 'es', 'hi', 'ar', 'pt', 'ru', 'ja', 'de', 'fr']) {
      expect(LANGUAGE_CODES).toContain(code);
    }
  });
});
