import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildAuthMessage,
  generateNonce,
  generateSessionToken,
  hashToken,
  normalizeAuthAddress,
  recoverSignerAddress,
} from './auth.mjs';
import {
  ensureAgentWallet,
  getAgentWalletProfile,
} from './agentProvision.mjs';
import { closeDb, initDb, query, withTransaction } from './db.mjs';
import {
  appendLedgerEntry,
  createCircleTipContext,
  fetchCircleTipStatus,
  formatUsdcAmount,
  loadLedger,
  loadOrCreateBearerToken,
  loadPolicy,
  parseUsdcAmountToMicros,
  submitTipTransfer,
  sumLedgerSpendMicros,
} from './arc-tip-service.mjs';
import { isCircleApiError, loadEnv, normalizeCircleError, validatePositiveAmount, validateRecipientAddress } from '../scripts/shared.mjs';

const defaultPort = 8787;
const authWalletProvisionTimeoutMs = 8000;
const manualWalletProvisionTimeoutMs = 20000;

function resolveServerHost() {
  return process.env.HOST ?? (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
}

function resolveServerPort() {
  const parsed = Number.parseInt(process.env.PORT ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultPort;
}

const corsHeaders = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type',
  'Access-Control-Max-Age': '86400',
});

class HttpError extends Error {
  constructor(statusCode, message, details = {}, errorCode = 'invalid_request') {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.details = details;
    this.errorCode = errorCode;
  }
}

function sendJson(res, statusCode, body, headers = {}) {
  const payload = `${JSON.stringify(body)}\n`;
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(payload);
}

function sendError(res, statusCode, errorCode, message, details = {}, headers = {}) {
  sendJson(res, statusCode, {
    error: errorCode,
    message,
    ...details,
  }, headers);
}

function sendNoContent(res, statusCode, headers = {}) {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end();
}

function isCorsRoute(pathname) {
  return pathname === '/me' || pathname.startsWith('/me/') || pathname === '/agent' || pathname.startsWith('/agent/') || pathname === '/auth' || pathname.startsWith('/auth/');
}

function getHeader(req, name) {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value ?? '';
}

function extractBearerToken(req) {
  const header = String(getHeader(req, 'authorization') ?? '').trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function isAuthorized(req, bearerToken) {
  const providedToken = extractBearerToken(req);
  if (!providedToken) {
    return false;
  }

  const provided = Buffer.from(providedToken);
  const expected = Buffer.from(bearerToken);
  return provided.length === expected.length && crypto.timingSafeEqual(provided, expected);
}

async function readJsonBody(req, maxBytes = 16 * 1024) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      throw new HttpError(413, 'Request body is too large.');
    }
    chunks.push(buffer);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString('utf8').trim();
  if (!raw) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON.');
  }
}

function normalizePath(pathname) {
  if (pathname === '/') {
    return pathname;
  }
  return pathname.replace(/\/+$/, '');
}

function routeMatchesTipStatus(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  return parts.length === 3 && parts[0] === 'agent' && parts[1] === 'tip' && parts[2].length > 0;
}

function extractTipId(pathname) {
  return pathname.split('/').filter(Boolean)[2];
}

function validatePolicyTip(policy, ledger, recipient, amountMicros) {
  const normalizedRecipient = validateRecipientAddress(recipient).toLowerCase();
  if (!policy.allowlist.includes(normalizedRecipient)) {
    throw new HttpError(403, 'Recipient is not on the allowlist.', {
      rule: 'allowlist',
      recipient: normalizedRecipient,
    }, 'policy_blocked');
  }

  if (amountMicros > policy.perTipCapMicros) {
    throw new HttpError(403, 'Amount exceeds the per-tip cap.', {
      rule: 'perTipCap',
      amount: formatUsdcAmount(amountMicros),
      perTipCap: formatUsdcAmount(policy.perTipCapMicros),
    }, 'policy_blocked');
  }

  const spendMicros = sumLedgerSpendMicros(ledger);
  if (spendMicros + amountMicros > policy.weeklyBudgetMicros) {
    throw new HttpError(403, 'Weekly budget would be exceeded.', {
      rule: 'weeklyBudget',
      weeklySpend: formatUsdcAmount(spendMicros),
      requestedAmount: formatUsdcAmount(amountMicros),
      weeklyBudget: formatUsdcAmount(policy.weeklyBudgetMicros),
    }, 'policy_blocked');
  }

  return normalizedRecipient;
}

const ledgerFailureReasonColumns = ['failure_reason', 'reason', 'error_reason', 'error_message', 'failure_message'];

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
  return {
    weeklyBudget: normalizeNumber(row?.weekly_budget ?? row?.weeklyBudget),
    perTipCap: normalizeNumber(row?.per_tip_cap ?? row?.perTipCap),
    autonomousEnabled: normalizeBoolean(row?.autonomous_enabled ?? row?.autonomousEnabled),
  };
}

function normalizeAllowlistRow(row) {
  return {
    recipient: String(row?.recipient ?? row?.recipient_address ?? '').trim().toLowerCase(),
    label: row?.label ?? null,
  };
}

function normalizeLedgerRow(row) {
  return {
    id: row?.id ?? null,
    recipient: row?.recipient ?? null,
    amount: row?.amount !== undefined && row?.amount !== null ? String(row.amount) : null,
    status: row?.status ?? null,
    txHash: row?.tx_hash ?? row?.txHash ?? null,
    createdAt: row?.created_at ?? row?.createdAt ?? null,
  };
}

function normalizeTipFailure(status) {
  const parts = [];
  if (status?.errorReason) {
    parts.push(String(status.errorReason).trim());
  }
  if (status?.errorDetails) {
    parts.push(String(status.errorDetails).trim());
  }
  if (parts.length > 0) {
    return parts.join(': ');
  }
  return `Circle returned terminal state ${String(status?.state ?? 'UNKNOWN').toUpperCase()}.`;
}

function normalizePolicyInputValue(value, fieldName) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return null;
  }

  return validatePositiveAmount(String(value).trim(), fieldName);
}

function isDatabaseUnavailableError(error) {
  const message = String(error?.message ?? error ?? '');
  return message.includes('DATABASE_URL') || message.includes('Database query failed');
}

function isFutureTimestamp(value) {
  const timestamp = value instanceof Date ? value.getTime() : Date.parse(String(value ?? ''));
  return Number.isFinite(timestamp) && timestamp > Date.now();
}

async function loadUserPolicyBundle(clientOrUserId, maybeUserId) {
  const client = maybeUserId === undefined ? null : clientOrUserId;
  const userId = maybeUserId === undefined ? clientOrUserId : maybeUserId;
  const runner = client ?? { query };

  const [policyResult, allowlistResult] = await Promise.all([
    runner.query(
      `SELECT weekly_budget, per_tip_cap, autonomous_enabled
       FROM policies
       WHERE user_id = $1
       LIMIT 1`,
      [userId],
    ),
    runner.query(
      `SELECT recipient, label
       FROM allowlist
       WHERE user_id = $1`,
      [userId],
    ),
  ]);

  return {
    policyRow: policyResult.rows[0] ?? null,
    allowlistRows: allowlistResult.rows.map(normalizeAllowlistRow),
  };
}

async function loadLedgerSpendMicrosForUser(client, userId) {
  const result = await client.query(
    `SELECT COALESCE(SUM(amount::numeric), 0)::text AS total
     FROM ledger
     WHERE user_id = $1
       AND status = 'complete'
       AND created_at >= NOW() - INTERVAL '7 days'`,
    [userId],
  );

  const totalText = String(result.rows[0]?.total ?? '0').trim();
  if (!totalText || Number(totalText) === 0) {
    return 0n;
  }

  return parseUsdcAmountToMicros(totalText, 'ledger.total');
}

async function resolveLedgerFailureReasonColumn(client) {
  const result = await client.query(
    `SELECT column_name
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'ledger'`,
  );

  const columns = new Set(result.rows.map((row) => String(row.column_name).toLowerCase()));
  return ledgerFailureReasonColumns.find((column) => columns.has(column)) ?? null;
}

async function insertPendingLedgerRow(client, userId, recipient, amountText) {
  const result = await client.query(
    `INSERT INTO ledger (user_id, recipient, amount, status, created_at)
     VALUES ($1, $2, $3, 'pending', NOW())
     RETURNING id`,
    [userId, recipient, amountText],
  );

  return result.rows[0]?.id ?? null;
}

async function markLedgerTipComplete(ledgerId, txHash) {
  await query(
    `UPDATE ledger
     SET status = 'complete',
         tx_hash = $1
     WHERE id = $2`,
    [txHash, ledgerId],
  );
}

async function markLedgerTipFailed(ledgerId, txHash, reason) {
  await withTransaction(async (client) => {
    const reasonColumn = await resolveLedgerFailureReasonColumn(client);
    if (reasonColumn) {
      await client.query(
        `UPDATE ledger
         SET status = 'failed',
             tx_hash = COALESCE($1, tx_hash),
             ${reasonColumn} = $2
         WHERE id = $3`,
        [txHash, reason, ledgerId],
      );
      return;
    }

    await client.query(
      `UPDATE ledger
       SET status = 'failed',
           tx_hash = COALESCE($1, tx_hash)
       WHERE id = $2`,
      [txHash, ledgerId],
    );
  });
}

function buildResolvedPolicyPayload(currentPolicyRow, body) {
  const currentPolicy = currentPolicyRow ? normalizePolicyRow(currentPolicyRow) : { ...defaultAgentPolicy };

  const weeklyBudgetText = normalizePolicyInputValue(body?.weeklyBudget, 'weeklyBudget') ?? String(currentPolicy.weeklyBudget ?? defaultAgentPolicy.weeklyBudget);
  const perTipCapText = normalizePolicyInputValue(body?.perTipCap, 'perTipCap') ?? String(currentPolicy.perTipCap ?? defaultAgentPolicy.perTipCap);
  const autonomousEnabled = body?.autonomousEnabled !== undefined && body?.autonomousEnabled !== null
    ? normalizeBoolean(body.autonomousEnabled)
    : (currentPolicy.autonomousEnabled ?? defaultAgentPolicy.autonomousEnabled);

  const weeklyBudgetMicros = parseUsdcAmountToMicros(weeklyBudgetText, 'weeklyBudget');
  const perTipCapMicros = parseUsdcAmountToMicros(perTipCapText, 'perTipCap');

  if (perTipCapMicros > weeklyBudgetMicros) {
    throw new HttpError(400, 'perTipCap must be less than or equal to weeklyBudget.', {
      weeklyBudget: formatUsdcAmount(weeklyBudgetMicros),
      perTipCap: formatUsdcAmount(perTipCapMicros),
    }, 'invalid_request');
  }

  return {
    weeklyBudget: weeklyBudgetText,
    perTipCap: perTipCapText,
    autonomousEnabled,
  };
}

async function loadUserAutonomousTipState(client, userId) {
  const walletResult = await client.query(
    `SELECT circle_wallet_id, agent_address
     FROM agent_wallets
     WHERE user_id = $1
     LIMIT 1`,
    [userId],
  );
  const walletRow = walletResult.rows[0] ?? null;

  const { policyRow, allowlistRows } = await loadUserPolicyBundle(client, userId);
  const policy = buildResolvedPolicyPayload(policyRow, {});
  const spendMicros = await loadLedgerSpendMicrosForUser(client, userId);

  return {
    walletRow,
    policy,
    allowlistRows,
    spendMicros,
  };
}

async function createServerState() {
  loadEnv();
  await initDb();
  const [context, tokenInfo] = await Promise.all([createCircleTipContext(), loadOrCreateBearerToken()]);
  return {
    context,
    token: tokenInfo.token,
    tokenSource: tokenInfo.source,
  };
}

function withExclusiveTipLock() {
  let tail = Promise.resolve();
  return async function runExclusive(task) {
    const previous = tail;
    let release;
    tail = new Promise((resolve) => {
      release = resolve;
    });

    try {
      await previous;
      return await task();
    } finally {
      release();
    }
  };
}

const runExclusive = withExclusiveTipLock();

async function attemptAgentWalletProvision(userId, timeoutMs, context) {
  const trackedProvision = ensureAgentWallet(userId).then(
    (profile) => ({ status: 'fulfilled', profile }),
    (error) => {
      console.warn(`[agent-wallet] ${context} failed for user ${userId}: ${normalizeCircleError(error).text}`);
      return { status: 'rejected' };
    },
  );

  let timeoutId;
  const timeout = new Promise((resolve) => {
    timeoutId = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
  });

  const result = await Promise.race([trackedProvision, timeout]);
  clearTimeout(timeoutId);

  if (result.status === 'timeout') {
    console.warn(`[agent-wallet] ${context} timed out for user ${userId} after ${timeoutMs}ms.`);
    return {
      walletReady: false,
      timedOut: true,
      profile: null,
    };
  }

  if (result.status === 'fulfilled') {
    return {
      walletReady: true,
      timedOut: false,
      profile: result.profile,
    };
  }

  return {
    walletReady: false,
    timedOut: false,
    profile: null,
  };
}

async function authMiddleware(req, res, responseHeaders) {
  const accessToken = extractBearerToken(req);
  if (!accessToken) {
    sendError(res, 401, 'unauthorized', 'Missing or invalid bearer token.', {}, responseHeaders);
    return null;
  }

  let result;
  try {
    result = await query(
      'SELECT user_id, access_expires_at, revoked FROM sessions WHERE access_token_hash = $1 LIMIT 1',
      [hashToken(accessToken)],
    );
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      sendError(res, 503, 'service_unavailable', 'Database is unavailable.', {}, responseHeaders);
      return null;
    }

    throw error;
  }

  const session = result.rows[0];
  if (!session || session.revoked || !isFutureTimestamp(session.access_expires_at)) {
    sendError(res, 401, 'unauthorized', 'Missing or invalid bearer token.', {}, responseHeaders);
    return null;
  }

  req.userId = session.user_id;
  return session;
}

async function handleAuthNoncePost(req, res, responseHeaders) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.statusCode, error.errorCode, error.message, error.details, responseHeaders);
      return;
    }
    throw error;
  }

  let address;
  try {
    address = normalizeAuthAddress(body?.address);
  } catch (error) {
    sendError(res, 400, 'invalid_request', error?.message ?? 'Invalid request body.', {}, responseHeaders);
    return;
  }

  const nonce = generateNonce();
  const message = buildAuthMessage({ address, nonce });
  const expiresAt = new Date(Date.now() + 10 * 60 * 1000);

  try {
    await query(
      'INSERT INTO auth_nonces (wallet_address, nonce, created_at, expires_at, consumed) VALUES ($1, $2, NOW(), $3, FALSE)',
      [address, nonce, expiresAt],
    );
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      sendError(res, 503, 'service_unavailable', 'Database is unavailable.', {}, responseHeaders);
      return;
    }

    throw error;
  }

  sendJson(res, 200, { nonce, message }, responseHeaders);
}

async function handleAuthVerifyPost(req, res, responseHeaders) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.statusCode, error.errorCode, error.message, error.details, responseHeaders);
      return;
    }
    throw error;
  }

  let address;
  try {
    address = normalizeAuthAddress(body?.address);
  } catch (error) {
    sendError(res, 400, 'invalid_request', error?.message ?? 'Invalid request body.', {}, responseHeaders);
    return;
  }

  const signature = String(body?.signature ?? '').trim();
  if (!signature) {
    sendError(res, 400, 'invalid_request', 'Missing signature.', {}, responseHeaders);
    return;
  }

  try {
    const result = await withTransaction(async (client) => {
      const nonceResult = await client.query(
        `SELECT id, nonce
         FROM auth_nonces
         WHERE wallet_address = $1
           AND consumed = FALSE
           AND expires_at > NOW()
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [address],
      );

      const nonceRow = nonceResult.rows[0];
      if (!nonceRow) {
        throw new HttpError(401, 'Invalid or expired authentication nonce.', {}, 'unauthorized');
      }

      const message = buildAuthMessage({ address, nonce: nonceRow.nonce });
      let recoveredAddress;
      try {
        recoveredAddress = recoverSignerAddress({ message, signature });
      } catch {
        throw new HttpError(401, 'Invalid signature.', {}, 'unauthorized');
      }

      if (recoveredAddress !== address) {
        throw new HttpError(401, 'Invalid signature.', {}, 'unauthorized');
      }

      await client.query('UPDATE auth_nonces SET consumed = TRUE WHERE id = $1', [nonceRow.id]);

      const userResult = await client.query(
        `INSERT INTO users (wallet_address, created_at, last_seen_at)
         VALUES ($1, NOW(), NOW())
         ON CONFLICT (wallet_address)
         DO UPDATE SET last_seen_at = NOW()
         RETURNING id, wallet_address`,
        [address],
      );

      const user = userResult.rows[0];
      const accessToken = generateSessionToken();
      const refreshToken = generateSessionToken();
      const accessExpiresAt = new Date(Date.now() + 60 * 60 * 1000);
      const refreshExpiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      await client.query(
        `INSERT INTO sessions (
          user_id,
          access_token_hash,
          refresh_token_hash,
          access_expires_at,
          refresh_expires_at,
          created_at,
          revoked
        ) VALUES ($1, $2, $3, $4, $5, NOW(), FALSE)`,
        [
          user.id,
          hashToken(accessToken),
          hashToken(refreshToken),
          accessExpiresAt,
          refreshExpiresAt,
        ],
      );

      return {
        userId: user.id,
        accessToken,
        refreshToken,
      };
    });

    const provisioning = await attemptAgentWalletProvision(
      result.userId,
      authWalletProvisionTimeoutMs,
      'Authentication-time provisioning',
    );

    sendJson(res, 200, {
      ...result,
      walletReady: provisioning.walletReady,
    }, responseHeaders);
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.statusCode, error.errorCode, error.message, error.details, responseHeaders);
      return;
    }

    if (isDatabaseUnavailableError(error)) {
      sendError(res, 503, 'service_unavailable', 'Database is unavailable.', {}, responseHeaders);
      return;
    }

    sendError(res, 500, 'internal_error', 'Authentication failed.', {}, responseHeaders);
  }
}

async function handleAuthRefreshPost(req, res, responseHeaders) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.statusCode, error.errorCode, error.message, error.details, responseHeaders);
      return;
    }
    throw error;
  }

  const refreshToken = String(body?.refreshToken ?? '').trim();
  if (!refreshToken) {
    sendError(res, 400, 'invalid_request', 'Missing refreshToken.', {}, responseHeaders);
    return;
  }

  const accessToken = generateSessionToken();
  const accessTokenHash = hashToken(accessToken);
  const accessExpiresAt = new Date(Date.now() + 60 * 60 * 1000);

  try {
    const result = await query(
      `UPDATE sessions
       SET access_token_hash = $1,
           access_expires_at = $2
       WHERE refresh_token_hash = $3
         AND refresh_expires_at > NOW()
         AND revoked = FALSE
       RETURNING user_id`,
      [accessTokenHash, accessExpiresAt, hashToken(refreshToken)],
    );

    if (result.rowCount === 0) {
      sendError(res, 401, 'unauthorized', 'Invalid or expired refresh token.', {}, responseHeaders);
      return;
    }

    sendJson(res, 200, { accessToken }, responseHeaders);
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      sendError(res, 503, 'service_unavailable', 'Database is unavailable.', {}, responseHeaders);
      return;
    }

    sendError(res, 500, 'internal_error', 'Token refresh failed.', {}, responseHeaders);
  }
}

async function handleMeGet(req, res, responseHeaders) {
  const session = await authMiddleware(req, res, responseHeaders);
  if (!session) {
    return;
  }

  try {
    const profile = await getAgentWalletProfile(req.userId);
    if (!profile) {
      sendError(res, 404, 'not_found', 'User not found.', {}, responseHeaders);
      return;
    }

    sendJson(res, 200, profile, responseHeaders);
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      sendError(res, 503, 'service_unavailable', 'Database is unavailable.', {}, responseHeaders);
      return;
    }

    throw error;
  }
}

async function handleAgentProvisionPost(req, res, responseHeaders) {
  const session = await authMiddleware(req, res, responseHeaders);
  if (!session) {
    return;
  }

  try {
    const attempt = await attemptAgentWalletProvision(
      req.userId,
      manualWalletProvisionTimeoutMs,
      'Manual provisioning',
    );

    const profile = attempt.profile ?? await getAgentWalletProfile(req.userId);
    if (!profile) {
      sendError(res, 404, 'not_found', 'User not found.', {}, responseHeaders);
      return;
    }

    sendJson(res, 200, profile, responseHeaders);
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      sendError(res, 503, 'service_unavailable', 'Database is unavailable.', {}, responseHeaders);
      return;
    }

    throw error;
  }
}

async function handleMePolicyGet(req, res, responseHeaders) {
  const session = await authMiddleware(req, res, responseHeaders);
  if (!session) {
    return;
  }

  try {
    const { policyRow, allowlistRows } = await loadUserPolicyBundle(null, req.userId);
    const policy = policyRow ? normalizePolicyRow(policyRow) : { ...defaultAgentPolicy };

    sendJson(res, 200, {
      ...policy,
      allowlist: allowlistRows,
    }, responseHeaders);
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      sendError(res, 503, 'service_unavailable', 'Database is unavailable.', {}, responseHeaders);
      return;
    }

    throw error;
  }
}

async function handleMePolicyPut(req, res, responseHeaders) {
  const session = await authMiddleware(req, res, responseHeaders);
  if (!session) {
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.statusCode, error.errorCode, error.message, error.details, responseHeaders);
      return;
    }
    throw error;
  }

  try {
    const result = await withTransaction(async (client) => {
      const existingResult = await client.query(
        `SELECT weekly_budget, per_tip_cap, autonomous_enabled
         FROM policies
         WHERE user_id = $1
         LIMIT 1`,
        [req.userId],
      );
      const resolved = buildResolvedPolicyPayload(existingResult.rows[0] ?? null, body);

      await client.query(
        `INSERT INTO policies (user_id, weekly_budget, per_tip_cap, autonomous_enabled)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET
           weekly_budget = EXCLUDED.weekly_budget,
           per_tip_cap = EXCLUDED.per_tip_cap,
           autonomous_enabled = EXCLUDED.autonomous_enabled
         RETURNING weekly_budget, per_tip_cap, autonomous_enabled`,
        [
          req.userId,
          resolved.weeklyBudget,
          resolved.perTipCap,
          resolved.autonomousEnabled,
        ],
      );

      const refreshed = await client.query(
        `SELECT weekly_budget, per_tip_cap, autonomous_enabled
         FROM policies
         WHERE user_id = $1
         LIMIT 1`,
        [req.userId],
      );

      return normalizePolicyRow(refreshed.rows[0] ?? null);
    });

    sendJson(res, 200, result, responseHeaders);
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.statusCode, error.errorCode, error.message, error.details, responseHeaders);
      return;
    }

    if (isDatabaseUnavailableError(error)) {
      sendError(res, 503, 'service_unavailable', 'Database is unavailable.', {}, responseHeaders);
      return;
    }

    throw error;
  }
}

async function handleMeAllowlistPost(req, res, responseHeaders) {
  const session = await authMiddleware(req, res, responseHeaders);
  if (!session) {
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.statusCode, error.errorCode, error.message, error.details, responseHeaders);
      return;
    }
    throw error;
  }

  let recipient;
  try {
    recipient = validateRecipientAddress(String(body?.recipient ?? '').trim()).toLowerCase();
  } catch (error) {
    sendError(res, 400, 'invalid_request', error?.message ?? 'Invalid request body.', {}, responseHeaders);
    return;
  }

  const labelText = body?.label !== undefined && body?.label !== null ? String(body.label).trim() : '';
  const label = labelText ? labelText : null;

  try {
    const result = await query(
      `INSERT INTO allowlist (user_id, recipient, label)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, recipient) DO UPDATE SET
         label = COALESCE(EXCLUDED.label, allowlist.label)
       RETURNING recipient, label`,
      [req.userId, recipient, label],
    );

    sendJson(res, 200, {
      ...normalizeAllowlistRow(result.rows[0] ?? { recipient, label }),
    }, responseHeaders);
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      sendError(res, 503, 'service_unavailable', 'Database is unavailable.', {}, responseHeaders);
      return;
    }

    throw error;
  }
}

async function handleMeAllowlistDelete(req, res, responseHeaders) {
  const session = await authMiddleware(req, res, responseHeaders);
  if (!session) {
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.statusCode, error.errorCode, error.message, error.details, responseHeaders);
      return;
    }
    throw error;
  }

  let recipient;
  try {
    recipient = validateRecipientAddress(String(body?.recipient ?? '').trim()).toLowerCase();
  } catch (error) {
    sendError(res, 400, 'invalid_request', error?.message ?? 'Invalid request body.', {}, responseHeaders);
    return;
  }

  try {
    await query(
      'DELETE FROM allowlist WHERE user_id = $1 AND recipient = $2',
      [req.userId, recipient],
    );
    sendJson(res, 200, { recipient, removed: true }, responseHeaders);
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      sendError(res, 503, 'service_unavailable', 'Database is unavailable.', {}, responseHeaders);
      return;
    }

    throw error;
  }
}

async function handleMeLedgerGet(req, res, responseHeaders) {
  const session = await authMiddleware(req, res, responseHeaders);
  if (!session) {
    return;
  }

  try {
    const result = await query(
      `SELECT id, recipient, amount::text AS amount, status, tx_hash, created_at
       FROM ledger
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 20`,
      [req.userId],
    );

    sendJson(res, 200, {
      ledger: result.rows.map(normalizeLedgerRow),
    }, responseHeaders);
  } catch (error) {
    if (isDatabaseUnavailableError(error)) {
      sendError(res, 503, 'service_unavailable', 'Database is unavailable.', {}, responseHeaders);
      return;
    }

    throw error;
  }
}

async function handleMeTipPost(req, res, state, responseHeaders) {
  const session = await authMiddleware(req, res, responseHeaders);
  if (!session) {
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.statusCode, error.errorCode, error.message, error.details, responseHeaders);
      return;
    }
    throw error;
  }

  let recipient;
  let amountText;
  let amountMicros;
  try {
    recipient = validateRecipientAddress(String(body?.recipient ?? '').trim()).toLowerCase();
    amountText = validatePositiveAmount(String(body?.amount ?? '').trim());
    amountMicros = parseUsdcAmountToMicros(amountText, 'amount');
  } catch (error) {
    sendError(res, 400, 'invalid_request', error?.message ?? 'Invalid request body.', {}, responseHeaders);
    return;
  }

  let prep;
  try {
    prep = await withTransaction(async (client) => {
      const stateBundle = await loadUserAutonomousTipState(client, req.userId);
      const { walletRow, policy, allowlistRows, spendMicros } = stateBundle;

      if (!walletRow || !walletRow.circle_wallet_id || !walletRow.agent_address) {
        throw new HttpError(409, 'Your agent wallet is not provisioned yet. Call /agent/provision first.', {
          hint: 'call /agent/provision first',
        }, 'agent_wallet_not_provisioned');
      }

      if (!policy.autonomousEnabled) {
        throw new HttpError(403, 'autonomous mode is off for this account', {}, 'autonomous_disabled');
      }

      const perTipCapMicros = parseUsdcAmountToMicros(String(policy.perTipCap), 'perTipCap');
      if (amountMicros > perTipCapMicros) {
        throw new HttpError(400, `Amount exceeds your per-tip cap of ${formatUsdcAmount(perTipCapMicros)} USDC.`, {
          perTipCap: formatUsdcAmount(perTipCapMicros),
          amount: formatUsdcAmount(amountMicros),
        }, 'invalid_request');
      }

      if (allowlistRows.length > 0 && !allowlistRows.some((entry) => entry.recipient === recipient)) {
        throw new HttpError(400, 'recipient not in your allowlist', {
          recipient,
        }, 'invalid_request');
      }

      const weeklyBudgetMicros = parseUsdcAmountToMicros(String(policy.weeklyBudget), 'weeklyBudget');
      if (spendMicros + amountMicros > weeklyBudgetMicros) {
        const remainingMicros = weeklyBudgetMicros > spendMicros ? weeklyBudgetMicros - spendMicros : 0n;
        throw new HttpError(400, `Weekly budget exceeded. Remaining budget: ${formatUsdcAmount(remainingMicros)} USDC.`, {
          weeklyBudget: formatUsdcAmount(weeklyBudgetMicros),
          weeklySpend: formatUsdcAmount(spendMicros),
          requestedAmount: formatUsdcAmount(amountMicros),
          remainingBudget: formatUsdcAmount(remainingMicros),
        }, 'invalid_request');
      }

      const ledgerId = await insertPendingLedgerRow(client, req.userId, recipient, amountText);
      if (!ledgerId) {
        throw new Error('Failed to create a pending ledger row.');
      }

      return {
        ledgerId,
        walletId: walletRow.circle_wallet_id,
        agentAddress: walletRow.agent_address,
      };
    });
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.statusCode, error.errorCode, error.message, error.details, responseHeaders);
      return;
    }

    if (isDatabaseUnavailableError(error)) {
      sendError(res, 503, 'service_unavailable', 'Database is unavailable.', {}, responseHeaders);
      return;
    }

    throw error;
  }

  try {
    const transfer = await submitTipTransfer(state.context, {
      recipient,
      amount: amountText,
      walletId: prep.walletId,
    });

    if (String(transfer.state).toUpperCase() !== 'COMPLETE') {
      const reason = normalizeTipFailure(transfer);
      throw new HttpError(502, reason, {
        state: transfer.state,
        txHash: transfer.txHash ?? null,
        arcscanUrl: transfer.arcscanUrl ?? null,
      }, 'circle_upstream_error');
    }

    await markLedgerTipComplete(prep.ledgerId, transfer.txHash ?? null);

    sendJson(res, 200, {
      state: 'COMPLETE',
      txHash: transfer.txHash ?? null,
      arcscanUrl: transfer.arcscanUrl ?? null,
    }, responseHeaders);
  } catch (error) {
    if (error instanceof HttpError) {
      try {
        await markLedgerTipFailed(prep.ledgerId, error.details?.txHash ?? null, error.message);
      } catch (markError) {
        console.warn(`[ledger] Could not mark failed autonomous tip for user ${req.userId}: ${normalizeCircleError(markError).text}`);
      }
      sendError(res, error.statusCode, error.errorCode, error.message, error.details, responseHeaders);
      return;
    }

    const normalized = normalizeCircleError(error);
    try {
      await markLedgerTipFailed(prep.ledgerId, null, normalized.text);
    } catch (markError) {
      console.warn(`[ledger] Could not mark failed autonomous tip for user ${req.userId}: ${normalizeCircleError(markError).text}`);
    }

    sendError(
      res,
      isCircleApiError(error) || normalized.status ? 502 : 500,
      isCircleApiError(error) || normalized.status ? 'circle_upstream_error' : 'internal_error',
      normalized.text,
      {},
      responseHeaders,
    );
  }
}

async function handleTipPost(req, res, state, responseHeaders) {
  if (!isAuthorized(req, state.token)) {
    sendError(res, 401, 'unauthorized', 'Missing or invalid bearer token.', {}, responseHeaders);
    return;
  }

  let recipient;
  let amountText;
  let amountMicros;

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.statusCode, error.errorCode, error.message, error.details, responseHeaders);
      return;
    }
    throw error;
  }

  try {
    recipient = validateRecipientAddress(String(body?.recipient ?? '').trim());
    amountText = validatePositiveAmount(String(body?.amount ?? '').trim());
    amountMicros = parseUsdcAmountToMicros(amountText, 'amount');
  } catch (error) {
    sendError(res, 400, 'invalid_request', error?.message ?? 'Invalid request body.', {}, responseHeaders);
    return;
  }

  let result;
  try {
    result = await runExclusive(async () => {
      const policy = await loadPolicy();
      const ledger = await loadLedger();
      const normalizedRecipient = validatePolicyTip(policy, ledger, recipient, amountMicros);

      const transfer = await submitTipTransfer(state.context, {
        recipient: normalizedRecipient,
        amount: amountText,
      });

      if (String(transfer.state).toUpperCase() !== 'COMPLETE') {
        throw new HttpError(502, 'Circle returned a terminal failure state.', {
          state: transfer.state,
          txHash: transfer.txHash ?? null,
          arcscanUrl: transfer.arcscanUrl ?? null,
        }, 'circle_upstream_error');
      }

      await appendLedgerEntry({
        recipient: normalizedRecipient,
        amount: amountText,
        amountMicros: String(amountMicros),
        timestamp: new Date().toISOString(),
        txId: transfer.id,
        txHash: transfer.txHash ?? '',
        state: transfer.state,
      });

      return transfer;
    });
  } catch (error) {
    if (error instanceof HttpError) {
      sendError(res, error.statusCode, error.errorCode, error.message, error.details, responseHeaders);
      return;
    }

    const normalized = normalizeCircleError(error);
    sendError(
      res,
      normalized.status ? 502 : 500,
      normalized.status ? 'circle_upstream_error' : 'internal_error',
      normalized.text,
      {},
      responseHeaders,
    );
    return;
  }

  sendJson(res, 200, {
    id: result.id,
    state: result.state,
    txHash: result.txHash ?? null,
    arcscanUrl: result.arcscanUrl ?? null,
  }, responseHeaders);
}

async function handleTipStatus(req, res, state, pathname, responseHeaders) {
  if (!isAuthorized(req, state.token)) {
    sendError(res, 401, 'unauthorized', 'Missing or invalid bearer token.', {}, responseHeaders);
    return;
  }

  const txId = extractTipId(pathname);
  try {
    const status = await fetchCircleTipStatus(state.context.client, txId);
    sendJson(res, 200, {
      id: status.id,
      state: status.state,
      txHash: status.txHash,
      arcscanUrl: status.arcscanUrl,
    }, responseHeaders);
  } catch (error) {
    const normalized = normalizeCircleError(error);
    const statusCode = normalized.status === 404 ? 404 : 502;
    sendError(
      res,
      statusCode,
      statusCode === 404 ? 'not_found' : 'circle_upstream_error',
      normalized.text,
      {},
      responseHeaders,
    );
  }
}

async function requestHandler(req, res, state) {
  try {
    const pathname = normalizePath(new URL(req.url ?? '/', `http://${req.headers.host ?? resolveServerHost()}`).pathname);
    const responseHeaders = isCorsRoute(pathname) ? corsHeaders : undefined;

    if (req.method === 'OPTIONS' && isCorsRoute(pathname)) {
      sendNoContent(res, 204, responseHeaders);
      return;
    }

    if (req.method === 'GET' && pathname === '/health') {
      sendJson(res, 200, { ok: true });
      return;
    }

    if (req.method === 'POST' && pathname === '/agent/tip') {
      await handleTipPost(req, res, state, responseHeaders);
      return;
    }

    if (req.method === 'POST' && pathname === '/me/tip') {
      await handleMeTipPost(req, res, state, responseHeaders);
      return;
    }

    if (req.method === 'POST' && pathname === '/auth/nonce') {
      await handleAuthNoncePost(req, res, responseHeaders);
      return;
    }

    if (req.method === 'POST' && pathname === '/auth/verify') {
      await handleAuthVerifyPost(req, res, responseHeaders);
      return;
    }

    if (req.method === 'POST' && pathname === '/auth/refresh') {
      await handleAuthRefreshPost(req, res, responseHeaders);
      return;
    }

    if (req.method === 'POST' && pathname === '/agent/provision') {
      await handleAgentProvisionPost(req, res, responseHeaders);
      return;
    }

    if (req.method === 'GET' && pathname === '/me') {
      await handleMeGet(req, res, responseHeaders);
      return;
    }

    if (req.method === 'GET' && pathname === '/me/policy') {
      await handleMePolicyGet(req, res, responseHeaders);
      return;
    }

    if (req.method === 'PUT' && pathname === '/me/policy') {
      await handleMePolicyPut(req, res, responseHeaders);
      return;
    }

    if (req.method === 'POST' && pathname === '/me/allowlist') {
      await handleMeAllowlistPost(req, res, responseHeaders);
      return;
    }

    if (req.method === 'DELETE' && pathname === '/me/allowlist') {
      await handleMeAllowlistDelete(req, res, responseHeaders);
      return;
    }

    if (req.method === 'GET' && pathname === '/me/ledger') {
      await handleMeLedgerGet(req, res, responseHeaders);
      return;
    }

    if (req.method === 'GET' && routeMatchesTipStatus(pathname)) {
      await handleTipStatus(req, res, state, pathname, responseHeaders);
      return;
    }

    sendError(res, 404, 'not_found', 'Route not found.', {}, responseHeaders);
  } catch (error) {
    const pathname = normalizePath(new URL(req.url ?? '/', `http://${req.headers.host ?? resolveServerHost()}`).pathname);
    const responseHeaders = isCorsRoute(pathname) ? corsHeaders : undefined;

    if (error instanceof HttpError) {
      sendError(res, error.statusCode, error.errorCode, error.message, error.details, responseHeaders);
      return;
    }

    const normalized = normalizeCircleError(error);
    sendError(res, 500, 'internal_error', normalized.text, {}, responseHeaders);
  }
}

export async function startServer({ host = resolveServerHost(), port = resolveServerPort() } = {}) {
  const state = await createServerState();
  const server = http.createServer((req, res) => {
    void requestHandler(req, res, state);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;
  console.log(`[server] Listening on http://${host}:${actualPort}`);
  if (state.tokenSource === 'env') {
    console.log('[server] Bearer token source: AGENT_BEARER_TOKEN');
  } else {
    console.log('[server] Bearer token source: .token or generated local fallback');
  }

  return {
    server,
    host,
    port: actualPort,
    token: state.token,
    tokenSource: state.tokenSource,
    context: state.context,
    close: async () => {
      await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await closeDb();
    },
  };
}

async function main() {
  const runtime = await startServer({
    host: resolveServerHost(),
    port: resolveServerPort(),
  });

  const shutdown = async () => {
    await runtime.close();
    process.exit(0);
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(`[server] Failed: ${normalizeCircleError(error).text}`);
    process.exitCode = 1;
  });
}
