import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import {
  arcBlockchain,
  arcScanTxBaseUrl,
  arcUsdcTokenAddress,
  fileExists,
  isTerminalState,
  loadEnv,
  normalizeCircleError,
  readJson,
  requireEnv,
  rootDir,
  sleep,
  validatePositiveAmount,
  validateRecipientAddress,
  walletJsonPath,
  writeJson,
} from '../scripts/shared.mjs';

export const policyPath = path.join(rootDir, 'policy.json');
export const ledgerPath = path.join(rootDir, 'ledger.json');
export const tokenPath = path.join(rootDir, '.token');
export const usdcMicrosPerUnit = 1_000_000n;

export const defaultPolicy = Object.freeze({
  weeklyBudget: '20',
  perTipCap: '5',
  allowlist: ['0xB87B6D1a56bB7942bd07b6B0e9540a63b3dA4365'],
});

let ledgerCache;

export function formatUsdcAmount(micros) {
  const value = BigInt(micros);
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const whole = absolute / usdcMicrosPerUnit;
  const fraction = (absolute % usdcMicrosPerUnit).toString().padStart(6, '0').replace(/0+$/, '');
  return `${negative ? '-' : ''}${whole.toString()}${fraction ? `.${fraction}` : ''}`;
}

export function parseUsdcAmountToMicros(value, fieldName = 'amount') {
  const text = String(value ?? '').trim();
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new Error(`${fieldName} must be a positive decimal string.`);
  }

  const [wholePart, fractionPart = ''] = text.split('.');
  if (fractionPart.length > 6) {
    throw new Error(`${fieldName} must have at most 6 decimal places.`);
  }

  const whole = BigInt(wholePart);
  const fraction = BigInt((fractionPart + '000000').slice(0, 6));
  const micros = whole * usdcMicrosPerUnit + fraction;
  if (micros <= 0n) {
    throw new Error(`${fieldName} must be greater than 0.`);
  }
  return micros;
}

export function normalizePolicyAddress(value) {
  return validateRecipientAddress(String(value).trim()).toLowerCase();
}

async function ensureJsonFile(filePath, seedValue) {
  if (!(await fileExists(filePath))) {
    await writeJson(filePath, seedValue);
  }
}

function parseAllowlistEnv(value) {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function normalizePolicyConfig(rawPolicy = {}, fallbackPolicy = defaultPolicy) {
  const source = rawPolicy && typeof rawPolicy === 'object' ? rawPolicy : {};
  const weeklyBudget = source.weeklyBudget ?? fallbackPolicy.weeklyBudget;
  const perTipCap = source.perTipCap ?? fallbackPolicy.perTipCap;
  const allowlistSource = Array.isArray(source.allowlist) ? source.allowlist : fallbackPolicy.allowlist;
  const allowlist = [...new Set(allowlistSource.map((entry) => normalizePolicyAddress(entry)))];

  return {
    weeklyBudgetMicros: parseUsdcAmountToMicros(weeklyBudget, 'weeklyBudget'),
    perTipCapMicros: parseUsdcAmountToMicros(perTipCap, 'perTipCap'),
    allowlist,
    raw: {
      weeklyBudget,
      perTipCap,
      allowlist,
    },
  };
}

async function readPolicyFileOrDefault() {
  if (!(await fileExists(policyPath))) {
    try {
      await writeJson(policyPath, defaultPolicy);
    } catch (error) {
      console.warn(`[policy] Could not create ${policyPath}; using in-memory defaults. ${normalizeCircleError(error).text}`);
    }
    return defaultPolicy;
  }

  const raw = await readJson(policyPath);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Invalid policy file at ${policyPath}: expected a JSON object.`);
  }
  return raw;
}

export async function loadPolicy() {
  const overrides = {};
  let hasOverrides = false;

  const weeklyBudget = process.env.WEEKLY_BUDGET?.trim();
  if (weeklyBudget) {
    overrides.weeklyBudget = weeklyBudget;
    hasOverrides = true;
  }

  const perTipCap = process.env.PER_TIP_CAP?.trim();
  if (perTipCap) {
    overrides.perTipCap = perTipCap;
    hasOverrides = true;
  }

  const allowlist = process.env.ALLOWLIST?.trim();
  if (allowlist) {
    overrides.allowlist = parseAllowlistEnv(allowlist);
    hasOverrides = true;
  }

  try {
    const filePolicy = await readPolicyFileOrDefault();
    return normalizePolicyConfig(hasOverrides ? { ...filePolicy, ...overrides } : filePolicy);
  } catch (error) {
    if (hasOverrides) {
      return normalizePolicyConfig({ ...defaultPolicy, ...overrides });
    }

    console.warn(`[policy] Using defaults because ${policyPath} could not be read. ${normalizeCircleError(error).text}`);
    return normalizePolicyConfig(defaultPolicy);
  }
}

async function readLedgerFileOrDefault() {
  if (!(await fileExists(ledgerPath))) {
    try {
      await writeJson(ledgerPath, []);
    } catch (error) {
      console.warn(`[ledger] Could not create ${ledgerPath}; using in-memory ledger only. ${normalizeCircleError(error).text}`);
    }
    return [];
  }

  const ledger = await readJson(ledgerPath);
  if (!Array.isArray(ledger)) {
    throw new Error(`Invalid ledger file at ${ledgerPath}: expected a JSON array.`);
  }
  return ledger;
}

export async function loadLedger() {
  if (ledgerCache !== undefined) {
    return ledgerCache;
  }

  try {
    ledgerCache = await readLedgerFileOrDefault();
  } catch (error) {
    console.warn(`[ledger] Using in-memory ledger because ${ledgerPath} could not be read. ${normalizeCircleError(error).text}`);
    ledgerCache = [];
  }

  return ledgerCache;
}

export function sumLedgerSpendMicros(ledger, cutoffTimestampMs = Date.now() - 7 * 24 * 60 * 60 * 1000) {
  return ledger.reduce((sum, entry) => {
    if (String(entry?.state ?? '').toUpperCase() !== 'COMPLETE') {
      return sum;
    }

    const timestampMs = Date.parse(entry?.timestamp ?? '');
    if (!Number.isFinite(timestampMs) || timestampMs < cutoffTimestampMs) {
      return sum;
    }

    const amountMicros = entry?.amountMicros !== undefined
      ? BigInt(String(entry.amountMicros))
      : parseUsdcAmountToMicros(entry?.amount, 'ledger.amount');

    return sum + amountMicros;
  }, 0n);
}

export async function appendLedgerEntry(entry) {
  const ledger = await loadLedger();
  ledger.push({
    ...entry,
    timestamp: entry.timestamp ?? new Date().toISOString(),
    amountMicros: String(entry.amountMicros),
  });
  try {
    await writeJson(ledgerPath, ledger);
  } catch (error) {
    console.warn(`[ledger] Could not write ${ledgerPath}; keeping in-memory ledger only. ${normalizeCircleError(error).text}`);
  }
}

export async function loadOrCreateBearerToken() {
  const envToken = process.env.AGENT_BEARER_TOKEN?.trim();
  if (envToken) {
    return {
      token: envToken,
      source: 'env',
    };
  }

  if (await fileExists(tokenPath)) {
    const token = (await fs.readFile(tokenPath, 'utf8')).trim();
    if (token) {
      return {
        token,
        source: 'file',
      };
    }
  }

  const token = crypto.randomBytes(32).toString('hex');
  try {
    await fs.writeFile(tokenPath, `${token}\n`, 'utf8');
  } catch (error) {
    console.warn(`[token] Could not write ${tokenPath}; bearer token will only live in memory. ${normalizeCircleError(error).text}`);
  }

  return {
    token,
    source: 'generated',
  };
}

async function resolveWalletConfig() {
  const envWalletId = process.env.WALLET_ID?.trim();
  const envWalletAddress = process.env.WALLET_ADDRESS?.trim();

  if (envWalletId && envWalletAddress) {
    return {
      walletId: envWalletId,
      walletAddress: validateRecipientAddress(envWalletAddress),
      source: 'env',
    };
  }

  if (!(await fileExists(walletJsonPath))) {
    throw new Error('wallet.json is missing. Set WALLET_ID and WALLET_ADDRESS in Railway or run npm run create-wallet first.');
  }

  const wallet = await readJson(walletJsonPath);
  if (!wallet || typeof wallet !== 'object' || Array.isArray(wallet)) {
    throw new Error(`Invalid wallet file at ${walletJsonPath}: expected a JSON object.`);
  }

  if (wallet?.blockchain && wallet.blockchain !== arcBlockchain) {
    throw new Error(`wallet.json blockchain must be ${arcBlockchain}.`);
  }

  const walletId = envWalletId || String(wallet.walletId ?? '').trim();
  const walletAddress = envWalletAddress || String(wallet.address ?? '').trim();

  if (!walletId) {
    throw new Error('wallet.json is missing walletId. Set WALLET_ID in Railway or recreate the wallet locally.');
  }

  if (!walletAddress) {
    throw new Error('wallet.json is missing address. Set WALLET_ADDRESS in Railway or recreate the wallet locally.');
  }

  return {
    walletId,
    walletAddress: validateRecipientAddress(walletAddress),
    source: 'file',
  };
}

export async function createCircleTipContext() {
  loadEnv();
  const apiKey = requireEnv('CIRCLE_API_KEY');
  const entitySecret = requireEnv('CIRCLE_ENTITY_SECRET');
  const { walletId, walletAddress } = await resolveWalletConfig();

  const client = initiateDeveloperControlledWalletsClient({
    apiKey,
    entitySecret,
  });

  return {
    client,
    walletId,
    walletAddress,
  };
}

function extractTransactionSnapshot(response) {
  const transaction = response?.data?.transaction ?? response?.data ?? {};
  return {
    id: transaction?.id ?? response?.data?.id ?? '',
    state: transaction?.state ?? transaction?.transactionState ?? transaction?.status ?? '',
    txHash: transaction?.txHash ?? transaction?.transactionHash ?? transaction?.hash ?? '',
    errorReason: transaction?.errorReason ?? transaction?.error_reason ?? '',
    errorDetails: transaction?.errorDetails ?? transaction?.error_details ?? '',
    transaction,
  };
}

export async function fetchCircleTipStatus(client, txId) {
  const response = await client.getTransaction({ id: txId });
  const snapshot = extractTransactionSnapshot(response);
  return {
    id: snapshot.id || txId,
    state: snapshot.state || 'UNKNOWN',
    txHash: snapshot.txHash || null,
    errorReason: snapshot.errorReason || null,
    errorDetails: snapshot.errorDetails || null,
    arcscanUrl: snapshot.txHash ? `${arcScanTxBaseUrl}${snapshot.txHash}` : null,
    transaction: snapshot.transaction,
  };
}

export async function waitForCircleTipCompletion(client, txId, { pollIntervalMs = 5000, onState } = {}) {
  let lastState = '';
  let txHash = '';

  for (;;) {
    const status = await fetchCircleTipStatus(client, txId);
    if (status.state && status.state !== lastState) {
      lastState = status.state;
      onState?.(status.state, status);
    }

    if (status.txHash) {
      txHash = status.txHash;
    }

    if (isTerminalState(status.state)) {
      return {
        id: status.id || txId,
        state: status.state,
        txHash: txHash || null,
        errorReason: status.errorReason ?? null,
        errorDetails: status.errorDetails ?? null,
        arcscanUrl: txHash ? `${arcScanTxBaseUrl}${txHash}` : null,
      };
    }

    await sleep(pollIntervalMs);
  }
}

export async function submitTipTransfer(
  context,
  {
    recipient,
    amount,
    walletId = context.walletId,
    idempotencyKey = crypto.randomUUID(),
    pollIntervalMs = 5000,
    onState,
  } = {},
) {
  const sourceWalletId = String(walletId ?? '').trim();
  if (!sourceWalletId) {
    throw new Error('walletId is required to submit a transfer.');
  }

  const normalizedRecipient = validateRecipientAddress(recipient);
  const normalizedAmount = validatePositiveAmount(String(amount).trim());
  const createResponse = await context.client.createTransaction({
    walletId: sourceWalletId,
    blockchain: arcBlockchain,
    tokenAddress: arcUsdcTokenAddress,
    destinationAddress: normalizedRecipient,
    amounts: [normalizedAmount],
    fee: { type: 'level', config: { feeLevel: 'MEDIUM' } },
    idempotencyKey,
  });

  const txId = createResponse?.data?.id ?? createResponse?.data?.transaction?.id;
  if (!txId) {
    throw new Error('createTransaction did not return a transaction id.');
  }

  return waitForCircleTipCompletion(context.client, txId, { pollIntervalMs, onState });
}

export function normalizeCircleFailure(error) {
  const normalized = normalizeCircleError(error);
  return {
    ...normalized,
    message: normalized.text,
  };
}
