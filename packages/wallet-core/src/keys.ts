/**
 * Private-key import for Necklace.
 *
 * Phase 1 key formats (node/btcutil/wif.go DecodeWIF, wif_test.go,
 * node/chaincfg/params.go PrivateKeyID):
 *
 *   WIF (base58check, btcutil-standard):
 *     [1 netID byte][32-byte big-endian secp256k1 priv]
 *     [optional 0x01 compress magic][4-byte double-SHA256 checksum]
 *   netID: 0x80 mainnet, 0xef testnet/regtest/signet, 0x64 simnet.
 *   Compressed and uncompressed both decode. Bitcoin-format WIFs round-trip
 *   unchanged (Pearl reuses Bitcoin PrivateKeyID bytes); the network is
 *   identified by the leading netID byte, NOT the bech32 HRP.
 *
 *   Raw 32-byte hex private key — a convenience format; converted client-side.
 *
 * XMSS key material is NEVER imported — it is always derived from the HD key
 * via HKDF (protocol-findings.md). This module only handles the secp256k1
 * Schnorr/Taproot key path.
 *
 * No hand-rolled crypto: base58check + double-SHA256 checksum come from
 * @scure/base + @noble/hashes; pinned to ../fixtures/import-key.json.
 */

import { base58 } from "@scure/base";
import { sha256 } from "@noble/hashes/sha2.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { WIF_NETID_BY_NETWORK, type Network } from "@necklace/shared";

/** btcec.PrivKeyBytesLen — secp256k1 private keys are 32 bytes. */
const PRIV_KEY_LEN = 32;
/** Magic byte appended for compressed-pubkey WIFs (wif.go compressMagic). */
const COMPRESS_MAGIC = 0x01;

/** double-SHA256, the Bitcoin/btcd checksum hash (chainhash.DoubleHashB). */
function doubleSha256(b: Uint8Array): Uint8Array {
  return sha256(sha256(b));
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * Error names mirror Pearl's btcutil sentinel errors so callers (and the
 * fixture tests) can assert the exact failure mode.
 */
export type WifErrorName = "ErrMalformedPrivateKey" | "ErrChecksumMismatch";

/** Thrown when a WIF / raw key fails to decode. `code` matches btcutil's sentinel. */
export class KeyImportError extends Error {
  readonly code: WifErrorName | "ErrInvalidHex" | "ErrInvalidKeyRange";
  constructor(
    code: WifErrorName | "ErrInvalidHex" | "ErrInvalidKeyRange",
    message: string,
  ) {
    super(message);
    this.name = "KeyImportError";
    this.code = code;
  }
}

/** A decoded private key plus its WIF-derived metadata. */
export interface ImportedKey {
  /** 32-byte big-endian secp256k1 private key. */
  privateKey: Uint8Array;
  /** True if the WIF requested the compressed pubkey form. Always true for raw hex. */
  compressed: boolean;
  /** netID byte from the WIF, if imported from WIF (0x80/0xef/0x64). */
  netID?: number;
  /**
   * Networks consistent with the netID byte. A netID can map to several Pearl
   * networks (0xef -> testnet/testnet2/regtest/signet); the caller's selected
   * network must be one of these.
   */
  networks: Network[];
  /** 33-byte compressed secp256k1 public key. */
  publicKeyCompressed: Uint8Array;
  /** 65-byte uncompressed secp256k1 public key. */
  publicKeyUncompressed: Uint8Array;
  /** 32-byte x-only public key (BIP-340 internal key for Taproot). */
  xOnlyPublicKey: Uint8Array;
}

/** Map a WIF netID byte back to the Pearl networks that use it. */
function networksForNetID(netID: number): Network[] {
  const matches: Network[] = [];
  for (const [network, id] of Object.entries(WIF_NETID_BY_NETWORK)) {
    if (id === netID) matches.push(network as Network);
  }
  return matches;
}

/** Reject keys that are zero or >= curve order (invalid secp256k1 scalars). */
function assertValidScalar(priv: Uint8Array): void {
  if (!secp256k1.utils.isValidSecretKey(priv)) {
    throw new KeyImportError(
      "ErrInvalidKeyRange",
      "private key is not a valid secp256k1 scalar (zero or >= curve order)",
    );
  }
}

/** Build the public-key views once a 32-byte scalar is validated. */
function publicKeysFor(privateKey: Uint8Array): {
  publicKeyCompressed: Uint8Array;
  publicKeyUncompressed: Uint8Array;
  xOnlyPublicKey: Uint8Array;
} {
  const publicKeyCompressed = secp256k1.getPublicKey(privateKey, true);
  const publicKeyUncompressed = secp256k1.getPublicKey(privateKey, false);
  // x-only = compressed pubkey without the 0x02/0x03 parity prefix.
  const xOnlyPublicKey = publicKeyCompressed.slice(1);
  return { publicKeyCompressed, publicKeyUncompressed, xOnlyPublicKey };
}

/**
 * Decode a WIF (Wallet Import Format) private key.
 *
 * Exact port of btcutil DecodeWIF (wif.go):
 *   - base58check decode (rejects bad checksum -> ErrChecksumMismatch),
 *   - length must be 1+32+4 (uncompressed) or 1+32+1+4 (compressed),
 *   - in the compressed case byte[33] MUST equal 0x01 -> else ErrMalformedPrivateKey,
 *   - netID = byte[0]; privKey = byte[1..33].
 *
 * @throws KeyImportError with code ErrMalformedPrivateKey / ErrChecksumMismatch.
 */
export function decodeWif(wif: string): ImportedKey {
  // Port of DecodeWIF: base58.Decode first (NO checksum stripping), then the
  // length switch, then the checksum verification, in that exact order — so the
  // error modes (ErrMalformedPrivateKey vs ErrChecksumMismatch) match btcutil.
  let decoded: Uint8Array;
  try {
    decoded = base58.decode(wif);
  } catch {
    // Non-base58 input. btcutil's base58.Decode returns empty bytes for bad
    // input, which then fails the length switch as ErrMalformedPrivateKey.
    throw new KeyImportError("ErrMalformedPrivateKey", "malformed private key");
  }

  const decodedLen = decoded.length;
  let compress: boolean;
  // Length must be 1(netID) + 32(priv) + 4(checksum), optionally + 1 (compress).
  if (decodedLen === 1 + PRIV_KEY_LEN + 1 + 4) {
    // compressed: [netID][32][0x01][4-byte checksum]
    if (decoded[1 + PRIV_KEY_LEN] !== COMPRESS_MAGIC) {
      throw new KeyImportError(
        "ErrMalformedPrivateKey",
        "malformed private key: bad compress magic",
      );
    }
    compress = true;
  } else if (decodedLen === 1 + PRIV_KEY_LEN + 4) {
    // uncompressed: [netID][32][4-byte checksum]
    compress = false;
  } else {
    throw new KeyImportError(
      "ErrMalformedPrivateKey",
      `malformed private key: unexpected length ${decodedLen}`,
    );
  }

  // Checksum = first 4 bytes of double-SHA256 over everything except the last 4.
  const tosumEnd = compress ? 1 + PRIV_KEY_LEN + 1 : 1 + PRIV_KEY_LEN;
  const tosum = decoded.slice(0, tosumEnd);
  const want = doubleSha256(tosum).slice(0, 4);
  const have = decoded.slice(decodedLen - 4);
  if (!bytesEqual(want, have)) {
    throw new KeyImportError("ErrChecksumMismatch", "checksum mismatch");
  }

  const netID = decoded[0] as number;
  const privateKey = decoded.slice(1, 1 + PRIV_KEY_LEN);
  assertValidScalar(privateKey);

  return {
    privateKey,
    compressed: compress,
    netID,
    networks: networksForNetID(netID),
    ...publicKeysFor(privateKey),
  };
}

/**
 * Import a raw 32-byte hex private key (convenience format). The result is
 * treated as compressed (Taproot uses x-only keys regardless). No network is
 * implied by a raw key, so `networks` is empty — the caller selects the network.
 *
 * @throws KeyImportError code ErrInvalidHex / ErrInvalidKeyRange.
 */
export function importRawHex(hex: string): ImportedKey {
  const clean = hex.trim().toLowerCase().replace(/^0x/, "");
  if (clean.length !== PRIV_KEY_LEN * 2 || !/^[0-9a-f]+$/.test(clean)) {
    throw new KeyImportError(
      "ErrInvalidHex",
      "raw private key must be 64 hex characters (32 bytes)",
    );
  }
  const privateKey = new Uint8Array(PRIV_KEY_LEN);
  for (let i = 0; i < PRIV_KEY_LEN; i++) {
    privateKey[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  assertValidScalar(privateKey);
  return {
    privateKey,
    compressed: true,
    netID: undefined,
    networks: [],
    ...publicKeysFor(privateKey),
  };
}

/**
 * Import a private key in either WIF or raw-hex form. Auto-detects: a 64-char
 * hex string is treated as raw hex, anything else as WIF.
 *
 * This is the single entry point the extension uses on the import screen.
 */
export function importPrivateKey(input: string): ImportedKey {
  const trimmed = input.trim();
  const hexCandidate = trimmed.toLowerCase().replace(/^0x/, "");
  if (hexCandidate.length === PRIV_KEY_LEN * 2 && /^[0-9a-f]+$/.test(hexCandidate)) {
    return importRawHex(trimmed);
  }
  return decodeWif(trimmed);
}
