/**
 * Raw transaction (de)serialization — standard btcd / Bitcoin wire format with
 * SegWit witness encoding. NOT modified for XMSS (Phase 1: tx serialization is
 * unchanged from btcd; node/wire/msgtx.go).
 *
 * Wire layout (Phase 1, msgtx.go):
 *   version(4 LE)
 *   [ 0x00 marker | flag byte ]      (only when any input has witness data)
 *   varint nIn
 *   inputs: 32-byte txid (internal/LE order) | 4-byte index LE |
 *           varint scriptSigLen | scriptSig | 4-byte sequence LE
 *   varint nOut
 *   outputs: 8-byte value LE (Grain) | varint pkScriptLen | pkScript
 *   [ per-input witness: varint nItems | (varint len | item)* ]   (segwit only)
 *   locktime(4 LE)
 *
 * The txid is the double-SHA256 of the NON-witness serialization, displayed in
 * reverse (big-endian) byte order. wtxid is over the full witness serialization.
 *
 * This is a small, fully auditable serializer (no remote code, strict CSP). The
 * fixture tests cross-check its output byte-for-byte against @scure/btc-signer's
 * Transaction.toBytes(), which is itself KAT-tested upstream.
 */

import { sha256 } from "@noble/hashes/sha2.js";

/** A transaction input in wire form. */
export interface TxInput {
  /** Previous tx id, big-endian/display hex (will be reversed on the wire). */
  txid: string;
  /** Previous output index. */
  vout: number;
  /** scriptSig bytes (empty for native segwit). */
  scriptSig: Uint8Array;
  /** Sequence number (default 0xffffffff). */
  sequence: number;
  /** Witness stack items (empty if not yet signed). */
  witness: Uint8Array[];
}

/** A transaction output in wire form. */
export interface TxOutput {
  /** Value in Grain. */
  value: bigint;
  /** scriptPubKey bytes. */
  pkScript: Uint8Array;
}

/** A full transaction in wire form. */
export interface WireTx {
  version: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  locktime: number;
}

class ByteWriter {
  private chunks: number[] = [];

  u8(n: number): void {
    this.chunks.push(n & 0xff);
  }

  u16le(n: number): void {
    this.u8(n);
    this.u8(n >>> 8);
  }

  u32le(n: number): void {
    this.u8(n);
    this.u8(n >>> 8);
    this.u8(n >>> 16);
    this.u8(n >>> 24);
  }

  u64le(n: bigint): void {
    let v = BigInt.asUintN(64, n);
    for (let i = 0; i < 8; i++) {
      this.u8(Number(v & 0xffn));
      v >>= 8n;
    }
  }

  varInt(n: number): void {
    if (n < 0xfd) {
      this.u8(n);
    } else if (n <= 0xffff) {
      this.u8(0xfd);
      this.u16le(n);
    } else if (n <= 0xffffffff) {
      this.u8(0xfe);
      this.u32le(n);
    } else {
      this.u8(0xff);
      this.u64le(BigInt(n));
    }
  }

  bytes(b: Uint8Array): void {
    for (const x of b) this.chunks.push(x);
  }

  /** length-prefixed byte string (varint len || bytes). */
  varBytes(b: Uint8Array): void {
    this.varInt(b.length);
    this.bytes(b);
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.toLowerCase();
  if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) {
    throw new Error(`invalid hex: "${hex}"`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (const x of b) s += x.toString(16).padStart(2, "0");
  return s;
}

/** txid display order is the reverse of the internal (wire) byte order. */
function reverseBytes(b: Uint8Array): Uint8Array {
  const out = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) out[i] = b[b.length - 1 - i] as number;
  return out;
}

/** Serialize the inputs (outpoint + scriptSig + sequence). */
function writeInputs(w: ByteWriter, inputs: readonly TxInput[]): void {
  w.varInt(inputs.length);
  for (const input of inputs) {
    // txid on the wire is little-endian (reverse of the display/big-endian hex).
    w.bytes(reverseBytes(hexToBytes(input.txid)));
    w.u32le(input.vout);
    w.varBytes(input.scriptSig);
    w.u32le(input.sequence >>> 0);
  }
}

/** Serialize the outputs (value + pkScript). */
function writeOutputs(w: ByteWriter, outputs: readonly TxOutput[]): void {
  w.varInt(outputs.length);
  for (const output of outputs) {
    w.u64le(output.value);
    w.varBytes(output.pkScript);
  }
}

/**
 * Serialize a transaction to raw bytes.
 *
 * @param includeWitness when true (and any input carries witness data) emit the
 *   SegWit marker/flag and per-input witness stacks. When false, emit the legacy
 *   (stripped) serialization used for the txid.
 */
export function serializeTx(tx: WireTx, includeWitness = true): Uint8Array {
  const hasWitness =
    includeWitness && tx.inputs.some((i) => i.witness.length > 0);

  const w = new ByteWriter();
  w.u32le(tx.version >>> 0);

  if (hasWitness) {
    w.u8(0x00); // marker
    w.u8(0x01); // flag
  }

  writeInputs(w, tx.inputs);
  writeOutputs(w, tx.outputs);

  if (hasWitness) {
    for (const input of tx.inputs) {
      w.varInt(input.witness.length);
      for (const item of input.witness) {
        w.varBytes(item);
      }
    }
  }

  w.u32le(tx.locktime >>> 0);
  return w.toBytes();
}

/** Serialize to a hex string (full witness serialization by default). */
export function serializeTxHex(tx: WireTx, includeWitness = true): string {
  return bytesToHex(serializeTx(tx, includeWitness));
}

function doubleSha256(b: Uint8Array): Uint8Array {
  return sha256(sha256(b));
}

/**
 * Compute the txid (double-SHA256 over the NON-witness serialization, displayed
 * in reverse byte order). This is the canonical id used to reference the tx.
 */
export function computeTxid(tx: WireTx): string {
  const stripped = serializeTx(tx, false);
  return bytesToHex(reverseBytes(doubleSha256(stripped)));
}

/**
 * Compute the wtxid (double-SHA256 over the FULL witness serialization, reversed).
 * Equals the txid for transactions with no witness data.
 */
export function computeWtxid(tx: WireTx): string {
  const full = serializeTx(tx, true);
  return bytesToHex(reverseBytes(doubleSha256(full)));
}

export { hexToBytes, reverseBytes };
