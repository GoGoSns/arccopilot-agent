import crypto from 'node:crypto';
import { query, withTransaction } from './db.mjs';
import { applyScheduledRunTransactionStatus } from './scheduled-payments.mjs';
import { normalizeCircleError } from '../scripts/shared.mjs';

const circlePublicKeyBaseUrl = 'https://api.circle.com/v2/notifications/publicKey';
const publicKeyCacheTtlMs = 6 * 60 * 60 * 1000;
const defaultReconciliationIntervalMs = 60_000;
const minimumReconciliationIntervalMs = 15_000;
const maximumReconciliationIntervalMs = 10 * 60_000;
const reconciliationBatchSize = 10;
const publicKeyCache = new Map();

export const circleSuccessfulTransactionStates = new Set(['COMPLETE']);
export const circleFailedTransactionStates = new Set(['FAILED', 'DENIED', 'CANCELLED']);

function publicKeyToPem(publicKey) {
  const normalized = String(publicKey ?? '').trim();
  if (!normalized) {
    throw new Error('Circle public key response did not include a public key.');
  }
  if (normalized.includes('BEGIN PUBLIC KEY')) return normalized;
  const compact = normalized.replace(/\s+/g, '');
  const lines = compact.match(/.{1,64}/g) ?? [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----`;
}

async function loadCirclePublicKey(keyId, apiKey, { fetchImpl = fetch, publicKeyBaseUrl = circlePublicKeyBaseUrl } = {}) {
  const cached = publicKeyCache.get(keyId);
  if (cached && cached.expiresAt > Date.now()) return cached.pem;

  const response = await fetchImpl(`${publicKeyBaseUrl}/${encodeURIComponent(keyId)}`, {
    headers: {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json',
    },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    throw new Error(`Circle public key request failed with HTTP ${response.status}.`);
  }

  const payload = await response.json();
  const data = payload?.data ?? payload ?? {};
  const algorithm = String(data?.algorithm ?? '').toUpperCase();
  if (algorithm && algorithm !== 'ECDSA_SHA_256') {
    throw new Error(`Unsupported Circle webhook signature algorithm: ${algorithm}.`);
  }

  const pem = publicKeyToPem(data?.publicKey ?? data?.public_key);
  publicKeyCache.set(keyId, { pem, expiresAt: Date.now() + publicKeyCacheTtlMs });
  return pem;
}

export async function verifyCircleWebhookSignature({
  rawBody,
  keyId,
  signature,
  apiKey,
  fetchImpl,
  publicKeyBaseUrl,
}) {
  if (!keyId || !signature || !apiKey) return false;
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(rawBody ?? '');
  const pem = await loadCirclePublicKey(String(keyId), String(apiKey), { fetchImpl, publicKeyBaseUrl });
  const signatureBuffer = Buffer.from(String(signature).trim(), 'base64');
  if (signatureBuffer.length === 0) return false;

  if (crypto.verify('sha256', body, { key: pem, dsaEncoding: 'der' }, signatureBuffer)) {
    return true;
  }
  return signatureBuffer.length === 64
    && crypto.verify('sha256', body, { key: pem, dsaEncoding: 'ieee-p1363' }, signatureBuffer);
}

export function parseCircleWebhookPayload(payload) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const notification = source.notification && typeof source.notification === 'object'
    ? source.notification
    : {};
  const transaction = notification.transaction && typeof notification.transaction === 'object'
    ? notification.transaction
    : notification;
  const notificationId = String(source.notificationId ?? source.notification_id ?? '').trim();
  const transactionId = String(
    transaction.id
    ?? notification.transactionId
    ?? notification.transaction_id
    ?? source.transactionId
    ?? '',
  ).trim();
  const state = String(
    transaction.state
    ?? transaction.transactionState
    ?? transaction.status
    ?? notification.state
    ?? '',
  ).trim().toUpperCase();
  const txHash = String(
    transaction.txHash
    ?? transaction.transactionHash
    ?? transaction.hash
    ?? notification.txHash
    ?? '',
  ).trim() || null;
  const error = String(
    transaction.errorDetails
    ?? transaction.errorReason
    ?? notification.errorDetails
    ?? notification.errorReason
    ?? '',
  ).trim() || null;

  return {
    notificationId,
    notificationType: String(source.notificationType ?? source.notification_type ?? '').trim() || null,
    transactionId: transactionId || null,
    state: state || null,
    txHash,
    error,
  };
}

export async function ensureCircleWebhookSchema() {
  await query(
    `ALTER TABLE ledger
       ADD COLUMN IF NOT EXISTS circle_transaction_id VARCHAR(100)`,
  );
  await query(
    `CREATE UNIQUE INDEX IF NOT EXISTS ledger_circle_transaction_id_idx
     ON ledger (circle_transaction_id)
     WHERE circle_transaction_id IS NOT NULL`,
  );
  await query(
    `CREATE TABLE IF NOT EXISTS circle_webhook_events (
       notification_id VARCHAR(120) PRIMARY KEY,
       notification_type VARCHAR(80),
       circle_transaction_id VARCHAR(100),
       state VARCHAR(40),
       tx_hash VARCHAR(100),
       payload JSONB NOT NULL,
       matched BOOLEAN NOT NULL DEFAULT FALSE,
       received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       processed_at TIMESTAMPTZ
     )`,
  );
  await query(
    `CREATE INDEX IF NOT EXISTS circle_webhook_events_transaction_idx
     ON circle_webhook_events (circle_transaction_id, received_at DESC)
     WHERE circle_transaction_id IS NOT NULL`,
  );
}

async function applyCircleTransactionStatusWithClient(client, status) {
  const transactionId = String(status?.transactionId ?? status?.id ?? '').trim();
  if (!transactionId) return { matched: false, ledgerCount: 0, scheduledRunCount: 0 };

  const state = String(status?.state ?? '').toUpperCase();
  const nextLedgerStatus = circleSuccessfulTransactionStates.has(state)
    ? 'complete'
    : (circleFailedTransactionStates.has(state) ? 'failed' : null);
  const ledgerResult = await client.query(
    `UPDATE ledger
     SET tx_hash = COALESCE($2, tx_hash),
         status = CASE
           WHEN $3::text IS NULL THEN status
           WHEN status = 'pending' THEN $3
           ELSE status
         END
     WHERE circle_transaction_id = $1
     RETURNING id`,
    [transactionId, status?.txHash ?? null, nextLedgerStatus],
  );
  const ledgerIds = ledgerResult.rows.map((row) => row.id);
  const scheduledRunCount = await applyScheduledRunTransactionStatus(client, ledgerIds, {
    state,
    txHash: status?.txHash ?? null,
    error: status?.error ?? status?.errorReason ?? status?.errorDetails ?? null,
  });

  return {
    matched: ledgerIds.length > 0,
    ledgerCount: ledgerIds.length,
    scheduledRunCount,
  };
}

export async function applyCircleTransactionStatus(status) {
  return withTransaction((client) => applyCircleTransactionStatusWithClient(client, status));
}

export async function recordCircleWebhookEvent(payload, parsed = parseCircleWebhookPayload(payload)) {
  if (!parsed.notificationId) {
    throw new Error('Circle webhook payload is missing notificationId.');
  }

  return withTransaction(async (client) => {
    const insertResult = await client.query(
      `INSERT INTO circle_webhook_events
         (notification_id, notification_type, circle_transaction_id, state, tx_hash, payload, received_at)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb, NOW())
       ON CONFLICT (notification_id) DO NOTHING
       RETURNING notification_id`,
      [
        parsed.notificationId,
        parsed.notificationType,
        parsed.transactionId,
        parsed.state,
        parsed.txHash,
        JSON.stringify(payload),
      ],
    );
    if (!insertResult.rows[0]) {
      return { duplicate: true, matched: false };
    }

    const applied = parsed.transactionId
      ? await applyCircleTransactionStatusWithClient(client, parsed)
      : { matched: false, ledgerCount: 0, scheduledRunCount: 0 };
    await client.query(
      `UPDATE circle_webhook_events
       SET matched = $1, processed_at = NOW()
       WHERE notification_id = $2`,
      [applied.matched, parsed.notificationId],
    );
    return { duplicate: false, ...applied };
  });
}

function resolveReconciliationIntervalMs() {
  const parsed = Number.parseInt(process.env.CIRCLE_RECONCILIATION_INTERVAL_MS ?? '', 10);
  if (!Number.isFinite(parsed)) return defaultReconciliationIntervalMs;
  return Math.min(maximumReconciliationIntervalMs, Math.max(minimumReconciliationIntervalMs, parsed));
}

async function reconcilePendingTransactions(fetchStatus) {
  const result = await query(
    `SELECT circle_transaction_id
     FROM ledger
     WHERE status = 'pending'
       AND circle_transaction_id IS NOT NULL
       AND created_at < NOW() - INTERVAL '30 seconds'
     ORDER BY created_at ASC
     LIMIT $1`,
    [reconciliationBatchSize],
  );

  for (const row of result.rows) {
    const transactionId = row.circle_transaction_id;
    try {
      const status = await fetchStatus(transactionId);
      await applyCircleTransactionStatus({ ...status, transactionId });
    } catch (error) {
      console.warn(`[circle-reconcile] ${transactionId}: ${normalizeCircleError(error).text}`);
    }
  }
}

export function startCircleReconciliationWorker({ fetchStatus }) {
  const intervalMs = resolveReconciliationIntervalMs();
  let stopped = false;
  let running = false;
  let timer = null;
  let resolveStopped;
  const stoppedPromise = new Promise((resolve) => {
    resolveStopped = resolve;
  });

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), intervalMs);
    timer.unref?.();
  };
  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await reconcilePendingTransactions(fetchStatus);
    } catch (error) {
      console.warn(`[circle-reconcile] Worker cycle failed: ${normalizeCircleError(error).text}`);
    } finally {
      running = false;
      if (stopped) resolveStopped();
      else scheduleNext();
    }
  };

  void tick();
  console.log(`[circle-reconcile] Worker enabled with ${intervalMs}ms polling.`);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (!running) resolveStopped();
      await stoppedPromise;
    },
  };
}
