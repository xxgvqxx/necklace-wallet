/**
 * BIP-340 Schnorr signing over the Taproot key-path — the ONLY signing path in
 * the Necklace MVP (Phase 1).
 *
 *   - Scheme: BIP-340 Schnorr over secp256k1, Taproot key-path spend,
 *     SigHashDefault (BIP-341 sighash). NO cgo, NO XMSS.
 *   - Per input: tweak the secp256k1 private key by H_TapTweak(internalKey ||
 *     merkleRoot) (BIP-341 / BIP-86), compute the BIP-341 sighash, Schnorr-sign,
 *     set Witness = [ 64-byte sig ]. With SigHashDefault no sighash byte is
 *     appended (64-byte witness item).
 *   - prevout values + scripts of ALL inputs are committed in the sighash and
 *     MUST be supplied (Phase 1 critical constraint).
 *
 * Sources: wallet/wallet/signer.go (ComputeInputScript), txauthor/author.go
 * (spendTaprootKey), node/txscript/sign.go (RawTxInTaprootSignature),
 * node/txscript/sighash.go (calcTaprootSignatureHashRaw),
 * node/txscript/taproot.go (TweakTaprootPrivKey).
 *
 * No hand-rolled crypto: Schnorr + secp256k1 + tagged hashes come from
 * @noble/curves; the BIP-341 sighash is assembled here from sha256 midstates and
 * is cross-checked byte-for-byte against @scure/btc-signer's preimageWitnessV1
 * in the fixture tests.
 */

import { schnorr, secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { SigningInput } from "./transaction.js";
import type { WireTx } from "./serialize.js";
import { hexToBytes, reverseBytes } from "./serialize.js";

/** BIP-341 SigHashDefault. */
export const SIGHASH_DEFAULT = 0x00;

/** Thrown on signing failures. */
export class SignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignError";
  }
}

const CURVE_ORDER = secp256k1.Point.Fn.ORDER;

function bytesToBigInt(b: Uint8Array): bigint {
  let n = 0n;
  for (const x of b) n = (n << 8n) | BigInt(x);
  return n;
}

function bigIntTo32(n: bigint): Uint8Array {
  const out = new Uint8Array(32);
  let v = n;
  for (let i = 31; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function concat(...arrs: Uint8Array[]): Uint8Array {
  const len = arrs.reduce((a, x) => a + x.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrs) {
    out.set(a, off);
    off += a.length;
  }
  return out;
}

function u32le(n: number): Uint8Array {
  const out = new Uint8Array(4);
  out[0] = n & 0xff;
  out[1] = (n >>> 8) & 0xff;
  out[2] = (n >>> 16) & 0xff;
  out[3] = (n >>> 24) & 0xff;
  return out;
}

function u64le(n: bigint): Uint8Array {
  const out = new Uint8Array(8);
  let v = BigInt.asUintN(64, n);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

function varInt(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return concat(Uint8Array.of(0xfd), u32le(n).slice(0, 2));
  if (n <= 0xffffffff) return concat(Uint8Array.of(0xfe), u32le(n));
  return concat(Uint8Array.of(0xff), u64le(BigInt(n)));
}

/** Serialize an outpoint: 32-byte LE txid || 4-byte LE index. */
function serializeOutpoint(txid: string, vout: number): Uint8Array {
  return concat(reverseBytes(hexToBytes(txid)), u32le(vout));
}

/** Serialize a txout: 8-byte LE value || varint scriptlen || script. */
function serializeTxOut(value: bigint, script: Uint8Array): Uint8Array {
  return concat(u64le(value), varInt(script.length), script);
}

/**
 * Apply the BIP-341 / BIP-86 Taproot private-key tweak:
 *   - if the internal pubkey has odd Y, negate the private scalar;
 *   - tweak = H_TapTweak(x-only-internal || merkleRoot) mod N;
 *   - return (d' + tweak) mod N as a 32-byte scalar.
 *
 * Port of txscript.TweakTaprootPrivKey. `merkleRoot` empty/undefined = BIP-86.
 */
export function tweakTaprootPrivKey(
  privateKey: Uint8Array,
  merkleRoot?: Uint8Array | null,
): Uint8Array {
  if (privateKey.length !== 32) {
    throw new SignError("private key must be 32 bytes");
  }
  let d = bytesToBigInt(privateKey) % CURVE_ORDER;
  if (d === 0n) throw new SignError("invalid (zero) private key");

  // Even-Y normalization: if P=d*G has odd Y, use N-d.
  const pub = secp256k1.getPublicKey(privateKey, true); // compressed
  if (pub[0] === 0x03) {
    d = CURVE_ORDER - d;
  }

  const xOnly = pub.slice(1); // 32-byte x-only internal key
  const root = merkleRoot ?? new Uint8Array(0);
  const t = bytesToBigInt(schnorr.utils.taggedHash("TapTweak", xOnly, root)) % CURVE_ORDER;

  const tweaked = (d + t) % CURVE_ORDER;
  if (tweaked === 0n) throw new SignError("tweaked private key is zero");
  return bigIntTo32(tweaked);
}

/**
 * Compute the BIP-341 taproot key-path sighash for input `idx` of `tx`,
 * with SigHashDefault and no annex (ext_flag 0). Port of
 * calcTaprootSignatureHashRaw for the key-path / SIGHASH_DEFAULT case.
 *
 * @param prevValues  prevout value (Grain) of EVERY input, index-aligned
 * @param prevScripts prevout scriptPubKey of EVERY input, index-aligned
 */
export function taprootKeySpendSighash(
  tx: WireTx,
  idx: number,
  prevValues: readonly bigint[],
  prevScripts: readonly Uint8Array[],
): Uint8Array {
  const nIn = tx.inputs.length;
  if (idx < 0 || idx >= nIn) throw new SignError(`input index ${idx} out of range`);
  if (prevValues.length !== nIn || prevScripts.length !== nIn) {
    throw new SignError("prevValues/prevScripts must cover every input");
  }

  // Precompute the V1 midstate digests (single SHA256 each, BIP-341).
  const hashPrevouts = sha256(
    concat(...tx.inputs.map((i) => serializeOutpoint(i.txid, i.vout))),
  );
  const hashAmounts = sha256(concat(...prevValues.map((v) => u64le(v))));
  const hashScripts = sha256(
    concat(...prevScripts.map((s) => concat(varInt(s.length), s))),
  );
  const hashSequences = sha256(
    concat(...tx.inputs.map((i) => u32le(i.sequence >>> 0))),
  );
  const hashOutputs = sha256(
    concat(...tx.outputs.map((o) => serializeTxOut(o.value, o.pkScript))),
  );

  const epoch = Uint8Array.of(0x00);
  const hashType = Uint8Array.of(SIGHASH_DEFAULT);
  const version = u32le(tx.version >>> 0);
  const locktime = u32le(tx.locktime >>> 0);
  const spendType = Uint8Array.of(0x00); // ext_flag 0, no annex
  const inputIndex = u32le(idx);

  const sigMsg = concat(
    epoch,
    hashType,
    version,
    locktime,
    hashPrevouts,
    hashAmounts,
    hashScripts,
    hashSequences,
    hashOutputs,
    spendType,
    inputIndex,
  );

  // hash_TagSigHash(sigMsg). taggedHash already prepends the epoch-equivalent
  // tag hashes; here the 0x00 epoch is the first byte of sigMsg per the source.
  return schnorr.utils.taggedHash("TapSighash", sigMsg);
}

/** A signed input's resulting witness stack (single 64-byte Schnorr sig). */
export interface SignedInputWitness {
  index: number;
  witness: Uint8Array[];
}

/**
 * Sign a single Taproot key-path input. Returns the witness stack (one 64-byte
 * Schnorr signature for SigHashDefault). The `privateKey` is the UNTWEAKED
 * secp256k1 key controlling the input; the BIP-341 tweak is applied here.
 *
 * `auxRand` defaults to 32 zero bytes for DETERMINISTIC, reproducible signatures
 * (so the fixtures are stable). Production callers may pass fresh randomness.
 */
export function signTaprootKeyInput(
  tx: WireTx,
  idx: number,
  privateKey: Uint8Array,
  prevValues: readonly bigint[],
  prevScripts: readonly Uint8Array[],
  merkleRoot?: Uint8Array | null,
  auxRand: Uint8Array = new Uint8Array(32),
): Uint8Array[] {
  const sighash = taprootKeySpendSighash(tx, idx, prevValues, prevScripts);
  const tweakedPriv = tweakTaprootPrivKey(privateKey, merkleRoot);
  const sig = schnorr.sign(sighash, tweakedPriv, auxRand);
  if (sig.length !== 64) {
    throw new SignError(`expected 64-byte Schnorr signature, got ${sig.length}`);
  }
  // SigHashDefault => no sighash byte appended.
  return [sig];
}

/**
 * Sign every input of a draft transaction with the Taproot key-path and attach
 * the witnesses in place, returning the now-signed wire tx.
 *
 * Each `SigningInput` must carry its prevValue + prevPkScript (BIP-341 commits
 * them) and the controlling private key (looked up via `keyFor`). XMSS / script
 * paths are out of scope and rejected.
 *
 * @param keyFor maps an input (by index) to its 32-byte secp256k1 private key.
 */
export function signTransaction(
  tx: WireTx,
  signingInputs: readonly SigningInput[],
  keyFor: (input: SigningInput, idx: number) => Uint8Array,
  auxRandFor?: (idx: number) => Uint8Array,
): WireTx {
  if (signingInputs.length !== tx.inputs.length) {
    throw new SignError("signingInputs must be index-aligned with tx.inputs");
  }
  const prevValues = signingInputs.map((i) => i.prevValue);
  const prevScripts = signingInputs.map((i) => i.prevPkScript);

  const signedInputs = tx.inputs.map((input, idx) => {
    const ctx = signingInputs[idx] as SigningInput;
    const priv = keyFor(ctx, idx);
    const aux = auxRandFor ? auxRandFor(idx) : new Uint8Array(32);
    const witness = signTaprootKeyInput(
      tx,
      idx,
      priv,
      prevValues,
      prevScripts,
      ctx.tapMerkleRoot,
      aux,
    );
    return { ...input, witness };
  });

  return { ...tx, inputs: signedInputs };
}
