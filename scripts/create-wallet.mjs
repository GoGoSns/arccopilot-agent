import crypto from 'node:crypto';
import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { arcBlockchain, ensureCircleDir, isArcTestnetRejected, loadEnv, maskApiKey, normalizeCircleError, requireEnv, walletJsonPath, writeJson } from './shared.mjs';

async function main() {
  loadEnv();
  const apiKey = requireEnv('CIRCLE_API_KEY');
  const entitySecret = requireEnv('CIRCLE_ENTITY_SECRET');
  await ensureCircleDir();
  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

  console.log(`[create-wallet] API key: ${maskApiKey(apiKey)}`);
  console.log('[create-wallet] Creating wallet set...');
  const walletSetRes = await client.createWalletSet({
    name: `Arc Testnet proof-of-life ${new Date().toISOString()}`,
    idempotencyKey: crypto.randomUUID(),
  });
  const walletSetId = walletSetRes?.data?.walletSet?.id ?? walletSetRes?.data?.id;
  if (!walletSetId) throw new Error('createWalletSet did not return a wallet set id.');
  console.log(`[create-wallet] Wallet set id: ${walletSetId}`);

  console.log('[create-wallet] Creating one EOA wallet on ARC-TESTNET...');
  const walletsRes = await client.createWallets({
    walletSetId,
    accountType: 'EOA',
    blockchains: [arcBlockchain],
    count: 1,
    idempotencyKey: crypto.randomUUID(),
  });
  const wallet = walletsRes?.data?.wallets?.[0];
  if (!wallet?.id || !wallet?.address) throw new Error('createWallets did not return a wallet id and address.');

  console.log(`[create-wallet] Wallet id: ${wallet.id}`);
  console.log(`[create-wallet] Wallet address: ${wallet.address}`);
  await writeJson(walletJsonPath, {
    walletSetId,
    walletId: wallet.id,
    address: wallet.address,
    blockchain: arcBlockchain,
    accountType: 'EOA',
    createdAt: new Date().toISOString(),
  });
  console.log(`[create-wallet] Saved wallet details to ${walletJsonPath}`);
}

main().catch((error) => {
  if (isArcTestnetRejected(error)) {
    const details = normalizeCircleError(error);
    console.error(`[create-wallet] Arc Testnet was rejected by the Circle API.`);
    console.error(`[create-wallet] ${details.text}`);
  } else {
    console.error(`[create-wallet] Failed: ${error?.message ?? error}`);
  }
  process.exitCode = 1;
});
