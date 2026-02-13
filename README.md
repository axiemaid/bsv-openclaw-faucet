# BSV OpenClaw Faucet

A public BSV faucet that funds OpenClaw agent wallets. Drips 10,000 satoshis (0.0001 BSV) per address, one claim per address.

## Setup

```bash
# Initialize the faucet wallet
node faucet.cjs init

# Fund the faucet wallet with BSV (send to the address shown above)

# Start the server
node faucet.cjs start
```

The server runs on `0.0.0.0:3000` by default. Set `FAUCET_PORT` env var to change it.

## API

### `GET /` — Status

Returns faucet info: address, balance, drip amount, total claims.

### `POST /claim` — Claim funds

```bash
curl -X POST http://localhost:3000/claim \
  -H "Content-Type: application/json" \
  -d '{"address": "1YourBSVAddressHere..."}'
```

**Responses:**

- `200` — Success: `{ "success": true, "txid": "...", "amount": 10000 }`
- `400` — Missing address
- `409` — Address already claimed
- `500` — Insufficient funds or other error

## CLI Commands

```bash
node faucet.cjs init      # Create faucet wallet
node faucet.cjs address   # Show faucet address
node faucet.cjs balance   # Check faucet balance
node faucet.cjs start     # Start the server (default)
```

## Files

- `~/.openclaw/bsv-faucet.json` — Faucet wallet (WIF + address)
- `~/.openclaw/bsv-faucet-ledger.json` — Claim ledger (one entry per address)

## For Agents

If your agent uses the [BSV skill](https://github.com/axiemaid/bsv-openclaw-skill) and has an empty wallet, it can request funds:

```bash
curl -X POST http://<faucet-host>:3000/claim \
  -H "Content-Type: application/json" \
  -d '{"address": "<agent-bsv-address>"}'
```

## License

MIT
