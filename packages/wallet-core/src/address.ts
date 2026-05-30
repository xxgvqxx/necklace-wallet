/**
 * Pearl (PRL) address encoding/decoding — bech32m (BIP-350), Taproot-only.
 *
 * Phase 1 findings (node/btcutil/address.go, address_test.go,
 * node/chaincfg/params.go Bech32HRPSegwit):
 *   - Witness-based bech32m only. NO base58 addresses.
 *   - HRP per network: mainnet `prl`, testnet/testnet2/signet `tprl`,
 *     regtest/simnet `rprl`.
 *   - Witness version 1 = P2TR (Taproot), version 2 = P2MR (BIP-360).
 *   - Witness program is ALWAYS 32 bytes.
 *   - Legacy bech32 v0 (P2WPKH/P2WSH) is explicitly REJECTED:
 *     encodeSegWitAddress requires version >= 1 and bech32m.
 *
 * The MVP signs witness v1 (P2TR) only. v2 (P2MR) decodes for completeness but
 * is out of scope for signing.
 *
 * No hand-rolled crypto: bech32m comes from @scure/base, the secp256k1 / BIP-340
 * tweak from @noble/curves, all pinned to the repo's real KATs in
 * ../fixtures/derived-address.json.
 */

import { bech32m } from "@scure/base";
import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import {
  HRP_BY_NETWORK,
  type Bech32mAddress,
  type DerivedAddress,
  type Network,
  type WitnessVersion,
} from "@necklace/shared";

/** Pearl witness program length, in bytes. Always 32 (BIP-341 x-only key / merkle root). */
export const WITNESS_PROGRAM_LEN = 32;

/** Witness versions Pearl can encode. v1 = P2TR (signable), v2 = P2MR (decode only). */
const SUPPORTED_WITNESS_VERSIONS: readonly WitnessVersion[] = [1, 2];

/** Thrown when an address fails to parse or violates a Pearl encoding rule. */
export class AddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AddressError";
  }
}

/** A decoded Pearl segwit address. */
export interface DecodedAddress {
  network: Network;
  hrp: string;
  witnessVersion: WitnessVersion;
  /** Witness program bytes (always 32 for Pearl). */
  program: Uint8Array;
  /** scriptPubKey: OP_<version> PUSH(program). For v1, `0x51 0x20 <32 bytes>`. */
  scriptPubKey: Uint8Array;
}

/** Resolve a network from a bech32m HRP. Returns undefined if unknown. */
function networkForHrp(hrp: string): Network | undefined {
  // Multiple networks share an HRP (testnet family -> tprl, regtest/simnet -> rprl).
  // We resolve to a canonical representative; callers needing the precise network
  // should pass it explicitly to deriveAddress/validateAddress.
  switch (hrp) {
    case "prl":
      return "mainnet";
    case "tprl":
      return "testnet";
    case "rprl":
      return "regtest";
    default:
      return undefined;
  }
}

/**
 * Encode a witness program as a Pearl bech32m address.
 *
 * Mirrors encodeSegWitAddress: the first 5-bit word is the witness version,
 * followed by the program converted 8->5 bits, encoded with bech32m (BIP-350).
 * Rejects witness version 0 and any program length other than 32 bytes.
 */
export function encodeAddress(
  network: Network,
  witnessVersion: WitnessVersion,
  program: Uint8Array,
): Bech32mAddress {
  if (!SUPPORTED_WITNESS_VERSIONS.includes(witnessVersion)) {
    throw new AddressError(
      `unsupported witness version ${witnessVersion}; Pearl supports v1 (P2TR) and v2 (P2MR), v0 is rejected`,
    );
  }
  if (program.length !== WITNESS_PROGRAM_LEN) {
    throw new AddressError(
      `witness program must be ${WITNESS_PROGRAM_LEN} bytes, got ${program.length}`,
    );
  }
  const hrp = HRP_BY_NETWORK[network];
  const words = [witnessVersion, ...bech32m.toWords(program)];
  // bech32m default length limit is 90 chars; Pearl addresses fit, but pass an
  // explicit generous limit so future longer HRPs never silently fail.
  return bech32m.encode(hrp, words, 128);
}

/**
 * Decode and validate a Pearl bech32m address.
 *
 * Enforces every rule from address.go:
 *   - valid bech32m checksum,
 *   - known Pearl HRP,
 *   - witness version >= 1 (v0 rejected — Pearl is bech32m-only),
 *   - witness program exactly 32 bytes.
 *
 * @throws AddressError on any violation.
 */
export function decodeAddress(address: string): DecodedAddress {
  // Reject mixed case up front (bech32 spec); @scure also enforces this.
  if (address !== address.toLowerCase() && address !== address.toUpperCase()) {
    throw new AddressError("mixed-case address is invalid");
  }
  const lower = address.toLowerCase();

  let decoded;
  try {
    decoded = bech32m.decode(lower as `${string}1${string}`, 128);
  } catch (err) {
    throw new AddressError(
      `invalid bech32m address: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const { prefix: hrp, words } = decoded;
  const network = networkForHrp(hrp);
  if (network === undefined) {
    throw new AddressError(`unknown Pearl HRP "${hrp}"`);
  }

  if (words.length === 0) {
    throw new AddressError("empty witness data");
  }
  const witnessVersion = words[0] as number;

  // Pearl REJECTS witness version 0 (legacy bech32 P2WPKH/P2WSH). Only v1+/bech32m.
  if (witnessVersion === 0) {
    throw new AddressError(
      "witness version 0 is not supported; Pearl requires bech32m v1+ (Taproot)",
    );
  }
  if (witnessVersion < 1 || witnessVersion > 16) {
    throw new AddressError(`invalid witness version ${witnessVersion}`);
  }
  if (!SUPPORTED_WITNESS_VERSIONS.includes(witnessVersion as WitnessVersion)) {
    throw new AddressError(
      `unsupported witness version ${witnessVersion}; MVP handles v1 (P2TR) and v2 (P2MR)`,
    );
  }

  let program: Uint8Array;
  try {
    program = bech32m.fromWords(words.slice(1));
  } catch (err) {
    throw new AddressError(
      `invalid witness program encoding: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (program.length !== WITNESS_PROGRAM_LEN) {
    throw new AddressError(
      `witness program must be ${WITNESS_PROGRAM_LEN} bytes for v${witnessVersion}, got ${program.length}`,
    );
  }

  return {
    network,
    hrp,
    witnessVersion: witnessVersion as WitnessVersion,
    program,
    scriptPubKey: programToScriptPubKey(witnessVersion as WitnessVersion, program),
  };
}

/**
 * Validate an address string. Optionally assert it belongs to `expectedNetwork`.
 * Returns true only for an address Pearl would accept; never throws.
 */
export function validateAddress(
  address: string,
  expectedNetwork?: Network,
): boolean {
  try {
    const decoded = decodeAddress(address);
    if (expectedNetwork !== undefined) {
      // Compare by HRP family so testnet2/signet (tprl) and simnet (rprl) match.
      if (HRP_BY_NETWORK[expectedNetwork] !== decoded.hrp) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Build a segwit scriptPubKey from a witness version + program.
 * For v1: `OP_1 (0x51) || PUSH32 (0x20) || program`.
 * Witness-version opcodes: v1..v16 -> 0x50 + version. Pearl never emits v0,
 * so this helper only accepts the supported v1/v2 union.
 */
export function programToScriptPubKey(
  witnessVersion: WitnessVersion,
  program: Uint8Array,
): Uint8Array {
  const versionOpcode = 0x50 + witnessVersion;
  const out = new Uint8Array(2 + program.length);
  out[0] = versionOpcode;
  out[1] = program.length; // direct push for 1..75 bytes
  out.set(program, 2);
  return out;
}

/**
 * BIP-341 TapTweak of an x-only internal key with an (optional) tapscript root.
 * Returns `{ outputKey (x-only 32B), parity }` where parity is the y-parity of
 * the tweaked output point (needed if you later need the control block).
 *
 * Matches Pearl's ComputeTaprootOutputKey / TweakTaprootPrivKey
 * (node/txscript/taproot.go): tweak = H_TapTweak(internalKey || merkleRoot),
 * Q = P + tweak*G; the witness program is Q.x.
 */
export function tapTweakOutputKey(
  internalXOnly: Uint8Array,
  tapscriptRoot?: Uint8Array | null,
): { outputKey: Uint8Array; parity: 0 | 1 } {
  if (internalXOnly.length !== 32) {
    throw new AddressError("internal key must be a 32-byte x-only key");
  }
  const root = tapscriptRoot ?? new Uint8Array(0);
  const tweak = schnorr.utils.taggedHash("TapTweak", internalXOnly, root);
  const tweakScalar = bytesToBigInt(tweak) % secp256k1.Point.Fn.ORDER;

  // P is the even-Y lift of the x-only internal key (BIP-340 lift_x).
  const P = schnorr.utils.lift_x(bytesToBigInt(internalXOnly));
  const Q = P.add(secp256k1.Point.BASE.multiply(tweakScalar));
  const aff = Q.toAffine();
  const outputKey = bigIntTo32Bytes(aff.x);
  const parity: 0 | 1 = (aff.y & 1n) === 1n ? 1 : 0;
  return { outputKey, parity };
}

/**
 * Derive a P2TR (witness v1) address for a given network from a 32-byte secp256k1
 * private key, performing the standard BIP-86 key tweak (no tapscript).
 *
 * This is the address the wallet receives funds at. The XMSS commitment scope
 * (purpose 222) is NOT applied here — that is deferred and would supply a
 * tapscriptRoot; see protocol-findings.md.
 */
export function deriveAddress(
  privateKey: Uint8Array,
  network: Network,
  tapscriptRoot?: Uint8Array | null,
): DerivedAddress {
  if (privateKey.length !== 32) {
    throw new AddressError("private key must be 32 bytes");
  }
  // Internal key = x-only of the secp256k1 pubkey (BIP-340 / BIP-86).
  const internalXOnly = schnorr.getPublicKey(privateKey);
  const { outputKey } = tapTweakOutputKey(internalXOnly, tapscriptRoot);
  const address = encodeAddress(network, 1, outputKey);
  return {
    network,
    address,
    witnessVersion: 1,
    witnessProgramHex: bytesToHex(outputKey),
    path: undefined,
  };
}

/**
 * Derive a P2TR address directly from a 32-byte x-only internal public key
 * (watch-only / xpub flows). Applies the same BIP-86 tweak as deriveAddress.
 */
export function deriveAddressFromXOnly(
  internalXOnly: Uint8Array,
  network: Network,
  tapscriptRoot?: Uint8Array | null,
): DerivedAddress {
  const { outputKey } = tapTweakOutputKey(internalXOnly, tapscriptRoot);
  return {
    network,
    address: encodeAddress(network, 1, outputKey),
    witnessVersion: 1,
    witnessProgramHex: bytesToHex(outputKey),
    path: undefined,
  };
}

// --- small byte helpers (kept local to avoid a util dependency cycle) ---

function bytesToBigInt(b: Uint8Array): bigint {
  let n = 0n;
  for (const byte of b) n = (n << 8n) | BigInt(byte);
  return n;
}

function bigIntTo32Bytes(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const byte of b) s += byte.toString(16).padStart(2, "0");
  return s;
}
