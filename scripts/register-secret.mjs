import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { registerEntitySecretCiphertext } from '@circle-fin/developer-controlled-wallets';
import { circleDir, entitySecretHandoffPath, ensureCircleDir, fileExists, loadEnv, maskApiKey, normalizeCircleError, recoveryFilePath, requireEnv } from './shared.mjs';

function parseEntitySecretFile(content) {
  const line = content.split(/\r?\n/).find((entry) => entry.startsWith('CIRCLE_ENTITY_SECRET='));
  const secret = line?.slice('CIRCLE_ENTITY_SECRET='.length).trim();
  if (!secret || !/^[0-9a-fA-F]{64}$/.test(secret)) {
    throw new Error(`Invalid entity secret file at ${entitySecretHandoffPath}.`);
  }
  return secret;
}

async function getEntitySecret() {
  if (await fileExists(entitySecretHandoffPath)) {
    return {
      secret: parseEntitySecretFile(await fs.readFile(entitySecretHandoffPath, 'utf8')),
      reused: true,
    };
  }

  const secret = crypto.randomBytes(32).toString('hex');
  fsSync.mkdirSync(circleDir, { recursive: true });
  await fs.writeFile(entitySecretHandoffPath, `CIRCLE_ENTITY_SECRET=${secret}\n`, 'utf8');
  return { secret, reused: false };
}

async function main() {
  loadEnv();
  const apiKey = requireEnv('CIRCLE_API_KEY');
  await ensureCircleDir();
  const { secret: entitySecret, reused } = await getEntitySecret();

  console.log(`[register-secret] ${reused ? 'Reusing' : 'Generated'} entity secret handoff file: ${entitySecretHandoffPath}`);
  console.log(`[register-secret] API key in use: ${maskApiKey(apiKey)}`);

  try {
    const response = await registerEntitySecretCiphertext({
      apiKey,
      entitySecret,
    });
    const recoveryFile = response?.data?.recoveryFile;
    if (!recoveryFile) {
      throw new Error('Circle did not return a recovery file string.');
    }
    fsSync.mkdirSync(circleDir, { recursive: true });
    await fs.writeFile(recoveryFilePath, recoveryFile, 'utf8');
    console.log('[register-secret] Registration succeeded with Circle.');
    console.log(`[register-secret] Recovery file written: ${recoveryFilePath}`);
  } catch (error) {
    const normalized = normalizeCircleError(error);
    const details = normalized.text.toLowerCase();
    const alreadyRegistered =
      normalized.status === 409 ||
      details.includes('already registered') ||
      details.includes('already been registered') ||
      (details.includes('entity secret') && details.includes('registered'));
    if (!alreadyRegistered) {
      throw error;
    }
    console.log('[register-secret] Circle says this entity secret was already registered.');
    console.log(`[register-secret] Reusing local handoff file: ${entitySecretHandoffPath}`);
    if (await fileExists(recoveryFilePath)) {
      console.log(`[register-secret] Recovery file already present: ${recoveryFilePath}`);
    } else {
      console.log(`[register-secret] Recovery file not rewritten because Circle rejected the second registration. Expected path: ${recoveryFilePath}`);
    }
  }

  console.log(`[register-secret] CIRCLE_ENTITY_SECRET is saved in ${entitySecretHandoffPath} (copy that line into your local .env).`);
}

main().catch((error) => {
  console.error(`[register-secret] Failed: ${error?.message ?? error}`);
  process.exitCode = 1;
});
