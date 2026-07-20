# Arc Testnet Circle W3S proof of life

This repo is a minimal Node proof-of-life for Circle developer-controlled wallets on Arc Testnet.

## Files to keep local

- `.env` for `CIRCLE_API_KEY` and `CIRCLE_ENTITY_SECRET`
- `wallet.json` for the created wallet id/address
- `.circle/entity-secret-recovery.dat` for the Circle recovery file
- `.circle/entity-secret.env` for the generated entity secret handoff file
- `policy.json` for tip policy
- `ledger.json` for the local spend ledger
- `.token` for the bearer token used by the HTTP server

All of the files above are ignored by git.

## Install

```bash
npm install
```

## Exact run order

1. Run `npm run register-secret`
2. Copy the generated `CIRCLE_ENTITY_SECRET=...` line from `.circle/entity-secret.env` into your local `.env`
3. Run `npm run create-wallet`
4. Fund the printed Arc Testnet wallet address from the Circle faucet
5. Run `npm run balance`
6. Run `npm run test-transfer -- <recipient> <amount>`

## HTTP server

Run the backend with:

```bash
npm start
```

Or:

```bash
npm run server
```

Runtime config:

- `PORT` is used when present. Railway injects it automatically.
- `HOST` defaults to `0.0.0.0` when `PORT` is set, otherwise `127.0.0.1`.
- `AGENT_BEARER_TOKEN` overrides `.token`.
- `WALLET_ID` and `WALLET_ADDRESS` override `wallet.json`.
- `X402_SELLER_ADDRESS` optionally selects the Arc Testnet address that receives x402 nanopayments. It falls back to `WALLET_ADDRESS`.
- `X402_DEMO_PRICE_USDC` sets the paid Arc insight price and defaults to `0.001` USDC.
- `DATABASE_URL` enables the new SIWE-style auth/session layer. If it is missing or unreachable, the server still boots in single-operator mode and logs a warning.
- `SCHEDULE_POLL_INTERVAL_MS` optionally changes scheduled-payment polling. Values are clamped from 5 seconds to 5 minutes, with a 30-second default.
- `SCHEDULE_FAILURE_PAUSE_THRESHOLD` controls automatic pause after consecutive failed occurrences. The default is 3 and values are clamped from 1 to 10.
- `CIRCLE_RECONCILIATION_INTERVAL_MS` controls recovery polling for submitted transactions that remain pending after a restart. The default is 60 seconds.
- `WEEKLY_BUDGET`, `PER_TIP_CAP`, and `ALLOWLIST` override `policy.json`.

Endpoints:

- `GET /health` -> `{ ok: true }`
- `GET /x402/info` returns the public x402 capability, price, Arc network, and seller configuration.
- `GET /x402/arc-insight` returns `402 Payment Required` until a valid Circle Gateway payment signature is supplied, then returns the paid Arc insight.
- `POST /agent/tip` with bearer auth and JSON body `{ "recipient": "...", "amount": "..." }`
- `GET /agent/tip/:id` with bearer auth for Circle transaction polling
- `POST /auth/nonce` with JSON body `{ "address": "0x..." }`
- `POST /auth/verify` with JSON body `{ "address": "0x...", "signature": "0x..." }` and a `walletReady` flag in the response
- `POST /auth/refresh` with JSON body `{ "refreshToken": "..." }`
- `GET /me` with `Authorization: Bearer <accessToken>`
- `POST /agent/provision` with `Authorization: Bearer <accessToken>` to retry wallet setup manually
- `POST /me/tip` with bearer auth and JSON body `{ "recipient": "...", "amount": "..." }`
- `GET /me/policy` and `PUT /me/policy` for server-enforced budget settings
- `POST /me/allowlist` and `DELETE /me/allowlist` for recipient rules
- `GET /me/ledger` for the latest per-user autonomous payments
- `GET /me/schedule` for the current user's recurring payment rules
- `POST /me/schedule` with `{ "recipient": "...", "amount": "...", "intervalHours": 168, "firstRunAt": "<ISO timestamp>", "label": "..." }`
- `POST /me/schedule/preflight` with the same draft body for a read-only wallet, policy, budget, token-balance, and Arc-gas readiness check
- `PUT /me/schedule/:id` to pause, resume, or update a recurring payment
- `DELETE /me/schedule/:id` to remove a recurring payment
- `GET /me/schedule/:id/runs` for the latest execution history of one recurring payment
- `POST /webhooks/circle` for signed Circle transaction notifications

Scheduled-payment notes:

- The server creates and upgrades the reliability tables at startup. The same DDL is available in the `migrations` directory for review or manual migration.
- Each occurrence has a stable UUID used as the Circle idempotency key. A unique database constraint prevents duplicate occurrences.
- Missed intervals are not replayed in a burst after downtime. The next occurrence is scheduled one interval after recovery.
- Every occurrence rechecks wallet provisioning, autonomous mode, the allowlist, per-tip cap, weekly budget, and live Circle transfer outcome.
- Only terminal `COMPLETE` Circle transactions are reported as successful. Failures remain visible on the schedule for inspection.
- Three consecutive failed occurrences pause the affected schedule by default. Manually resuming it clears the failure streak.
- Circle transaction ids are persisted as soon as submission succeeds, allowing signed webhooks and the reconciliation worker to finish interrupted runs without creating a second transfer.

Circle webhook setup:

- Register `https://<your-railway-domain>/webhooks/circle` as a notification endpoint in Circle Console.
- The endpoint verifies the raw request body with `X-Circle-Key-Id` and `X-Circle-Signature` before parsing or storing the event.
- Notification ids are stored uniquely, so Circle retries are safe and idempotent.

Policy is enforced from `policy.json` or the env overrides above:

- `weeklyBudget`
- `perTipCap`
- `allowlist`

Successful tips are appended to `ledger.json` with timestamp and tx hash when the filesystem is writable.

Auth/session notes:

- `/auth/nonce` stores a 10-minute nonce in Postgres and returns a human-readable message to sign.
- `/auth/verify` verifies the signature, upserts the user, creates the user session, and best-effort provisions a per-user Circle W3S wallet. If Circle is slow or fails, the login still succeeds and `walletReady` comes back `false`.
- Only SHA-256 hashes of access and refresh tokens are stored in `sessions`.
- `/auth/refresh` rotates the access token and keeps the refresh token hash valid until expiry.
- `/me` returns the authenticated `userId`, the user's MetaMask `walletAddress`, the per-user `agentAddress`, `agentWalletReady`, and the current policy view.
- `/agent/provision` retries provisioning for the current user and returns the same wallet/profile view as `/me`.
- The existing `/agent/tip` flow still uses the fixed `AGENT_BEARER_TOKEN` and the local `.token` fallback exactly as before.

Deployment notes:

- `/agent/*` responses include permissive CORS so the Chrome extension can call the service during testnet work.
- `Access-Control-Allow-Origin: *` is a testnet simplification; tighten it before any production use.
- If Railway storage is ephemeral or unwritable, the server keeps running and logs a warning when `ledger.json` cannot be persisted.

## Deploy to Railway

Set these env vars in Railway:

- `CIRCLE_API_KEY`
- `CIRCLE_ENTITY_SECRET`
- `WALLET_ID`
- `WALLET_ADDRESS`
- `AGENT_BEARER_TOKEN`
- `DATABASE_URL`
- `WEEKLY_BUDGET`
- `PER_TIP_CAP`
- `ALLOWLIST`
- `SCHEDULE_FAILURE_PAUSE_THRESHOLD` (optional)
- `CIRCLE_RECONCILIATION_INTERVAL_MS` (optional)
- `X402_SELLER_ADDRESS` (optional; falls back to `WALLET_ADDRESS`)
- `X402_DEMO_PRICE_USDC` (optional; defaults to `0.001`)

Use the `WALLET_ID` and `WALLET_ADDRESS` values from your local `wallet.json`. Keep the Circle API and entity secret values in Railway only.

`npm start` is the Railway start command, and `Procfile` points `web` at `npm start`.

## Arc Testnet values

- Blockchain code: `ARC-TESTNET`
- Chain ID: `5042002`
- USDC token address: `0x3600000000000000000000000000000000000000`
- Explorer: `https://testnet.arcscan.app`
