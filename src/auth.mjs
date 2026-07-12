import crypto from 'node:crypto';
import { getAddress, verifyMessage } from 'ethers';
import { validateRecipientAddress } from '../scripts/shared.mjs';

export const authDomain = 'ArcCopilot';

export function normalizeAuthAddress(value) {
  return validateRecipientAddress(String(value ?? '').trim()).toLowerCase();
}

export function generateNonce() {
  return crypto.randomBytes(16).toString('hex');
}

export function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

export function hashToken(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

export function buildAuthMessage({ address, nonce }) {
  return [
    'ArcCopilot sign-in request',
    `Domain: ${authDomain}`,
    `Address: ${address}`,
    `Nonce: ${nonce}`,
    'Expiry note: this nonce expires 10 minutes after issuance and the resulting session lasts about 1 hour.',
  ].join('\n');
}

export function recoverSignerAddress({ message, signature }) {
  return getAddress(verifyMessage(message, signature)).toLowerCase();
}
