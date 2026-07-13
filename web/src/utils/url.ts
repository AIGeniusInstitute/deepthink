function normalizeBasePath(rawBase: string): string {
  const trimmed = rawBase.trim();
  if (!trimmed) return '/';

  let base = trimmed;
  if (!base.startsWith('/')) base = `/${base}`;
  if (!base.endsWith('/')) base = `${base}/`;
  return base;
}

export const APP_BASE = normalizeBasePath(import.meta.env.BASE_URL || '/');

function isNavigatorStandalone(): boolean {
  if (typeof navigator === 'undefined') return false;
  const navWithStandalone = navigator as Navigator & { standalone?: boolean };
  return Boolean(navWithStandalone.standalone);
}

export function isStandaloneMode(): boolean {
  if (typeof window === 'undefined') return false;
  const displayStandalone = window.matchMedia?.('(display-mode: standalone)').matches ?? false;
  return displayStandalone || isNavigatorStandalone();
}

export function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  const iOS = /iPad|iPhone|iPod/i.test(ua);
  const iPadOSDesktopUA = navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  return iOS || iPadOSDesktopUA;
}

export function shouldUseHashRouter(): boolean {
  return isStandaloneMode() && isIOSDevice();
}

export function withBasePath(path: string): string {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  if (APP_BASE === '/') return normalized;
  const baseNoTrailingSlash = APP_BASE.slice(0, -1);
  return `${baseNoTrailingSlash}${normalized}`;
}

export function replaceInApp(path: string): void {
  if (typeof window === 'undefined') return;
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const fullPath = withBasePath(normalized);
  if (window.__DEEPTHINK_HASH_ROUTER__) {
    // Hash router: 保留当前 pathname，用 hash 承载路由（含 APP_BASE）
    const target = `${window.location.origin}${window.location.pathname}#${fullPath}`;
    window.location.replace(target);
  } else {
    window.location.replace(fullPath);
  }
}

export function stripBasePath(pathname: string): string {
  if (APP_BASE === '/') return pathname || '/';
  const baseNoTrailingSlash = APP_BASE.slice(0, -1);
  if (pathname === baseNoTrailingSlash) return '/';
  if (pathname.startsWith(`${baseNoTrailingSlash}/`)) {
    return pathname.slice(baseNoTrailingSlash.length) || '/';
  }
  return pathname || '/';
}
