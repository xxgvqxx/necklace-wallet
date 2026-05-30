# Blockbook integration (MVP chain backend)

Last updated 2026-05-29.

For the MVP the extension reads chain data and broadcasts via a **public Pearl
Blockbook** (Trezor "blockbook" v2 API) instead of a self-hosted pearld +
indexer. This removes all chain infra from the MVP critical path.

- Endpoint: `https://blockbook.pearlresearch.ai` (Pearl **mainnet**, pearld 1.0.2, `decimals=8` → Grain).
- Verified live: `synced=true`, returns balance/UTXO/tx/sendtx in the standard Blockbook shapes.

## How it's wired

- `apps/extension/src/api/client.ts` defines a `ChainClient` interface
  (`health/tip/balance/utxos/txs/fees/broadcast`).
- `apps/extension/src/api/blockbook-client.ts` (`BlockbookClient`) implements it
  against Blockbook; `ApiClient` (self-hosted Railway API) implements the same
  interface. The UI and send-flow are unchanged — only `getApiClient()` picks one.
- Selected by `apps/extension/src/api/config.ts`:
  - `CHAIN_BACKEND = "blockbook"` → host `https://blockbook.pearlresearch.ai`, network `mainnet`.
  - `CHAIN_BACKEND = "necklace-api"` → host `https://api.necklace.example`, network `regtest` (local-node dev).
- `manifest.json` `host_permissions` + CSP `connect-src` are pinned to the one
  Blockbook host. Switching backend requires updating the manifest in lockstep.

## Blockbook endpoints used

| Need | Endpoint |
|---|---|
| status / tip / health | `GET /api/v2` |
| balance | `GET /api/v2/address/{addr}` |
| history | `GET /api/v2/address/{addr}?details=txs&pageSize=N` |
| UTXOs | `GET /api/v2/utxo/{addr}` |
| broadcast | `POST /api/v2/sendtx/` (raw hex body) → `{result:txid}` or `{error}` |

## Trust & security posture

Blockbook is **untrusted for integrity** (threat-model §2). The client:
- validates every response with zod (mismatch → `BAD_RESPONSE`);
- **derives each UTXO's `scriptPubKey` locally** from our own address via
  wallet-core `decodeAddress` — it never trusts the backend for what the BIP-341
  sighash commits to (a lying backend yields an invalid signature, not a redirect);
- parses Grain amounts (decimal strings) to `bigint` with no float;
- filters immature coinbase UTXOs; maps `sendtx` errors to stable kinds
  (`ALREADY_KNOWN` / `MALFORMED_TX` / `INSUFFICIENT_FEE` / `TX_REJECTED`).
- sends only public data (addresses) + a fully-signed `rawTxHex`.

**Privacy:** like any light wallet, the provider observes which addresses we query.

## Consequences / TODO

- This makes Necklace a **mainnet** wallet: balance / receive / history work
  against real Pearl now. **Sending is fail-closed** — the mainnet Necklace fee
  address in `src/tx/fee.ts` is `null` (we deliberately do not ship a placeholder
  mainnet fee address). Pin a real, user-controlled mainnet fee address to enable sends.
- `fees()` currently returns Pearl's default relay fee (1000 Grain/kB); wiring
  Blockbook `/estimatefee` is a later refinement once its unit is pinned to a fixture.
- The site's privacy/"single API host" copy should be updated to name the
  Blockbook provider before launch.
