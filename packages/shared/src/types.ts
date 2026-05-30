/**
 * Shared domain types for Necklace.
 *
 * These are the cross-cutting types used by the extension, the API service and
 * the site. Protocol facts encoded here come from `docs/protocol-findings.md`.
 */

/**
 * Pearl networks. Dev work targets regtest. HRP and WIF netID differ per network
 * (see `packages/wallet-core/fixtures/derived-address.json` /
 * `import-key.json`).
 */
export type Network =
  | "mainnet"
  | "testnet"
  | "testnet2"
  | "regtest"
  | "simnet"
  | "signet";

/** bech32m human-readable prefix per network. */
export const HRP_BY_NETWORK: Record<Network, string> = {
  mainnet: "prl",
  testnet: "tprl",
  testnet2: "tprl",
  regtest: "rprl",
  simnet: "rprl",
  signet: "tprl",
};

/** WIF PrivateKeyID byte per network (`node/chaincfg/params.go`). */
export const WIF_NETID_BY_NETWORK: Record<Network, number> = {
  mainnet: 0x80,
  testnet: 0xef,
  testnet2: 0xef,
  regtest: 0xef,
  simnet: 0x64,
  signet: 0xef,
};

/**
 * BIP-86 coin type for the m/86' derivation path. Mainnet uses Pearl's own coin
 * type; every testnet uses 1.
 */
export const BIP86_COIN_TYPE_BY_NETWORK: Record<Network, number> = {
  mainnet: 808276,
  testnet: 1,
  testnet2: 1,
  regtest: 1,
  simnet: 1,
  signet: 1,
};

/**
 * Smallest representable amount, in Grain. `1 PRL = 1e8 Grain`. Stored as a
 * bigint to avoid float error and to cover the 21e9 * 1e8 supply cap, which
 * exceeds Number.MAX_SAFE_INTEGER.
 */
export type Grain = bigint;

/** A Taproot (witness v1, P2TR) address string in bech32m. */
export type Bech32mAddress = string;

/** Witness versions Necklace can encode/decode. MVP signs v1 only. */
export type WitnessVersion = 1 | 2;

/** Supported key-import formats. XMSS material is never imported. */
export type KeyImportKind =
  | "wif"
  | "rawHex"
  | "mnemonic"
  | "xpub"
  | "watchOnly";

/** An unspent output as returned by the Railway indexer. */
export interface Utxo {
  /** Funding transaction id, big-endian hex (display order). */
  txid: string;
  /** Output index within the funding transaction. */
  vout: number;
  /** Value of the output, in Grain. */
  value: Grain;
  /** The output's scriptPubKey, hex-encoded. Needed for BIP-341 sighash. */
  scriptPubKeyHex: string;
  /** Address the UTXO pays to, if decodable. */
  address?: Bech32mAddress;
  /** Confirmations, if known. */
  confirmations?: number;
}

/** A single transaction output the user wants to create. */
export interface TxRecipient {
  address: Bech32mAddress;
  /** Amount to send, in Grain. */
  value: Grain;
}

/**
 * The explicit, visible flat Necklace fee. It is materialized as a real extra
 * P2TR output, never hidden, and must sit above the dust floor.
 */
export interface NecklaceFee {
  address: Bech32mAddress;
  /** Flat fee amount, in Grain. */
  value: Grain;
}

/**
 * A fully described transaction draft, presented to the user for review before
 * signing. All amounts are Grain.
 */
export interface TxDraft {
  network: Network;
  inputs: Utxo[];
  recipients: TxRecipient[];
  /** Optional change output back to the wallet. */
  change?: TxRecipient;
  /** The visible flat Necklace fee output. */
  necklaceFee?: NecklaceFee;
  /** Miner fee, in Grain (inputs - all outputs). */
  minerFee: Grain;
}

/** Result of signing: the raw tx hex that gets POSTed to the API for broadcast. */
export interface SignedTx {
  /** Transaction id, big-endian hex (display order). */
  txid: string;
  /** Full serialized signed transaction, hex-encoded. */
  rawHex: string;
}

/** Address metadata derived locally and shown in the UI. */
export interface DerivedAddress {
  network: Network;
  address: Bech32mAddress;
  witnessVersion: WitnessVersion;
  /** Witness program, hex (always 32 bytes for Pearl). */
  witnessProgramHex: string;
  /** BIP-86 derivation path, if HD-derived. */
  path?: string;
}

/** The encrypted vault blob persisted to chrome.storage.local. */
export interface EncryptedVault {
  /** Schema version for forward migration. */
  version: number;
  /** KDF identifier, e.g. "PBKDF2-SHA256". */
  kdf: string;
  /** KDF iteration count. */
  kdfIterations: number;
  /** Base64 salt for the KDF. */
  saltB64: string;
  /** Base64 IV/nonce for the AEAD cipher. */
  ivB64: string;
  /** AEAD identifier, e.g. "AES-GCM". */
  cipher: string;
  /** Base64 ciphertext (encrypted key material). */
  ciphertextB64: string;
}
