import dotenv from 'dotenv';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
export const rootDir = path.resolve(scriptDir, '..');
export const circleDir = path.join(rootDir, '.circle');
export const walletJsonPath = path.join(rootDir, 'wallet.json');
export const entitySecretHandoffPath = path.join(circleDir, 'entity-secret.env');
export const recoveryFilePath = path.join(circleDir, 'entity-secret-recovery.dat');
export const arcBlockchain = 'ARC-TESTNET';
export const arcUsdcTokenAddress = '0x3600000000000000000000000000000000000000';
export const arcScanTxBaseUrl = 'https://testnet.arcscan.app/tx/';
export const terminalStates = new Set(['COMPLETE', 'FAILED', 'DENIED', 'CANCELLED', 'STUCK']);

export function loadEnv() {
  dotenv.config({ path: path.join(rootDir, '.env') });
}

export function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}. Put it in local .env.`);
  return value.trim();
}

export async function ensureCircleDir() {
  fsSync.mkdirSync(circleDir, { recursive: true });
}

export async function writeJson(filePath, value) {
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function maskApiKey(apiKey) {
  const parts = String(apiKey).split(':');
  if (parts.length !== 3) return '***';
  return `${parts[0]}:***:${parts[2].slice(-4)}`;
}

export function normalizeCircleError(error) {
  const status = error?.status ?? error?.response?.status ?? error?.cause?.status;
  const body = error?.response?.data ?? error?.data ?? error?.body ?? error?.cause?.body;
  const message = error?.message ?? String(error);
  return {
    status,
    body,
    message,
    text: `${status ? `HTTP ${status} ` : ''}${message} ${body ? JSON.stringify(body) : ''}`.trim(),
  };
}

export function isCircleApiError(error) {
  // Circle SDK HTTP errors set a numeric `.status`; pg DatabaseError never does.
  return Boolean(error) && typeof error.status === 'number';
}

export function isArcTestnetRejected(error) {
  const text = normalizeCircleError(error).text.toLowerCase();
  return text.includes('arc-testnet') && (
    text.includes('unsupported') ||
    text.includes('not supported') ||
    text.includes('not accepted') ||
    text.includes('invalid') ||
    text.includes('unknown')
  );
}

export function isTerminalState(state) {
  return terminalStates.has(String(state ?? '').toUpperCase());
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function validateRecipientAddress(value) {
  if (!/^0x[a-fA-F0-9]{40}$/.test(value)) {
    throw new Error('Recipient must be a 0x-prefixed 20-byte EVM address.');
  }
  return value;
}

export function validatePositiveAmount(value) {
  if (!/^\d+(\.\d+)?$/.test(value) || Number(value) <= 0) {
    throw new Error('Amount must be a positive decimal string.');
  }
  return value;
}
