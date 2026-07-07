import { useCallback, useEffect, useSyncExternalStore } from 'react';

export type Theme = 'light' | 'dark' | 'system';
export type ColorScheme = 'default' | 'orange' | 'neutral';
export type FontStyle = 'default' | 'anthropic';

const THEME_KEY = 'deepthink-theme';
const SCHEME_KEY = 'deepthink-color-scheme';
const FONT_KEY = 'deepthink-font-style';
const listeners = new Set<() => void>();

function notify() { listeners.forEach((cb) => cb()); }

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

// 默认浅色：未设置过主题的用户不再跟随系统深色模式。
// 存储语义与之对称——无 key = light；「深色」「跟随系统」都显式落 key。
function readTheme(): Theme {
  if (typeof window === 'undefined') return 'light';
  const stored = window.localStorage.getItem(THEME_KEY);
  if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  return 'light';
}

function readColorScheme(): ColorScheme {
  if (typeof window === 'undefined') return 'neutral';
  const stored = window.localStorage.getItem(SCHEME_KEY);
  if (stored === 'default' || stored === 'orange' || stored === 'neutral') return stored;
  return 'neutral';
}

function readFontStyle(): FontStyle {
  if (typeof window === 'undefined') return 'default';
  const stored = window.localStorage.getItem(FONT_KEY);
  if (stored === 'default' || stored === 'anthropic') return stored;
  return 'default';
}

function resolveTheme(theme: Theme): 'light' | 'dark' {
  return theme === 'system' ? getSystemTheme() : theme;
}

function syncMetaThemeColor() {
  if (typeof document === 'undefined') return;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const isDark = document.documentElement.classList.contains('dark');
  const isNeutral = document.documentElement.classList.contains('theme-neutral');
  const isOrange = document.documentElement.classList.contains('theme-orange');
  if (isDark) {
    meta.setAttribute('content', isNeutral ? '#09090b' : '#0f172a');
  } else {
    meta.setAttribute('content', isOrange ? '#FAF9F5' : isNeutral ? '#ffffff' : '#ffffff');
  }
}

export function applyTheme(theme: Theme) {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('dark', resolveTheme(theme) === 'dark');
  syncMetaThemeColor();
}

function applyColorScheme(scheme: ColorScheme) {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('theme-orange', scheme === 'orange');
  document.documentElement.classList.toggle('theme-neutral', scheme === 'neutral');
  syncMetaThemeColor();
}

function applyFontStyle(style: FontStyle) {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('font-anthropic', style === 'anthropic');
}

function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function useTheme() {
  const theme = useSyncExternalStore(subscribe, readTheme, () => 'light' as Theme);
  const colorScheme = useSyncExternalStore(subscribe, readColorScheme, () => 'neutral' as ColorScheme);
  const fontStyle = useSyncExternalStore(subscribe, readFontStyle, () => 'default' as FontStyle);

  useEffect(() => { applyTheme(theme); }, [theme]);
  useEffect(() => { applyColorScheme(colorScheme); }, [colorScheme]);
  useEffect(() => { applyFontStyle(fontStyle); }, [fontStyle]);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = () => {
      if (readTheme() === 'system') { applyTheme('system'); notify(); }
    };
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  const setTheme = useCallback((t: Theme) => {
    if (t === 'light') window.localStorage.removeItem(THEME_KEY);
    else window.localStorage.setItem(THEME_KEY, t);
    applyTheme(t);
    notify();
  }, []);

  const setColorScheme = useCallback((s: ColorScheme) => {
    if (s === 'neutral') window.localStorage.removeItem(SCHEME_KEY);
    else window.localStorage.setItem(SCHEME_KEY, s);
    applyColorScheme(s);
    notify();
  }, []);

  const setFontStyle = useCallback((f: FontStyle) => {
    if (f === 'default') window.localStorage.removeItem(FONT_KEY);
    else window.localStorage.setItem(FONT_KEY, f);
    applyFontStyle(f);
    notify();
  }, []);

  const toggle = useCallback(() => {
    const next: Theme = theme === 'light' ? 'dark' : theme === 'dark' ? 'system' : 'light';
    setTheme(next);
  }, [theme, setTheme]);

  return { theme, resolvedTheme: resolveTheme(theme), colorScheme, fontStyle, toggle, setTheme, setColorScheme, setFontStyle };
}
