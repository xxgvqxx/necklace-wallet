/**
 * BIP-39 -> BIP-32 -> BIP-86 hierarchical-deterministic derivation for Necklace.
 *
 * The MVP needs three HD capabilities the lower-level `keys.ts` / `address.ts`
 * do not provide on their own:
 *   - generate a fresh mnemonic and derive its first receive key (CREATE_WALLET);
 *   - import a BIP-39 mnemonic and derive the same key (IMPORT_WALLET mnemonic);
 *   - import an account xpub and derive a watch-only child key (watch-only).
 *
 * All of this is the standard BIP-86 Taproot single-key path
 * `m/86'/coin'/account'/change/index`, where `coin` is Pearl's per-network
 * BIP-44 coin type (mainnet 808276, all testnets 1; see
 * BIP86_COIN_TYPE_BY_NETWORK). The receive key is the BIP-86 *internal* key; the
 * P2TR address applies the BIP-86 TapTweak (empty tapscript root) in
 * `address.ts` — verified against Oyster (STEP 0: plain BIP-86, no commitment
 * tweak on the receive address).
 *
 * No hand-rolled crypto: BIP-39 (PBKDF2 seed) and BIP-32 (HMAC-SHA512 CKD) come
 * from the audited @scure/bip39 + @scure/bip32; the Taproot tweak + bech32m come
 * from address.ts (@noble/curves + @scure/base). Pinned to BIP-86 known-answer
 * vectors in tests/hd.test.ts (the canonical "abandon … about" mnemonic).
 *
 * XMSS / m/222' is NEVER derived or signed here (protocol-findings.md).
 */

import { HDKey } from "@scure/bip32";
import {
  mnemonicToSeedSync,
  validateMnemonic,
  generateMnemonic as scureGenerateMnemonic,
} from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
  BIP86_COIN_TYPE_BY_NETWORK,
  type DerivedAddress,
  type Network,
} from "@necklace/shared";
import { deriveAddress, deriveAddressFromXOnly } from "./address.js";

/** BIP-86 purpose (Taproot single-key). */
export const BIP86_PURPOSE = 86;

/** Thrown when HD derivation input is invalid. */
export class HdError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HdError";
  }
}

/** A node in the BIP-86 tree below the account level. */
export interface Bip86ChildPath {
  /** Account index (hardened). Default 0. */
  account?: number;
  /** Change branch: 0 = external/receive, 1 = internal/change. Default 0. */
  change?: 0 | 1;
  /** Address index. Default 0 (the single MVP receive address). */
  index?: number;
}

/** Build the full BIP-86 derivation path string for a network + child path. */
export function bip86Path(network: Network, child: Bip86ChildPath = {}): string {
  const coin = BIP86_COIN_TYPE_BY_NETWORK[network];
  const account = child.account ?? 0;
  const change = child.change ?? 0;
  const index = child.index ?? 0;
  return `m/${BIP86_PURPOSE}'/${coin}'/${account}'/${change}/${index}`;
}

/** Generate a fresh BIP-39 mnemonic. 12 words (128 bits) or 24 (256 bits). */
export function generateMnemonic(wordCount: 12 | 24 = 12): string {
  const strength = wordCount === 24 ? 256 : 128;
  return scureGenerateMnemonic(wordlist, strength);
}

/** Validate a BIP-39 mnemonic (wordlist + checksum). */
export function isValidMnemonic(mnemonic: string): boolean {
  return validateMnemonic(mnemonic.trim(), wordlist);
}

/** Master HDKey from a mnemonic + optional BIP-39 passphrase. */
function masterFromMnemonic(mnemonic: string, passphrase?: string): HDKey {
  const trimmed = mnemonic.trim();
  if (!validateMnemonic(trimmed, wordlist)) {
    throw new HdError("invalid BIP-39 mnemonic (bad word or checksum)");
  }
  const seed = mnemonicToSeedSync(trimmed, passphrase ?? "");
  return HDKey.fromMasterSeed(seed);
}

/** Result of deriving a BIP-86 receive key from a mnemonic. */
export interface DerivedHdKey {
  /** 32-byte secp256k1 private key controlling the address (untweaked). */
  privateKey: Uint8Array;
  /** 33-byte compressed public key. */
  publicKeyCompressed: Uint8Array;
  /** 32-byte x-only internal public key (BIP-340 / BIP-86). */
  xOnlyPublicKey: Uint8Array;
  /** The BIP-86 derivation path used. */
  path: string;
}

/**
 * Derive the BIP-86 receive private key for a mnemonic on a given network.
 *
 * Returns the *untweaked* controlling key; pass `privateKey` to
 * `deriveAddress`/`signTransaction`, which apply the BIP-86 TapTweak.
 */
export function deriveBip86KeyFromMnemonic(
  mnemonic: string,
  network: Network,
  child: Bip86ChildPath = {},
  passphrase?: string,
): DerivedHdKey {
  const master = masterFromMnemonic(mnemonic, passphrase);
  const path = bip86Path(network, child);
  const node = master.derive(path);
  if (!node.privateKey || !node.publicKey) {
    throw new HdError("derived HD node has no private key");
  }
  return {
    privateKey: node.privateKey,
    publicKeyCompressed: node.publicKey,
    xOnlyPublicKey: node.publicKey.slice(1),
    path,
  };
}

/**
 * Derive the BIP-86 P2TR receive address for a mnemonic on a network. Records
 * the derivation path on the returned `DerivedAddress`.
 */
export function deriveBip86AddressFromMnemonic(
  mnemonic: string,
  network: Network,
  child: Bip86ChildPath = {},
  passphrase?: string,
): DerivedAddress {
  const key = deriveBip86KeyFromMnemonic(mnemonic, network, child, passphrase);
  const addr = deriveAddress(key.privateKey, network);
  return { ...addr, path: key.path };
}

/**
 * Parse an account-level extended PUBLIC key (xpub) into an HDKey.
 *
 * Pearl uses non-standard HD version bytes (testnet/regtest `vpub` 0x045f1cf6,
 * mainnet `zpub` 0x04b24746; protocol-findings.md §8). @scure/bip32 validates
 * the 4-byte version prefix, so we accept any version by overriding it — the
 * security of a watch-only xpub does not depend on the version tag, only on the
 * chain code + public point it carries.
 */
function accountKeyFromXpub(xpub: string): HDKey {
  const trimmed = xpub.trim();
  // Read the actual version bytes from the key and feed them back so the
  // prefix check passes for Pearl's (and Bitcoin's) version tags alike.
  let version: number;
  try {
    version = readXpubVersion(trimmed);
  } catch (err) {
    throw new HdError(
      `invalid extended public key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  let node: HDKey;
  try {
    node = HDKey.fromExtendedKey(trimmed, {
      // Only the public version is exercised for an xpub; mirror it for private
      // so the Versions object is well-formed.
      private: version,
      public: version,
    });
  } catch (err) {
    throw new HdError(
      `invalid extended public key: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (node.privateKey) {
    throw new HdError("expected a public extended key (xpub), got a private one");
  }
  return node;
}

/** Read the 4-byte version prefix from a base58check-encoded extended key. */
function readXpubVersion(xpub: string): number {
  const raw = base58checkDecode(xpub);
  if (raw.length < 4) throw new Error("too short");
  return ((raw[0] as number) << 24) |
    ((raw[1] as number) << 16) |
    ((raw[2] as number) << 8) |
    (raw[3] as number);
}

/**
 * Derive a watch-only BIP-86 child address from an account-level xpub.
 *
 * The xpub is the account node (`m/86'/coin'/account'`); we derive the
 * non-hardened `change/index` child publicly (no private key required) and
 * encode its x-only key as a P2TR address.
 */
export function deriveBip86AddressFromXpub(
  xpub: string,
  network: Network,
  child: Pick<Bip86ChildPath, "change" | "index"> = {},
): DerivedAddress {
  const account = accountKeyFromXpub(xpub);
  const change = child.change ?? 0;
  const index = child.index ?? 0;
  const node = account.deriveChild(change).deriveChild(index);
  if (!node.publicKey) {
    throw new HdError("derived watch-only node has no public key");
  }
  const xOnly = node.publicKey.slice(1);
  const addr = deriveAddressFromXOnly(xOnly, network);
  return { ...addr, path: `account/${change}/${index}` };
}

// --- base58check decode (local; mirrors keys.ts dependency on @scure/base) ---

import { base58 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";

function base58checkDecode(s: string): Uint8Array {
  const raw = base58.decode(s);
  if (raw.length < 4) throw new Error("too short for checksum");
  const body = raw.slice(0, raw.length - 4);
  const checksum = raw.slice(raw.length - 4);
  const want = sha256(sha256(body)).slice(0, 4);
  for (let i = 0; i < 4; i++) {
    if (checksum[i] !== want[i]) throw new Error("bad checksum");
  }
  return body;
}
