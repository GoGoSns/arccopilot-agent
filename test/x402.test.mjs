import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import {
  ARC_X402_NETWORK,
  ARC_X402_RESOURCE_PATH,
  DEFAULT_X402_PRICE_USDC,
  buildArcInsight,
  createX402Service,
  resolveX402Config,
} from '../src/x402.mjs';

const sellerAddress = '0xB87B6D1a56bB7942bd07b6B0e9540a63b3dA4365';

test('x402 configuration is additive and falls back to WALLET_ADDRESS', () => {
  const config = resolveX402Config({
    WALLET_ADDRESS: sellerAddress,
    X402_DEMO_PRICE_USDC: '0.0025',
  });

  assert.equal(config.enabled, true);
  assert.equal(config.sellerAddress, sellerAddress);
  assert.equal(config.priceUsdc, '0.0025');
  assert.equal(config.network, ARC_X402_NETWORK);
  assert.equal(config.resourcePath, ARC_X402_RESOURCE_PATH);
});

test('invalid x402 configuration disables only the paid resource and keeps safe defaults', () => {
  const service = createX402Service({
    WALLET_ADDRESS: 'not-an-address',
    X402_DEMO_PRICE_USDC: '1000',
  });
  const info = service.getInfo();

  assert.equal(info.enabled, false);
  assert.equal(info.sellerAddress, null);
  assert.equal(info.priceUsdc, DEFAULT_X402_PRICE_USDC);
  assert.equal(info.version, 2);
});

test('paid Arc insight reports normalized USDC and settlement metadata', () => {
  const insight = buildArcInsight({
    verified: true,
    payer: sellerAddress,
    amount: '1234',
    transaction: '0xabc',
  });

  assert.equal(insight.payment.verified, true);
  assert.equal(insight.payment.amountUsdc, '0.001234');
  assert.equal(insight.payment.payer, sellerAddress);
  assert.equal(insight.payment.transaction, '0xabc');
  assert.equal(insight.network, ARC_X402_NETWORK);
});

test('unpaid x402 resource returns inspectable Arc terms without settling', async (context) => {
  const service = createX402Service({
    X402_SELLER_ADDRESS: sellerAddress,
    X402_DEMO_PRICE_USDC: '0.001',
  });
  const sendJson = (res, statusCode, body, headers = {}) => {
    res.writeHead(statusCode, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    void service.handlePaidResource(req, res, { sendJson });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  context.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const response = await fetch(`http://127.0.0.1:${address.port}${ARC_X402_RESOURCE_PATH}`);

  assert.equal(response.status, 402);
  const header = response.headers.get('Payment-Required');
  assert.ok(header);
  const terms = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
  assert.equal(terms.x402Version, 2);
  assert.equal(terms.accepts.length, 1);
  assert.equal(terms.accepts[0].network, ARC_X402_NETWORK);
  assert.equal(terms.accepts[0].amount, '1000');
  assert.equal(terms.accepts[0].payTo, sellerAddress);
  assert.ok(terms.accepts[0].maxTimeoutSeconds >= 604_800);
});
