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
- `WEEKLY_BUDGET`, `PER_TIP_CAP`, and `ALLOWLIST` override `policy.json`.

Endpoints:

- `GET /health` -> `{ ok: true }`
- `POST /agent/tip` with bearer auth and JSON body `{ "recipient": "...", "amount": "..." }`
- `GET /agent/tip/:id` with bearer auth for Circle transaction polling

Policy is enforced from `policy.json` or the env overrides above:

- `weeklyBudget`
- `perTipCap`
- `allowlist`

Successful tips are appended to `ledger.json` with timestamp and tx hash when the filesystem is writable.

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
- `WEEKLY_BUDGET`
- `PER_TIP_CAP`
- `ALLOWLIST`

Use the `WALLET_ID` and `WALLET_ADDRESS` values from your local `wallet.json`. Keep the Circle API and entity secret values in Railway only.

`npm start` is the Railway start command, and `Procfile` points `web` at `npm start`.

## Arc Testnet values

- Blockchain code: `ARC-TESTNET`
- Chain ID: `5042002`
- USDC token address: `0x3600000000000000000000000000000000000000`
- Explorer: `https://testnet.arcscan.app`
