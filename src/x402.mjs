import { CHAIN_CONFIGS } from '@circle-fin/x402-batching/client';
import { BatchFacilitatorClient } from '@circle-fin/x402-batching/server';

export const ARC_X402_NETWORK = 'eip155:5042002';
export const ARC_X402_RESOURCE_PATH = '/x402/arc-insight';
export const DEFAULT_X402_PRICE_USDC = '0.001';
export const X402_FACILITATOR_URL = 'https://gateway-api-testnet.circle.com';

const evmAddressPattern = /^0x[a-fA-F0-9]{40}$/;
const usdcAmountPattern = /^\d+(?:\.\d{1,6})?$/;
const gatewayAuthorizationLifetimeSeconds = 604_900;

function normalizePrice(value) {
  const candidate = String(value ?? '').trim().replace(/^\$/, '');
  if (!usdcAmountPattern.test(candidate)) {
    return DEFAULT_X402_PRICE_USDC;
  }

  const amount = Number(candidate);
  if (!Number.isFinite(amount) || amount <= 0 || amount > 10) {
    return DEFAULT_X402_PRICE_USDC;
  }

  return candidate;
}

function formatAtomicUsdc(value) {
  const amount = BigInt(String(value ?? '0'));
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function parseUsdcToAtomic(value) {
  const [whole = '0', fraction = ''] = value.split('.');
  return (BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, '0'))).toString();
}

function encodeHeader(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64');
}

function decodePaymentHeader(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('Missing Payment-Signature header.');
  }

  const parsed = JSON.parse(Buffer.from(value, 'base64').toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid x402 payment payload.');
  }
  return parsed;
}

function matchesRequirements(candidate, expected) {
  return Boolean(candidate)
    && candidate.scheme === expected.scheme
    && candidate.network === expected.network
    && String(candidate.asset).toLowerCase() === expected.asset.toLowerCase()
    && candidate.amount === expected.amount
    && String(candidate.payTo).toLowerCase() === expected.payTo.toLowerCase()
    && candidate.maxTimeoutSeconds === expected.maxTimeoutSeconds
    && candidate.extra?.name === expected.extra.name
    && candidate.extra?.version === expected.extra.version
    && String(candidate.extra?.verifyingContract).toLowerCase() === expected.extra.verifyingContract.toLowerCase();
}

export function resolveX402Config(env = process.env) {
  const sellerAddress = String(env.X402_SELLER_ADDRESS ?? env.WALLET_ADDRESS ?? '').trim();
  const priceUsdc = normalizePrice(env.X402_DEMO_PRICE_USDC);

  return Object.freeze({
    enabled: evmAddressPattern.test(sellerAddress),
    sellerAddress: evmAddressPattern.test(sellerAddress) ? sellerAddress : null,
    priceUsdc,
    network: ARC_X402_NETWORK,
    resourcePath: ARC_X402_RESOURCE_PATH,
    facilitatorUrl: X402_FACILITATOR_URL,
  });
}

export function buildArcInsight(payment = {}) {
  return {
    service: 'ArcCopilot x402 Arc Insight',
    summary: 'ArcCopilot can negotiate a paid HTTP resource, show the exact terms, and request an offchain Gateway authorization only after explicit user approval.',
    network: ARC_X402_NETWORK,
    capabilities: [
      'HTTP-native x402 discovery',
      'Arc Testnet USDC nanopayments',
      'Circle Gateway batched settlement',
      'MetaMask EIP-712 approval in ArcCopilot',
    ],
    payment: {
      verified: payment.verified === true,
      payer: typeof payment.payer === 'string' ? payment.payer : '',
      amountUsdc: formatAtomicUsdc(payment.amount),
      transaction: typeof payment.transaction === 'string' ? payment.transaction : '',
    },
    generatedAt: new Date().toISOString(),
  };
}

export function createX402Service(env = process.env) {
  const config = resolveX402Config(env);
  const arcConfig = CHAIN_CONFIGS.arcTestnet;
  const facilitator = config.enabled
    ? new BatchFacilitatorClient({ url: config.facilitatorUrl })
    : null;
  const requirements = config.enabled
    ? Object.freeze({
        scheme: 'exact',
        network: config.network,
        asset: arcConfig.usdc,
        amount: parseUsdcToAtomic(config.priceUsdc),
        payTo: config.sellerAddress,
        maxTimeoutSeconds: gatewayAuthorizationLifetimeSeconds,
        extra: Object.freeze({
          name: 'GatewayWalletBatched',
          version: '1',
          verifyingContract: arcConfig.gatewayWallet,
        }),
      })
    : null;

  return {
    config,
    getInfo() {
      return {
        enabled: config.enabled,
        protocol: 'x402',
        version: 2,
        resource: config.resourcePath,
        priceUsdc: config.priceUsdc,
        network: config.network,
        sellerAddress: config.sellerAddress,
        settlement: 'Circle Gateway batched settlement',
      };
    },
    async handlePaidResource(req, res, { sendJson, responseHeaders = {} }) {
      if (!facilitator || !requirements) {
        sendJson(res, 503, {
          error: 'x402_unavailable',
          message: 'x402 seller address is not configured.',
        }, responseHeaders);
        return;
      }

      for (const [name, value] of Object.entries(responseHeaders)) {
        res.setHeader(name, value);
      }

      const paymentSignature = req.headers['payment-signature'];
      if (!paymentSignature) {
        const paymentRequired = {
          x402Version: 2,
          resource: {
            url: req.url ?? config.resourcePath,
            description: 'ArcCopilot paid Arc insight',
            mimeType: 'application/json',
          },
          accepts: [requirements],
        };
        sendJson(res, 402, {}, {
          ...responseHeaders,
          'Payment-Required': encodeHeader(paymentRequired),
        });
        return;
      }

      let paymentPayload;
      try {
        paymentPayload = decodePaymentHeader(Array.isArray(paymentSignature) ? paymentSignature[0] : paymentSignature);
      } catch (error) {
        sendJson(res, 400, {
          error: 'invalid_x402_payload',
          message: error instanceof Error ? error.message : 'Invalid x402 payment payload.',
        }, responseHeaders);
        return;
      }
      if (paymentPayload.x402Version !== 2 || !matchesRequirements(paymentPayload.accepted, requirements)) {
        sendJson(res, 400, {
          error: 'invalid_x402_terms',
          message: 'Signed payment terms do not match this resource.',
        }, responseHeaders);
        return;
      }

      const settlement = await facilitator.settle(paymentPayload, requirements);
      if (!settlement.success) {
        sendJson(res, 402, {
          error: 'payment_settlement_failed',
          message: settlement.errorReason ?? 'Circle Gateway rejected the payment.',
        }, responseHeaders);
        return;
      }

      const payment = {
        verified: true,
        payer: settlement.payer ?? '',
        amount: requirements.amount,
        network: requirements.network,
        transaction: settlement.transaction,
      };
      sendJson(res, 200, buildArcInsight(payment), {
        ...responseHeaders,
        'Payment-Response': encodeHeader({
          success: true,
          transaction: settlement.transaction,
          network: requirements.network,
          payer: settlement.payer ?? '',
        }),
      });
    },
  };
}
