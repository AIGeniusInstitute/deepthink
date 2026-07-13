/// <reference types="vite/client" />

declare module '*.css' {
  const content: string;
  export default content;
}

declare module 'mammoth/mammoth.browser.js' {
  const mammoth: {
    convertToHtml: (input: { arrayBuffer: ArrayBuffer }) => Promise<{ value: string; messages: unknown[] }>;
  };
  export default mammoth;
}

interface Window {
  __DEEPTHINK_HASH_ROUTER__?: boolean;
  hljs?: {
    highlight: (code: string, opts?: { language?: string; ignoreIllegals?: boolean }) => { value: string };
    highlightAuto: (code: string) => { value: string };
  };
}
