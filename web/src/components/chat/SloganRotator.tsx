import { useEffect, useState } from 'react';

const SLOGANS = [
  '深度思考，自主进化。',
  'Think deep. Act autonomously.',
  '让任务自己跑完。',
  'Loop until done.',
  '从指令到自治，从自治到超越。',
];

const STORAGE_KEY = 'deepthink:slogan-index';
const ROTATE_MS = 15_000;

export function isDefaultHomeName(name: string, username?: string): boolean {
  return !name || name === 'Main' || (username ? name === `${username} Home` : name.endsWith(' Home'));
}

export function SloganRotator({ className = '' }: { className?: string }) {
  const [idx, setIdx] = useState<number>(() => {
    const stored = typeof localStorage !== 'undefined' ? localStorage.getItem(STORAGE_KEY) : null;
    const n = stored ? parseInt(stored, 10) : 0;
    return Number.isFinite(n) ? n % SLOGANS.length : 0;
  });

  useEffect(() => {
    const t = setInterval(() => {
      setIdx((i) => {
        const next = (i + 1) % SLOGANS.length;
        try {
          localStorage.setItem(STORAGE_KEY, String(next));
        } catch {
          // ignore storage failures
        }
        return next;
      });
    }, ROTATE_MS);
    return () => clearInterval(t);
  }, []);

  return (
    <span className={className} title="DeepThink">
      {SLOGANS[idx]}
    </span>
  );
}
