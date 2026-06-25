import crypto from 'node:crypto';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { normalizeCircleError, validatePositiveAmount, validateRecipientAddress } from '../scripts/shared.mjs';

const defaultPort = 8787;

function resolveServerHost() {
  return process.env.HOST ?? (process.env.PORT ? '0.0.0.0' : '127.0.0.1');
}

function resolveServerPort() {
  const parsed = Number.parseInt(process.env.PORT ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultPort;
}

const corsHeaders = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

function isAgentRoute(pathname) {
  return pathname === '/agent' || pathname.startsWith('/agent/');
}

function getHeader(req, name) {
  const value = req.headers[name.toLowerCase()];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value ?? '';
}

function isAuthorized(req, bearerToken) {
  const header = String(getHeader(req, 'authorization') ?? '').trim();
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return false;
  }

  const provided = Buffer.from(match[1].trim());
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

async function createServerState() {
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
    const responseHeaders = isAgentRoute(pathname) ? corsHeaders : undefined;

    if (req.method === 'OPTIONS' && isAgentRoute(pathname)) {
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

    if (req.method === 'GET' && routeMatchesTipStatus(pathname)) {
      await handleTipStatus(req, res, state, pathname, responseHeaders);
      return;
    }

    sendError(res, 404, 'not_found', 'Route not found.', {}, responseHeaders);
  } catch (error) {
    const pathname = normalizePath(new URL(req.url ?? '/', `http://${req.headers.host ?? resolveServerHost()}`).pathname);
    const responseHeaders = isAgentRoute(pathname) ? corsHeaders : undefined;

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
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
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
