import { formatUsdcAmount, parseUsdcAmountToMicros } from './arc-tip-service.mjs';
import { arcUsdcTokenAddress } from '../scripts/shared.mjs';

function parseNonNegativeUsdcMicros(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(text)) return null;
  if (Number(text) === 0) return 0n;
  return parseUsdcAmountToMicros(text, 'balance');
}

function isPositiveDecimal(value) {
  const text = String(value ?? '').trim();
  return /^\d+(?:\.\d+)?$/.test(text) && Number(text) > 0;
}

export function extractArcWalletBalances(response) {
  const tokenBalances = Array.isArray(response?.data?.tokenBalances) ? response.data.tokenBalances : [];
  const usdc = tokenBalances.find((entry) => (
    String(entry?.token?.tokenAddress ?? '').toLowerCase() === arcUsdcTokenAddress.toLowerCase()
  ));
  const native = tokenBalances.find((entry) => Boolean(entry?.token?.isNative));

  return {
    available: true,
    usdc: String(usdc?.amount ?? '0'),
    native: String(native?.amount ?? '0'),
  };
}

export function buildSchedulePreflight({
  recipient,
  amount,
  walletReady,
  autonomousEnabled,
  allowlist = [],
  perTipCap,
  weeklyBudget,
  reservedWeeklyMicros = 0n,
  balances = { available: false, usdc: null, native: null },
}) {
  const requestedMicros = parseUsdcAmountToMicros(String(amount), 'amount');
  const perTipCapMicros = parseUsdcAmountToMicros(String(perTipCap), 'perTipCap');
  const weeklyBudgetMicros = parseUsdcAmountToMicros(String(weeklyBudget), 'weeklyBudget');
  const remainingWeeklyMicros = weeklyBudgetMicros > reservedWeeklyMicros
    ? weeklyBudgetMicros - reservedWeeklyMicros
    : 0n;
  const usdcBalanceMicros = balances.available ? parseNonNegativeUsdcMicros(balances.usdc) : null;
  const normalizedRecipient = String(recipient).toLowerCase();
  const normalizedAllowlist = allowlist.map((entry) => String(entry?.recipient ?? entry).toLowerCase());

  const checks = {
    walletReady: Boolean(walletReady),
    autonomousEnabled: Boolean(autonomousEnabled),
    recipientAllowed: normalizedAllowlist.length === 0 || normalizedAllowlist.includes(normalizedRecipient),
    withinPerTipCap: requestedMicros <= perTipCapMicros,
    withinWeeklyBudget: requestedMicros <= remainingWeeklyMicros,
    balanceAvailable: Boolean(balances.available) && usdcBalanceMicros !== null,
    sufficientUsdcBalance: usdcBalanceMicros !== null && requestedMicros <= usdcBalanceMicros,
    gasAvailable: Boolean(balances.available) && isPositiveDecimal(balances.native),
  };

  return {
    ready: Object.values(checks).every(Boolean),
    checks,
    requestedAmount: formatUsdcAmount(requestedMicros),
    limits: {
      perTipCap: formatUsdcAmount(perTipCapMicros),
      weeklyBudget: formatUsdcAmount(weeklyBudgetMicros),
      reservedWeekly: formatUsdcAmount(reservedWeeklyMicros),
      remainingWeekly: formatUsdcAmount(remainingWeeklyMicros),
    },
    balances: {
      usdc: balances.available ? String(balances.usdc ?? '0') : null,
      native: balances.available ? String(balances.native ?? '0') : null,
    },
  };
}
