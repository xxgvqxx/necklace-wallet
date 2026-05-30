/**
 * Vault data model for Necklace.
 *
 * The vault is the ONLY place the wallet's secret material lives at rest, and it
 * is always encrypted (AES-256-GCM) under a key derived from the user's
 * passphrase. Plaintext key material exists only transiently in memory while the
 * wallet is unlocked (see `session.ts`); it is NEVER persisted in the clear,
 * NEVER written to `chrome.storage.sync`, and NEVER logged or sent to the
 * network. The Railway/Vercel backends only ever receive a signed raw tx hex.
 *
 * Protocol facts encoded here come from `docs/protocol-findings.md`.
 */

/**
 * The chain a vault is bound to. This is intentionally a coarse,
 * vault-level discriminator. The fine-grained `Network` union in
 * `@necklace/shared` (regtest/simnet/signet/testnet2/…) selects HRP, WIF netID
 * and BIP-86 coin type at address-derivation / signing time. A single vault
 * record commits only to mainnet-vs-testnet so that test funds and real funds
 * can never share an encrypted record.
 */
export type VaultChain = "pearl-mainnet" | "pearl-testnet";

/** Key-derivation function identifiers supported by the vault. */
export type KdfId =
  /** WebCrypto PBKDF2-HMAC-SHA256. Always available in MV3 (default). */
  | "pbkdf2-sha256"
  /**
   * Argon2id (memory-hard). Available via the bundled, audited
   * `@noble/hashes/argon2` — NOT remote code. Disabled by default; see
   * `kdf.ts` for the documented seam and MV3 viability notes.
   */
  | "argon2id";

/** Authenticated cipher identifier. Only AES-256-GCM is used. */
export type CipherId = "aes-256-gcm";

/** How the secret stored inside the encrypted payload should be interpreted. */
export type SecretKind =
  /** A raw 32-byte secp256k1 private key (hex), e.g. from WIF or raw-hex import. */
  | "secp256k1-privkey"
  /** A BIP-39 mnemonic + BIP-32/86 seed flow (generated in-browser or imported). */
  | "bip39-mnemonic"
  /** Watch-only: an xpub / account extended public key; no spend capability. */
  | "watch-only-xpub";

/**
 * KDF parameters, persisted alongside the ciphertext so the key can be
 * re-derived on unlock. None of these are secret.
 */
export interface KdfParams {
  kdf: KdfId;
  /** Base64-encoded random salt, unique per vault. */
  saltB64: string;
  /** PBKDF2 iteration count (only meaningful when `kdf === "pbkdf2-sha256"`). */
  iterations?: number;
  /** Argon2id time cost (only meaningful when `kdf === "argon2id"`). */
  timeCost?: number;
  /** Argon2id memory cost in KiB (only meaningful when `kdf === "argon2id"`). */
  memoryCostKiB?: number;
  /** Argon2id parallelism (only meaningful when `kdf === "argon2id"`). */
  parallelism?: number;
}

/**
 * The encrypted secret payload. `ciphertextB64` is the AES-256-GCM output
 * (ciphertext || 16-byte auth tag, as produced by WebCrypto) over the JSON
 * serialization of the plaintext secret. `ivB64` is a fresh random 96-bit IV
 * generated for THIS encryption and never reused.
 */
export interface EncryptedPayload {
  cipher: CipherId;
  /** Base64 random IV/nonce. 12 bytes for AES-GCM. Never reused. */
  ivB64: string;
  /** Base64 AES-256-GCM ciphertext (includes the auth tag). */
  ciphertextB64: string;
}

/**
 * The XMSS one-time-signature commitment metadata recorded on a generated /
 * full-key vault.
 *
 * Pearl's XMSS (XMSS-SHAKE256_5_256) is STATEFUL: 32 signatures max per key, and
 * the OTS index (`msg_uid`) is caller-supplied on every sign. Reusing an index
 * leaks WOTS+ chain values and allows forgery / theft (xmss.h, verbatim). The
 * Pearl repo ships NO production OTS-index management. A browser is the worst
 * possible host for that state (chrome.storage can be cleared, profile-synced,
 * or restored from backup — any of which rolls the index back catastrophically).
 *
 * Therefore Necklace's MVP NEVER signs XMSS in-browser. We still model the
 * commitment because:
 *  - The XMSS *public* key/commitment is deterministically derivable from the HD
 *    key (HKDF over m/222'); recording it is harmless and lets the UI show that
 *    the address carries a PQ-recovery commitment.
 *  - The `signingSealed` flag is an explicit, persisted invariant: the service
 *    worker refuses every XMSS sign request while it is `true` (always, in MVP).
 *  - `nextOtsIndex` is the monotonic counter a future, controlled, single-writer
 *    signer WOULD advance. `storage.ts` provides an atomic compare-and-advance
 *    primitive so that, if XMSS signing is ever enabled out-of-band, the counter
 *    cannot be rolled back within this store. In the MVP it stays at 0 and is
 *    never advanced.
 */
export interface XmssCommitmentState {
  /** Algorithm tag, fixed for Pearl. */
  scheme: "XMSS-SHAKE256_5_256";
  /** Total OTS leaves available (MAX_SIGNS). Fixed at 32 for full_height=5. */
  maxSignatures: 32;
  /**
   * The next unused OTS index (`msg_uid`). MUST be advanced atomically and
   * persisted BEFORE a signature is released, if signing is ever enabled.
   * In the MVP this is always 0 and is never advanced.
   */
  nextOtsIndex: number;
  /**
   * Hard safety interlock. When `true` (always, in the MVP) the background
   * worker rejects every XMSS sign request. Flipping this to `false` is NOT a
   * supported MVP operation and would require an out-of-band, single-writer,
   * crash-safe state owner per docs/protocol-findings.md.
   */
  signingSealed: true;
  /** Hex of the derived XMSS public commitment, if computed. Public, not secret. */
  commitmentHex?: string;
}

/**
 * The persisted, encrypted vault record (v1 — legacy single-account shape).
 * Everything in this object is safe to write to `chrome.storage.local`: the
 * only secret is inside `payload.ciphertextB64`, which is AES-256-GCM
 * ciphertext.
 *
 * NOTE: v1 is the original single-account file. Builds now write a {@link
 * VaultFile} (v2) holding many {@link VaultAccount}s under one wallet-level KDF.
 * `storage.ts` losslessly migrates any v1 record it finds into a v2 file on
 * load (a single "Account 1"). This type is retained only for that migration +
 * the structural validator.
 */
export interface VaultRecord {
  /** Schema version, for forward migration. */
  version: number;
  /** mainnet-vs-testnet binding for this vault. */
  chain: VaultChain;
  /** The wallet's primary bech32m (P2TR) receive address, derived locally. */
  address: string;
  /** Compressed secp256k1 / x-only public key hex. Public; optional for watch-only edge cases. */
  publicKeyHex?: string;
  /** How to interpret the decrypted secret. */
  secretKind: SecretKind;
  /** Whether this vault can sign (false for watch-only). */
  watchOnly: boolean;
  /** KDF parameters used to derive the AES key from the passphrase. */
  kdfParams: KdfParams;
  /** The encrypted secret payload. */
  payload: EncryptedPayload;
  /**
   * XMSS commitment metadata, present on full-key vaults. The OTS index here is
   * sealed in the MVP (never advanced, never signed). See `XmssCommitmentState`.
   */
  xmss?: XmssCommitmentState;
  /** Epoch millis the vault was created. */
  createdAt: number;
  /** Epoch millis the vault was last mutated (re-encrypt / password change). */
  updatedAt: number;
}

/**
 * A single account inside a {@link VaultFile}.
 *
 * Structurally this is the v1 {@link VaultRecord} MINUS its per-record
 * `kdfParams` (the KDF is now wallet-level, shared by every account) PLUS a
 * stable `id` and a human `label`. Its `payload` is AES-256-GCM ciphertext under
 * the SINGLE wallet key derived from the file's `kdfParams`, with its own random
 * IV. The only secret in this object is inside `payload.ciphertextB64`.
 */
export interface VaultAccount {
  /** Stable opaque id (crypto.randomUUID). Never reused after removal. */
  id: string;
  /** Human-facing label, e.g. "Account 1". User-editable. */
  label: string;
  /** mainnet-vs-testnet binding for this account. */
  chain: VaultChain;
  /** The account's primary bech32m (P2TR) receive address, derived locally. */
  address: string;
  /** Compressed secp256k1 / x-only public key hex. Public; optional for watch-only edge cases. */
  publicKeyHex?: string;
  /** How to interpret the decrypted secret. */
  secretKind: SecretKind;
  /** Whether this account can sign (false for watch-only). */
  watchOnly: boolean;
  /**
   * The encrypted secret payload, under the wallet-level key. Each account keeps
   * its own fresh random IV; the key is shared across all accounts.
   */
  payload: EncryptedPayload;
  /**
   * XMSS commitment metadata, present on full-key accounts. The OTS index here is
   * sealed in the MVP (never advanced, never signed). See `XmssCommitmentState`.
   */
  xmss?: XmssCommitmentState;
  /** Epoch millis the account was created. */
  createdAt: number;
  /** Epoch millis the account was last mutated (re-encrypt / password change / rename). */
  updatedAt: number;
}

/**
 * The persisted, encrypted vault FILE (v2 — multi-account).
 *
 * One wallet-level {@link KdfParams} (a single salt) is shared by every account:
 * the single password derives ONE AES-256-GCM key (PBKDF2 600k) that
 * encrypts/decrypts EVERY account's `payload`. So unlock = 1 KDF + N AES-GCM
 * decrypts (NOT N KDFs), and switching accounts needs no re-prompt.
 *
 * Safe to write to `chrome.storage.local`: the only secrets are inside each
 * account's `payload.ciphertextB64` (AES-256-GCM ciphertext). `activeAccountId`
 * MUST reference an existing account id; there is always at least one account.
 */
export interface VaultFile {
  /** Schema version. Always 2 for this shape. */
  version: 2;
  /** id of the currently-active account (must match one of `accounts`). */
  activeAccountId: string;
  /**
   * Wallet-level KDF parameters (single salt). One derived key decrypts every
   * account payload. None of these are secret.
   */
  kdfParams: KdfParams;
  /** All accounts in the wallet. Invariant: length >= 1. */
  accounts: VaultAccount[];
}

/**
 * The decrypted secret, as it exists transiently in memory after unlock.
 * NEVER persisted in this shape; NEVER logged.
 */
export type DecryptedSecret =
  | {
      kind: "secp256k1-privkey";
      /** 32-byte secp256k1 private key, hex (lowercase, 64 chars). */
      privateKeyHex: string;
    }
  | {
      kind: "bip39-mnemonic";
      /** BIP-39 mnemonic words. */
      mnemonic: string;
      /** Optional BIP-39 passphrase ("25th word"). */
      passphrase?: string;
    }
  | {
      kind: "watch-only-xpub";
      /** Account-level extended public key. No spend capability. */
      xpub: string;
    };

/** The legacy v1 single-account schema version (migrated away from on load). */
export const VAULT_SCHEMA_VERSION = 1 as const;

/** The current multi-account schema version written by this build. */
export const VAULT_FILE_VERSION = 2 as const;

/** XMSS scheme constants (mirrors Pearl's XMSS-SHAKE256_5_256). */
export const XMSS_SCHEME = "XMSS-SHAKE256_5_256" as const;
export const XMSS_MAX_SIGNATURES = 32 as const;
