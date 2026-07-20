import assert from 'node:assert/strict';
import test from 'node:test';
import { arcUsdcTokenAddress } from '../scripts/shared.mjs';
import {
  buildSchedulePreflight,
  extractArcWalletBalances,
} from '../src/schedule-preflight.mjs';

const recipient = '0xb87b6d1a56bb7942bd07b6b0e9540a63b3da4365';

test('builds a ready, read-only Arc schedule preflight', () => {
  const result = buildSchedulePreflight({
    recipient,
    amount: '1.5',
    walletReady: true,
    autonomousEnabled: true,
    allowlist: [{ recipient }],
    perTipCap: '5',
    weeklyBudget: '20',
    reservedWeeklyMicros: 2_000_000n,
    balances: { available: true, usdc: '10', native: '0.25' },
  });

  assert.equal(result.ready, true);
  assert.deepEqual(result.limits, {
    perTipCap: '5',
    weeklyBudget: '20',
    reservedWeekly: '2',
    remainingWeekly: '18',
  });
  assert.ok(Object.values(result.checks).every(Boolean));
});

test('reports policy, budget, balance, and gas blockers without throwing', () => {
  const result = buildSchedulePreflight({
    recipient,
    amount: '4',
    walletReady: true,
    autonomousEnabled: true,
    allowlist: [{ recipient: '0x0000000000000000000000000000000000000001' }],
    perTipCap: '3',
    weeklyBudget: '5',
    reservedWeeklyMicros: 3_000_000n,
    balances: { available: true, usdc: '1', native: '0' },
  });

  assert.equal(result.ready, false);
  assert.equal(result.checks.recipientAllowed, false);
  assert.equal(result.checks.withinPerTipCap, false);
  assert.equal(result.checks.withinWeeklyBudget, false);
  assert.equal(result.checks.sufficientUsdcBalance, false);
  assert.equal(result.checks.gasAvailable, false);
});

test('extracts Arc ERC-20 USDC and native gas balances from Circle', () => {
  assert.deepEqual(extractArcWalletBalances({
    data: {
      tokenBalances: [
        { amount: '0.42', token: { isNative: true, tokenAddress: '0x0' } },
        { amount: '12.75', token: { isNative: false, tokenAddress: arcUsdcTokenAddress.toUpperCase() } },
      ],
    },
  }), {
    available: true,
    usdc: '12.75',
    native: '0.42',
  });
});
