import { initiateDeveloperControlledWalletsClient } from '@circle-fin/developer-controlled-wallets';
import { arcUsdcTokenAddress, fileExists, loadEnv, normalizeCircleError, readJson, requireEnv, walletJsonPath } from './shared.mjs';

async function main() {
  loadEnv();
  const apiKey = requireEnv('CIRCLE_API_KEY');
  const entitySecret = requireEnv('CIRCLE_ENTITY_SECRET');
  if (!(await fileExists(walletJsonPath))) throw new Error('wallet.json is missing. Run npm run create-wallet first.');
  const { walletId, address } = await readJson(walletJsonPath);
  const client = initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });

  console.log(`[balance] Wallet id: ${walletId}`);
  console.log(`[balance] Wallet address: ${address}`);
  const res = await client.getWalletTokenBalance({ id: walletId });
  const tokenBalances = res?.data?.tokenBalances ?? [];
  const native = tokenBalances.find((entry) => entry?.token?.isNative);
  const usdc = tokenBalances.find((entry) => String(entry?.token?.tokenAddress ?? '').toLowerCase() === arcUsdcTokenAddress.toLowerCase());

  console.log(`[balance] Native balance: ${native?.amount ?? '0'} ${native?.token?.symbol ?? ''}`.trim());
  console.log(`[balance] USDC balance: ${usdc?.amount ?? '0'} ${usdc?.token?.symbol ?? 'USDC'}`);
}

main().catch((error) => {
  console.error(`[balance] Failed: ${normalizeCircleError(error).text}`);
  process.exitCode = 1;
});
