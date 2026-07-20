import crypto from 'node:crypto';
import { query, withTransaction } from './db.mjs';
import { formatUsdcAmount, parseUsdcAmountToMicros } from './arc-tip-service.mjs';
import { normalizeCircleError, validatePositiveAmount, validateRecipientAddress } from '../scripts/shared.mjs';

export const minimumScheduleIntervalHours = 1;
export const maximumScheduleIntervalHours = 24 * 365;

const defaultPollIntervalMs = 30_000;
const minimumPollIntervalMs = 5_000;
const maximumPollIntervalMs = 5 * 60_000;
const scheduleBatchSize = 10;
const abandonedRunMinutes = 15;
const defaultFailurePauseThreshold = 3;
const maximumFailurePauseThreshold = 10;

export function resolveFailurePauseThreshold(value = process.env.SCHEDULE_FAILURE_PAUSE_THRESHOLD) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed)) return defaultFailurePauseThreshold;
  return Math.min(maximumFailurePauseThreshold, Math.max(1, parsed));
}

function normalizeBoolean(value, fallback = null) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  return fallback;
}

function normalizeLabel(value) {
  if (value === undefined || value === null) return null;
  const label = String(value).trim();
  if (!label) return null;
  if (label.length > 80) {
    throw new Error('label must be 80 characters or fewer.');
  }
  return label;
}

function normalizeIntervalHours(value) {
  const numeric = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isInteger(numeric) || numeric < minimumScheduleIntervalHours || numeric > maximumScheduleIntervalHours) {
    throw new Error(`intervalHours must be a whole number from ${minimumScheduleIntervalHours} to ${maximumScheduleIntervalHours}.`);
  }
  return numeric;
}

function normalizeFirstRunAt(value, intervalHours, nowMs = Date.now()) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return new Date(nowMs + intervalHours * 60 * 60 * 1000);
  }

  const date = new Date(String(value));
  if (!Number.isFinite(date.getTime())) {
    throw new Error('firstRunAt must be a valid ISO timestamp.');
  }

  if (date.getTime() < nowMs - 5 * 60_000) {
    throw new Error('firstRunAt cannot be more than 5 minutes in the past.');
  }

  if (date.getTime() > nowMs + 366 * 24 * 60 * 60 * 1000) {
    throw new Error('firstRunAt must be within the next 366 days.');
  }

  return date;
}

export function normalizeScheduleInput(body, { partial = false, nowMs = Date.now(), fallbackIntervalHours = null } = {}) {
  const source = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const result = {};

  if (!partial || source.recipient !== undefined) {
    result.recipient = validateRecipientAddress(String(source.recipient ?? '').trim()).toLowerCase();
  }

  if (!partial || source.amount !== undefined) {
    const amount = validatePositiveAmount(String(source.amount ?? '').trim());
    result.amount = formatUsdcAmount(parseUsdcAmountToMicros(amount, 'amount'));
  }

  if (!partial || source.intervalHours !== undefined) {
    result.intervalHours = normalizeIntervalHours(source.intervalHours);
  }

  if (!partial || source.label !== undefined) {
    result.label = normalizeLabel(source.label);
  }

  if (!partial || source.firstRunAt !== undefined) {
    const intervalHours = result.intervalHours ?? normalizeIntervalHours(fallbackIntervalHours ?? source.intervalHours);
    result.firstRunAt = normalizeFirstRunAt(source.firstRunAt, intervalHours, nowMs);
  }

  if (source.enabled !== undefined) {
    const enabled = normalizeBoolean(source.enabled);
    if (enabled === null) {
      throw new Error('enabled must be a boolean.');
    }
    result.enabled = enabled;
  } else if (!partial) {
    result.enabled = true;
  }

  if (partial && Object.keys(result).length === 0) {
    throw new Error('At least one schedule field is required.');
  }

  return result;
}

export function normalizeScheduleRow(row) {
  return {
    id: String(row?.id ?? ''),
    recipient: String(row?.recipient ?? '').toLowerCase(),
    amount: String(row?.amount ?? ''),
    label: row?.label ?? null,
    intervalHours: Number(row?.interval_hours ?? row?.intervalHours ?? 0),
    nextRunAt: row?.next_run_at ?? row?.nextRunAt ?? null,
    enabled: normalizeBoolean(row?.enabled, false),
    lastRunAt: row?.last_run_at ?? row?.lastRunAt ?? null,
    lastStatus: row?.last_status ?? row?.lastStatus ?? null,
    lastError: row?.last_error ?? row?.lastError ?? null,
    consecutiveFailures: Number(row?.consecutive_failures ?? row?.consecutiveFailures ?? 0),
    pausedReason: row?.paused_reason ?? row?.pausedReason ?? null,
    createdAt: row?.created_at ?? row?.createdAt ?? null,
    updatedAt: row?.updated_at ?? row?.updatedAt ?? null,
  };
}

export function normalizeScheduleRunRow(row) {
  return {
    id: String(row?.id ?? ''),
    scheduledFor: row?.scheduled_for ?? row?.scheduledFor ?? null,
    status: String(row?.status ?? ''),
    attempts: Number(row?.attempts ?? 0),
    circleTransactionId: row?.circle_transaction_id ?? row?.circleTransactionId ?? null,
    txHash: row?.tx_hash ?? row?.txHash ?? null,
    error: row?.error ?? null,
    createdAt: row?.created_at ?? row?.createdAt ?? null,
    startedAt: row?.started_at ?? row?.startedAt ?? null,
    completedAt: row?.completed_at ?? row?.completedAt ?? null,
  };
}

export async function ensureScheduledPaymentsSchema() {
  await query(
    `CREATE TABLE IF NOT EXISTS scheduled_payments (
       id UUID PRIMARY KEY,
       user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       recipient VARCHAR(42) NOT NULL,
       amount NUMERIC(20, 6) NOT NULL CHECK (amount > 0),
       label VARCHAR(80),
       interval_hours INTEGER NOT NULL CHECK (interval_hours BETWEEN 1 AND 8760),
       next_run_at TIMESTAMPTZ NOT NULL,
       enabled BOOLEAN NOT NULL DEFAULT TRUE,
       last_run_at TIMESTAMPTZ,
       last_status VARCHAR(20),
       last_error TEXT,
       consecutive_failures INTEGER NOT NULL DEFAULT 0,
       paused_reason TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       deleted_at TIMESTAMPTZ
     )`,
  );

  await query(
    `CREATE INDEX IF NOT EXISTS scheduled_payments_due_idx
     ON scheduled_payments (next_run_at)
     WHERE enabled = TRUE AND deleted_at IS NULL`,
  );

  await query(
    `CREATE INDEX IF NOT EXISTS scheduled_payments_user_idx
     ON scheduled_payments (user_id, created_at DESC)
     WHERE deleted_at IS NULL`,
  );

  await query(
    `CREATE TABLE IF NOT EXISTS scheduled_payment_runs (
       id UUID PRIMARY KEY,
       scheduled_payment_id UUID NOT NULL REFERENCES scheduled_payments(id) ON DELETE CASCADE,
       user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
       recipient VARCHAR(42) NOT NULL,
       amount NUMERIC(20, 6) NOT NULL CHECK (amount > 0),
       label VARCHAR(80),
       scheduled_for TIMESTAMPTZ NOT NULL,
       status VARCHAR(20) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'complete', 'failed', 'cancelled')),
       attempts INTEGER NOT NULL DEFAULT 0,
       ledger_id UUID REFERENCES ledger(id) ON DELETE SET NULL,
       circle_transaction_id VARCHAR(100),
       tx_hash VARCHAR(66),
       error TEXT,
       created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
       started_at TIMESTAMPTZ,
       completed_at TIMESTAMPTZ,
       UNIQUE (scheduled_payment_id, scheduled_for)
     )`,
  );

  await query(
    `CREATE INDEX IF NOT EXISTS scheduled_payment_runs_work_idx
     ON scheduled_payment_runs (status, created_at)`,
  );

  await query(
    `ALTER TABLE scheduled_payments
       ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0,
       ADD COLUMN IF NOT EXISTS paused_reason TEXT`,
  );

  await query(
    `ALTER TABLE scheduled_payment_runs
       ADD COLUMN IF NOT EXISTS circle_transaction_id VARCHAR(100)`,
  );

  await query(
    `CREATE INDEX IF NOT EXISTS scheduled_payment_runs_circle_tx_idx
     ON scheduled_payment_runs (circle_transaction_id)
     WHERE circle_transaction_id IS NOT NULL`,
  );
}

export async function listScheduledPayments(userId) {
  const result = await query(
    `SELECT id, recipient, amount::text AS amount, label, interval_hours, next_run_at,
            enabled, last_run_at, last_status, last_error, consecutive_failures, paused_reason,
            created_at, updated_at
     FROM scheduled_payments
     WHERE user_id = $1 AND deleted_at IS NULL
     ORDER BY created_at DESC`,
    [userId],
  );
  return result.rows.map(normalizeScheduleRow);
}

export async function createScheduledPayment(userId, input) {
  const id = crypto.randomUUID();
  const result = await query(
    `INSERT INTO scheduled_payments
       (id, user_id, recipient, amount, label, interval_hours, next_run_at, enabled, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
     RETURNING id, recipient, amount::text AS amount, label, interval_hours, next_run_at,
               enabled, last_run_at, last_status, last_error, consecutive_failures, paused_reason,
               created_at, updated_at`,
    [
      id,
      userId,
      input.recipient,
      input.amount,
      input.label,
      input.intervalHours,
      input.firstRunAt,
      input.enabled,
    ],
  );
  return normalizeScheduleRow(result.rows[0]);
}

export async function updateScheduledPayment(userId, scheduleId, patch) {
  return withTransaction(async (client) => {
    const currentResult = await client.query(
      `SELECT id, recipient, amount::text AS amount, label, interval_hours, next_run_at, enabled
       FROM scheduled_payments
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       FOR UPDATE`,
      [scheduleId, userId],
    );
    const current = currentResult.rows[0];
    if (!current) return null;

    const next = {
      recipient: patch.recipient ?? current.recipient,
      amount: patch.amount ?? String(current.amount),
      label: Object.hasOwn(patch, 'label') ? patch.label : current.label,
      intervalHours: patch.intervalHours ?? Number(current.interval_hours),
      nextRunAt: patch.firstRunAt ?? current.next_run_at,
      enabled: patch.enabled ?? normalizeBoolean(current.enabled, true),
    };
    const currentEnabled = normalizeBoolean(current.enabled, true);
    const nextRunTimestamp = new Date(next.nextRunAt).getTime();
    if (next.enabled && !currentEnabled && Number.isFinite(nextRunTimestamp) && nextRunTimestamp <= Date.now()) {
      next.nextRunAt = new Date(Date.now() + next.intervalHours * 60 * 60 * 1000);
    }

    const result = await client.query(
      `UPDATE scheduled_payments
       SET recipient = $1,
           amount = $2,
           label = $3,
           interval_hours = $4,
           next_run_at = $5,
           enabled = $6,
           last_error = CASE WHEN $6 AND NOT enabled THEN NULL ELSE last_error END,
           consecutive_failures = CASE WHEN $6 AND NOT enabled THEN 0 ELSE consecutive_failures END,
           paused_reason = CASE WHEN $6 AND NOT enabled THEN NULL ELSE paused_reason END,
           updated_at = NOW()
       WHERE id = $7 AND user_id = $8 AND deleted_at IS NULL
       RETURNING id, recipient, amount::text AS amount, label, interval_hours, next_run_at,
                 enabled, last_run_at, last_status, last_error, consecutive_failures, paused_reason,
                 created_at, updated_at`,
      [next.recipient, next.amount, next.label, next.intervalHours, next.nextRunAt, next.enabled, scheduleId, userId],
    );

    return normalizeScheduleRow(result.rows[0]);
  });
}

export async function listScheduledPaymentRuns(userId, scheduleId, limit = 10) {
  const safeLimit = Math.min(25, Math.max(1, Number.parseInt(String(limit), 10) || 10));
  const result = await query(
    `SELECT r.id, r.scheduled_for, r.status, r.attempts, r.circle_transaction_id,
            r.tx_hash, r.error, r.created_at, r.started_at, r.completed_at
     FROM scheduled_payment_runs r
     JOIN scheduled_payments s ON s.id = r.scheduled_payment_id
     WHERE r.scheduled_payment_id = $1
       AND r.user_id = $2
       AND s.user_id = $2
       AND s.deleted_at IS NULL
     ORDER BY r.scheduled_for DESC
     LIMIT $3`,
    [scheduleId, userId, safeLimit],
  );
  return result.rows.map(normalizeScheduleRunRow);
}

export async function deleteScheduledPayment(userId, scheduleId) {
  return withTransaction(async (client) => {
    const result = await client.query(
      `UPDATE scheduled_payments
       SET enabled = FALSE, deleted_at = NOW(), updated_at = NOW()
       WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL
       RETURNING id`,
      [scheduleId, userId],
    );
    if (!result.rows[0]) return false;

    await client.query(
      `UPDATE scheduled_payment_runs
       SET status = 'cancelled', completed_at = NOW(), error = 'Schedule was removed before execution.'
       WHERE scheduled_payment_id = $1 AND status = 'pending'`,
      [scheduleId],
    );
    return true;
  });
}

async function enqueueDueRuns() {
  return withTransaction(async (client) => {
    const dueResult = await client.query(
      `SELECT id, user_id, recipient, amount::text AS amount, label, next_run_at, interval_hours
       FROM scheduled_payments
       WHERE enabled = TRUE AND deleted_at IS NULL AND next_run_at <= NOW()
       ORDER BY next_run_at ASC
       FOR UPDATE SKIP LOCKED
       LIMIT $1`,
      [scheduleBatchSize],
    );

    let enqueued = 0;
    for (const schedule of dueResult.rows) {
      const runResult = await client.query(
        `INSERT INTO scheduled_payment_runs
           (id, scheduled_payment_id, user_id, recipient, amount, label, scheduled_for, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending', NOW())
         ON CONFLICT (scheduled_payment_id, scheduled_for) DO NOTHING
         RETURNING id`,
        [
          crypto.randomUUID(),
          schedule.id,
          schedule.user_id,
          schedule.recipient,
          schedule.amount,
          schedule.label,
          schedule.next_run_at,
        ],
      );
      if (runResult.rows[0]) enqueued += 1;

      await client.query(
        `UPDATE scheduled_payments
         SET next_run_at = CASE
               WHEN next_run_at + (interval_hours * INTERVAL '1 hour') > NOW()
                 THEN next_run_at + (interval_hours * INTERVAL '1 hour')
               ELSE NOW() + (interval_hours * INTERVAL '1 hour')
             END,
             updated_at = NOW()
         WHERE id = $1`,
        [schedule.id],
      );
    }

    return enqueued;
  });
}

async function claimRunnableRun() {
  return withTransaction(async (client) => {
    const result = await client.query(
      `SELECT r.id, r.scheduled_payment_id, r.user_id, r.scheduled_for, r.ledger_id,
              r.recipient, r.amount::text AS amount, r.label
       FROM scheduled_payment_runs r
       JOIN scheduled_payments s ON s.id = r.scheduled_payment_id
       WHERE s.enabled = TRUE
         AND s.deleted_at IS NULL
         AND (
           r.status = 'pending'
           OR (r.status = 'running' AND r.started_at < NOW() - ($1 * INTERVAL '1 minute'))
         )
       ORDER BY r.scheduled_for ASC
       FOR UPDATE OF r SKIP LOCKED
       LIMIT 1`,
      [abandonedRunMinutes],
    );
    const run = result.rows[0];
    if (!run) return null;

    await client.query(
      `UPDATE scheduled_payment_runs
       SET status = 'running', attempts = attempts + 1, started_at = NOW(), error = NULL
       WHERE id = $1`,
      [run.id],
    );
    return run;
  });
}

async function isRunStillActive(runId) {
  const result = await query(
    `SELECT 1
     FROM scheduled_payment_runs r
     JOIN scheduled_payments s ON s.id = r.scheduled_payment_id
     WHERE r.id = $1 AND r.status = 'running' AND s.enabled = TRUE AND s.deleted_at IS NULL`,
    [runId],
  );
  return Boolean(result.rows[0]);
}

async function cancelRun(runId) {
  await query(
    `UPDATE scheduled_payment_runs
     SET status = 'cancelled', completed_at = NOW(), error = 'Schedule was disabled or removed before execution.'
     WHERE id = $1 AND status = 'running'`,
    [runId],
  );
}

async function completeRun(run, result) {
  await withTransaction(async (client) => {
    const runResult = await client.query(
      `UPDATE scheduled_payment_runs
       SET status = 'complete', tx_hash = $1, error = NULL, completed_at = NOW()
       WHERE id = $2 AND status NOT IN ('complete', 'failed', 'cancelled')
       RETURNING scheduled_payment_id`,
      [result.txHash ?? null, run.id],
    );
    if (!runResult.rows[0]) return;
    await client.query(
      `UPDATE scheduled_payments
       SET last_run_at = NOW(), last_status = 'complete', last_error = NULL,
           consecutive_failures = 0, paused_reason = NULL, updated_at = NOW()
       WHERE id = $1`,
      [run.scheduled_payment_id],
    );
  });
}

async function failRun(run, error) {
  const reason = normalizeCircleError(error).text.slice(0, 2000);
  await withTransaction(async (client) => {
    const runResult = await client.query(
      `UPDATE scheduled_payment_runs
       SET status = 'failed', error = $1, completed_at = NOW()
       WHERE id = $2 AND status NOT IN ('complete', 'failed', 'cancelled')
       RETURNING scheduled_payment_id`,
      [reason, run.id],
    );
    if (!runResult.rows[0]) return;
    await recordScheduleFailure(client, run.scheduled_payment_id, reason);
  });
}

async function recordScheduleFailure(client, scheduleId, reason) {
  const threshold = resolveFailurePauseThreshold();
  const pauseReason = `Paused automatically after ${threshold} consecutive failures. Last error: ${reason}`.slice(0, 2000);
  await client.query(
    `UPDATE scheduled_payments
     SET last_run_at = NOW(),
         last_error = $1,
         consecutive_failures = consecutive_failures + 1,
         enabled = CASE WHEN consecutive_failures + 1 >= $3 THEN FALSE ELSE enabled END,
         last_status = CASE WHEN consecutive_failures + 1 >= $3 THEN 'paused' ELSE 'failed' END,
         paused_reason = CASE WHEN consecutive_failures + 1 >= $3 THEN $2 ELSE paused_reason END,
         updated_at = NOW()
     WHERE id = $4`,
    [reason, pauseReason, threshold, scheduleId],
  );
}

export async function applyScheduledRunTransactionStatus(client, ledgerIds, status) {
  if (!Array.isArray(ledgerIds) || ledgerIds.length === 0) return 0;

  const state = String(status?.state ?? '').toUpperCase();
  const txHash = status?.txHash ?? null;
  const error = String(status?.error ?? status?.errorReason ?? status?.errorDetails ?? `Circle transaction ${state}.`).slice(0, 2000);
  let runResult;

  if (state === 'COMPLETE') {
    runResult = await client.query(
      `UPDATE scheduled_payment_runs
       SET status = 'complete', tx_hash = COALESCE($1, tx_hash), error = NULL, completed_at = NOW()
       WHERE ledger_id = ANY($2::uuid[])
         AND status NOT IN ('complete', 'failed', 'cancelled')
       RETURNING scheduled_payment_id`,
      [txHash, ledgerIds],
    );
  } else if (['FAILED', 'DENIED', 'CANCELLED'].includes(state)) {
    runResult = await client.query(
      `UPDATE scheduled_payment_runs
       SET status = 'failed', tx_hash = COALESCE($1, tx_hash), error = $2, completed_at = NOW()
       WHERE ledger_id = ANY($3::uuid[])
         AND status NOT IN ('complete', 'failed', 'cancelled')
       RETURNING scheduled_payment_id`,
      [txHash, error, ledgerIds],
    );
  } else {
    await client.query(
      `UPDATE scheduled_payment_runs
       SET tx_hash = COALESCE($1, tx_hash)
       WHERE ledger_id = ANY($2::uuid[])`,
      [txHash, ledgerIds],
    );
    return 0;
  }

  const scheduleIds = [...new Set(runResult.rows.map((row) => row.scheduled_payment_id))];
  for (const scheduleId of scheduleIds) {
    if (state === 'COMPLETE') {
      await client.query(
        `UPDATE scheduled_payments
         SET last_run_at = NOW(), last_status = 'complete', last_error = NULL,
             consecutive_failures = 0, paused_reason = NULL, updated_at = NOW()
         WHERE id = $1`,
        [scheduleId],
      );
    } else {
      await recordScheduleFailure(client, scheduleId, error);
    }
  }

  return runResult.rowCount;
}

async function releaseRunForRetry(run, error) {
  const reason = normalizeCircleError(error).text.slice(0, 2000);
  await query(
    `UPDATE scheduled_payment_runs
     SET status = 'running', error = $1, started_at = NOW()
     WHERE id = $2 AND status = 'running'`,
    [reason, run.id],
  );
}

async function runWorkerCycle(executePayment) {
  await enqueueDueRuns();

  for (let index = 0; index < scheduleBatchSize; index += 1) {
    const run = await claimRunnableRun();
    if (!run) break;

    try {
      if (!(await isRunStillActive(run.id))) {
        await cancelRun(run.id);
        continue;
      }

      const result = await executePayment({
        runId: run.id,
        scheduleId: run.scheduled_payment_id,
        userId: run.user_id,
        recipient: run.recipient,
        amount: run.amount,
        label: run.label ?? null,
        ledgerId: run.ledger_id ?? null,
        idempotencyKey: run.id,
      });
      await completeRun(run, result);
    } catch (error) {
      if (error?.retryScheduledRun) {
        try {
          await releaseRunForRetry(run, error);
        } catch (updateError) {
          console.warn(`[schedule] Could not release run ${run.id} for retry: ${normalizeCircleError(updateError).text}`);
        }
        continue;
      }

      try {
        await failRun(run, error);
      } catch (updateError) {
        console.warn(`[schedule] Could not record failed run ${run.id}: ${normalizeCircleError(updateError).text}`);
      }
    }
  }
}

function resolvePollIntervalMs() {
  const parsed = Number.parseInt(process.env.SCHEDULE_POLL_INTERVAL_MS ?? '', 10);
  if (!Number.isFinite(parsed)) return defaultPollIntervalMs;
  return Math.min(maximumPollIntervalMs, Math.max(minimumPollIntervalMs, parsed));
}

export function startScheduledPaymentsWorker({ executePayment }) {
  const pollIntervalMs = resolvePollIntervalMs();
  let stopped = false;
  let running = false;
  let timer = null;
  let resolveStopped;
  const stoppedPromise = new Promise((resolve) => {
    resolveStopped = resolve;
  });

  const scheduleNext = () => {
    if (stopped) return;
    timer = setTimeout(() => void tick(), pollIntervalMs);
    timer.unref?.();
  };

  const tick = async () => {
    if (stopped || running) return;
    running = true;
    try {
      await runWorkerCycle(executePayment);
    } catch (error) {
      console.warn(`[schedule] Worker cycle failed: ${normalizeCircleError(error).text}`);
    } finally {
      running = false;
      if (stopped) {
        resolveStopped();
      } else {
        scheduleNext();
      }
    }
  };

  void tick();
  console.log(`[schedule] Worker enabled with ${pollIntervalMs}ms polling.`);

  return {
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (!running) resolveStopped();
      await stoppedPromise;
    },
  };
}

export async function attachLedgerToScheduledRun(client, runId, ledgerId) {
  await client.query(
    `UPDATE scheduled_payment_runs
     SET ledger_id = $1
     WHERE id = $2 AND ledger_id IS NULL`,
    [ledgerId, runId],
  );
}

export async function attachCircleTransactionToScheduledRun(client, runId, transactionId) {
  await client.query(
    `UPDATE scheduled_payment_runs
     SET circle_transaction_id = $1
     WHERE id = $2 AND circle_transaction_id IS NULL`,
    [transactionId, runId],
  );
}

export async function loadScheduledRunLedger(runId) {
  const result = await query(
    `SELECT r.ledger_id, l.status, l.tx_hash
     FROM scheduled_payment_runs r
     LEFT JOIN ledger l ON l.id = r.ledger_id
     WHERE r.id = $1
     LIMIT 1`,
    [runId],
  );
  return result.rows[0] ?? null;
}
