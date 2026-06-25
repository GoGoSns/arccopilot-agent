import { createCircleTipContext, submitTipTransfer } from '../src/arc-tip-service.mjs';
import { isArcTestnetRejected, normalizeCircleError, validatePositiveAmount, validateRecipientAddress } from './shared.mjs';

async function main() {
  const [recipientArg, amountArg] = process.argv.slice(2);
  if (!recipientArg || !amountArg) throw new Error('Usage: npm run test-transfer -- <recipient> <amount>');
  const recipient = validateRecipientAddress(recipientArg);
  const amount = validatePositiveAmount(amountArg);

  const context = await createCircleTipContext();

  console.log(`[test-transfer] Source wallet: ${context.walletId} (${context.walletAddress})`);
  console.log(`[test-transfer] Recipient: ${recipient}`);
  console.log(`[test-transfer] Amount: ${amount} USDC`);

  const result = await submitTipTransfer(context, {
    recipient,
    amount,
    onState: (state) => {
      console.log(`[test-transfer] State: ${state}`);
    },
  });

  console.log(`[test-transfer] Final state: ${result.state}`);
  if (result.txHash) {
    console.log(`[test-transfer] Tx hash: ${result.txHash}`);
    console.log(`[test-transfer] ArcScan: ${result.arcscanUrl}`);
  } else {
    console.log('[test-transfer] Tx hash: unavailable');
    console.log('[test-transfer] ArcScan: unavailable because no tx hash was returned.');
  }
}

main().catch((error) => {
  if (isArcTestnetRejected(error)) {
    console.error('[test-transfer] Arc Testnet was rejected by the Circle API.');
  }
  console.error(`[test-transfer] Failed: ${normalizeCircleError(error).text}`);
  process.exitCode = 1;
});
