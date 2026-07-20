import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import {
  parseCircleWebhookPayload,
  verifyCircleWebhookSignature,
} from '../src/circle-webhooks.mjs';
import { isTerminalState } from '../scripts/shared.mjs';

test('verifies a Circle ECDSA SHA-256 webhook signature', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const rawBody = Buffer.from(JSON.stringify({ notificationId: 'notification-test-1' }));
  const signature = crypto.sign('sha256', rawBody, { key: privateKey, dsaEncoding: 'der' }).toString('base64');
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return {
        data: {
          algorithm: 'ECDSA_SHA_256',
          publicKey: publicKeyDer,
        },
      };
    },
  });

  assert.equal(await verifyCircleWebhookSignature({
    rawBody,
    keyId: `test-${crypto.randomUUID()}`,
    signature,
    apiKey: 'TEST_API_KEY',
    fetchImpl,
    publicKeyBaseUrl: 'https://example.test/public-key',
  }), true);
});

test('rejects a signature for a modified webhook body', async () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const original = Buffer.from('{"notificationId":"original"}');
  const signature = crypto.sign('sha256', original, { key: privateKey, dsaEncoding: 'der' }).toString('base64');
  const publicKeyDer = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

  assert.equal(await verifyCircleWebhookSignature({
    rawBody: Buffer.from('{"notificationId":"modified"}'),
    keyId: `test-${crypto.randomUUID()}`,
    signature,
    apiKey: 'TEST_API_KEY',
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      async json() {
        return { data: { algorithm: 'ECDSA_SHA_256', publicKey: publicKeyDer } };
      },
    }),
    publicKeyBaseUrl: 'https://example.test/public-key',
  }), false);
});

test('extracts transaction details from a Circle webhook payload', () => {
  assert.deepEqual(parseCircleWebhookPayload({
    notificationId: 'notification-1',
    notificationType: 'transactions',
    notification: {
      id: 'transaction-1',
      state: 'COMPLETE',
      txHash: '0xabc',
    },
  }), {
    notificationId: 'notification-1',
    notificationType: 'transactions',
    transactionId: 'transaction-1',
    state: 'COMPLETE',
    txHash: '0xabc',
    error: null,
  });
});

test('keeps Circle STUCK transactions open for later reconciliation', () => {
  assert.equal(isTerminalState('STUCK'), false);
  assert.equal(isTerminalState('COMPLETE'), true);
});
