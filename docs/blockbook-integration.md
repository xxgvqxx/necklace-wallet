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
  against Blockbook and is the implementation used by the shipped wallet.
  `ApiClient` (a self-hosted read/broadcast API client) implements the same
  interface and remains in the tree as an alternative, but is not wired into the
  mainnet-only build.
- `apps/extension/src/api/config.ts` pins the single chain host
  (`https://blockbook.pearlresearch.ai`) and `ACTIVE_NETWORK = "mainnet"`; there
  is no runtime backend selector.
- `manifest.json` `host_permissions` + CSP `connect-src` are pinned to the
  Blockbook chain host plus the SafeTrade price host. Changing hosts requires
  updating the manifest in lockstep.

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

## Consequences / notes

- Necklace is a **mainnet** wallet: balance / receive / history / **send** all
  work against real Pearl. The mainnet Necklace fee address is pinned in
  `src/tx/fee.ts` (flat 0.1 PRL fee — see `fee-policy.md`); any network without a
  pinned fee address still fails closed.
- `fees()` currently returns Pearl's default relay fee (1000 Grain/kB); wiring
  Blockbook `/estimatefee` is a later refinement once its unit is pinned to a fixture.
