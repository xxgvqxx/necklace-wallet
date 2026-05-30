/**
 * @necklace/wallet-core — browser-safe PRL primitives.
 *
 * A TypeScript port of Pearl's Schnorr/Taproot key-path crypto (Phase 1
 * BROWSER SIGNING APPROACH = ts-port). Pure EC crypto via @noble/* and
 * @scure/*, pinned to the repo's real KATs in ./fixtures. No cgo, no XMSS, no
 * remote code.
 *
 * Modules:
 *   address.ts     — bech32m encode/decode, BIP-86 P2TR derivation, TapTweak.
 *   keys.ts        — WIF (base58check) + raw-hex private-key import.
 *   utxo.ts        — eligibility filtering + largest-first fee-aware selection.
 *   fees.ts        — flat-fee policy + Pearl-exact network/miner fee estimation.
 *   transaction.ts — unsigned tx builder + explicit visible Necklace fee output.
 *   serialize.ts   — btcd/Bitcoin wire (de)serialization + txid/wtxid.
 *   sign.ts        — BIP-341 sighash + BIP-340 Schnorr key-path signing.
 *
 * XMSS (post-quantum, stateful OTS) is DEFERRED and lives in @necklace/pearl-wasm
 * as documentation only — it is never signed in-browser. See
 * docs/protocol-findings.md.
 */

export * from "./address.js";
export * from "./keys.js";
export * from "./fees.js";
export * from "./utxo.js";
export * from "./serialize.js";
export * from "./transaction.js";
export * from "./sign.js";
export * from "./hd.js";
