import crypto from 'node:crypto';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { arcBlockchain, loadEnv, requireEnv } from '../scripts/shared.mjs';
import { query, withTransaction } from './db.mjs';

export const defaultAgentPolicy = Object.freeze({
  weeklyBudget: 20,
  perTipCap: 5,
  autonomousEnabled: false,
});

let walletClient;

function getCircleWalletClient() {
  if (!walletClient) {
    loadEnv();
    const apiKey = requireEnv('CIRCLE_API_KEY');
    const entitySecret = requireEnv('CIRCLE_ENTITY_SECRET');
    walletClient = initiateDeveloperControlledWalletsClient({
      apiKey,
      entitySecret,
    });
  }

  return walletClient;
}

function buildIdempotencyKey(userId, purpose) {
  return crypto
    .createHash('sha256')
    .update(`agent-wallet:${purpose}:${String(userId)}`)
    .digest('hex');
}

function normalizeNumber(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : value;
}

function normalizeBoolean(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return value !== 0;
  }

  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === 't' || normalized === '1' || normalized === 'yes') {
    return true;
  }

  if (normalized === 'false' || normalized === 'f' || normalized === '0' || normalized === 'no') {
    return false;
  }

  return Boolean(value);
}

function normalizePolicyRow(row) {
  if (!row) {
    return null;
  }

  return {
    weeklyBudget: normalizeNumber(row.weekly_budget ?? row.weeklyBudget),
    perTipCap: normalizeNumber(row.per_tip_cap ?? row.perTipCap),
    autonomousEnabled: normalizeBoolean(row.autonomous_enabled ?? row.autonomousEnabled),
  };
}

function extractWalletSetId(response) {
  return response?.data?.walletSet?.id ?? response?.data?.id ?? null;
}

async function createCircleWallet(userId) {
  const client = getCircleWalletClient();
  const walletSetResponse = await client.createWalletSet({
    name: `ArcCopilot agent wallet ${String(userId)}`,
    idempotencyKey: buildIdempotencyKey(userId, 'wallet-set'),
  });

  const walletSetId = extractWalletSetId(walletSetResponse);
  if (!walletSetId) {
    throw new Error('createWalletSet did not return a wallet set id.');
  }

  const walletsResponse = await client.createWallets({
    walletSetId,
    accountType: 'EOA',
    blockchains: [arcBlockchain],
    count: 1,
    idempotencyKey: buildIdempotencyKey(userId, 'wallet'),
  });

  const wallet = walletsResponse?.data?.wallets?.[0];
  if (!wallet?.id || !wallet?.address) {
    throw new Error('createWallets did not return a wallet id and address.');
  }

  return {
    circleWalletId: wallet.id,
    agentAddress: wallet.address,
  };
}

export async function getAgentWalletProfile(userId) {
  const result = await query(
    `SELECT
       u.id AS user_id,
       u.wallet_address,
       aw.circle_wallet_id,
       aw.agent_address,
       p.weekly_budget,
       p.per_tip_cap,
       p.autonomous_enabled
     FROM users u
     LEFT JOIN agent_wallets aw ON aw.user_id = u.id
     LEFT JOIN policies p ON p.user_id = u.id
     WHERE u.id = $1
     LIMIT 1`,
    [userId],
  );

  const row = result.rows[0];
  if (!row) {
    return null;
  }

  const agentWalletReady = Boolean(row.circle_wallet_id && row.agent_address);
  const hasPolicyRow = row.weekly_budget !== null || row.per_tip_cap !== null || row.autonomous_enabled !== null;

  return {
    userId: row.user_id,
    walletAddress: row.wallet_address,
    agentAddress: row.agent_address ?? null,
    agentWalletReady,
    policy: hasPolicyRow
      ? normalizePolicyRow(row)
      : agentWalletReady
        ? { ...defaultAgentPolicy }
        : null,
  };
}

export async function ensureAgentWallet(userId) {
  return await withTransaction(async (client) => {
    const userResult = await client.query(
      'SELECT id, wallet_address FROM users WHERE id = $1 FOR UPDATE',
      [userId],
    );

    if (userResult.rowCount === 0) {
      throw new Error('User not found.');
    }

    const user = userResult.rows[0];

    const walletResult = await client.query(
      `SELECT user_id, circle_wallet_id, agent_address
       FROM agent_wallets
       WHERE user_id = $1
       LIMIT 1
       FOR UPDATE`,
      [userId],
    );
    let walletRow = walletResult.rows[0] ?? null;

    if (!walletRow) {
      const wallet = await createCircleWallet(userId);
      const insertWalletResult = await client.query(
        `INSERT INTO agent_wallets (user_id, circle_wallet_id, agent_address)
         VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO NOTHING
         RETURNING user_id, circle_wallet_id, agent_address`,
        [userId, wallet.circleWalletId, wallet.agentAddress],
      );

      if (insertWalletResult.rowCount === 0) {
        const existingWalletResult = await client.query(
          `SELECT user_id, circle_wallet_id, agent_address
           FROM agent_wallets
           WHERE user_id = $1
           LIMIT 1`,
          [userId],
        );

        if (existingWalletResult.rowCount === 0) {
          throw new Error('Failed to persist agent wallet.');
        }

        walletRow = existingWalletResult.rows[0];
      } else {
        walletRow = insertWalletResult.rows[0];
      }
    }

    await client.query(
      `INSERT INTO policies (user_id, weekly_budget, per_tip_cap, autonomous_enabled)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id) DO NOTHING`,
      [
        userId,
        defaultAgentPolicy.weeklyBudget,
        defaultAgentPolicy.perTipCap,
        defaultAgentPolicy.autonomousEnabled,
      ],
    );

    const policyResult = await client.query(
      `SELECT weekly_budget, per_tip_cap, autonomous_enabled
       FROM policies
       WHERE user_id = $1
       LIMIT 1`,
      [userId],
    );

    const policyRow = policyResult.rows[0] ?? null;

    return {
      userId: user.id,
      walletAddress: user.wallet_address,
      agentAddress: walletRow?.agent_address ?? null,
      agentWalletReady: Boolean(walletRow?.circle_wallet_id && walletRow?.agent_address),
      policy: policyRow ? normalizePolicyRow(policyRow) : { ...defaultAgentPolicy },
    };
  });
}
