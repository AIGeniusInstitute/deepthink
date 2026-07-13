import { useBillingStore } from '../../stores/billing';

/**
 * Format a USD amount with optional currency conversion.
 */
export function formatAmount(amount: number, currency?: string, rate?: number): string {
  const converted = amount * (rate ?? 1);
  const symbol = currency && currency !== 'USD' ? currency : '$';
  if (symbol === '$') return `$${converted.toFixed(2)}`;
  return `${symbol} ${converted.toFixed(2)}`;
}

/**
 * Format a token count in human-readable form (K / M).
 */
export function formatTokens(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`;
  return String(count);
}

/**
 * Hook that returns a currency-aware formatter bound to the billing store.
 */
export function useCurrency() {
  const currency = useBillingStore((s) => s.billingCurrency);
  const rate = useBillingStore((s) => s.billingCurrencyRate);
  return (amount: number) => formatAmount(amount, currency, rate);
}
