import { describe, it, expect } from 'vitest';
import { buildLanguageDirective, DEFAULT_LANGUAGE } from '../../container/agent-runner/src/i18n-directive.js';

describe('buildLanguageDirective', () => {
  it('returns a directive containing the language code and name', () => {
    const directive = buildLanguageDirective('en');
    expect(directive).toContain('en');
    expect(directive).toContain('English');
    expect(directive).toMatch(/must/i);
  });

  it('falls back to default language when input is undefined or empty', () => {
    const fromUndefined = buildLanguageDirective(undefined);
    const fromEmpty = buildLanguageDirective('');
    const fromWhitespace = buildLanguageDirective('   ');
    expect(fromUndefined).toContain(DEFAULT_LANGUAGE);
    expect(fromEmpty).toContain(DEFAULT_LANGUAGE);
    expect(fromWhitespace).toContain(DEFAULT_LANGUAGE);
  });

  it('renders a known code with its native name in parentheses', () => {
    const ja = buildLanguageDirective('ja');
    expect(ja).toContain('Japanese');
    expect(ja).toContain('日本語');
  });

  it('falls back to the raw code for unknown language codes', () => {
    const directive = buildLanguageDirective('xx-YY');
    expect(directive).toContain('xx-YY');
  });

  it('is wrapped in a response-language tag', () => {
    const directive = buildLanguageDirective('fr');
    expect(directive).toContain('<response-language>');
    expect(directive).toContain('</response-language>');
  });

  it('is non-empty for every supported language', () => {
    const codes = [
      'zh-CN', 'en', 'es', 'hi', 'ar', 'bn', 'pt', 'ru', 'ja', 'de',
      'fr', 'id', 'ur', 'mr', 'te', 'tr', 'ta', 'ko', 'vi', 'it',
      'pl', 'uk', 'nl', 'th', 'gu', 'ms', 'kn', 'fa', 'sv', 'cs',
    ];
    for (const code of codes) {
      const directive = buildLanguageDirective(code);
      expect(directive.length).toBeGreaterThan(50);
      expect(directive).toContain(code);
    }
  });
});
