/**
 * Transaction virtual-size estimation for P2TR key-path spends.
 *
 * Used to estimate the NETWORK RELAY fee (Grain) = ceil(relayFeePerKb * vsize /
 * 1000), per Pearl's txrules (FeeForSerializeSize, DefaultRelayFeePerKb=1000)
 * and txsizes.EstimateVirtualSize. This is the ordinary miner fee, paid to the
 * chain — entirely separate from the flat Necklace fee (fee-policy §1).
 *
 * Sizes (Phase 1, txsizes/size.go; standard btcd SegWit weight accounting):
 *   - P2TR pkScript = 34 bytes (OP_1 <0x20> <32-byte key>).
 *   - Per output (non-witness) = 8 (value) + 1 (scriptlen varint) + 34 = 43 B.
 *   - Per P2TR input (non-witness) = 36 (outpoint) + 1 (empty scriptSig len)
 *     + 4 (sequence) = 41 B.
 *   - Per P2TR key-path input witness = 1 (item count) + 1 (sig len) + 64
 *     (Schnorr sig) = 66 witness bytes.
 *   - Overhead (non-witness) = 4 (version) + 4 (locktime) + varint(nIn)
 *     + varint(nOut). Witness overhead = 2 bytes (segwit marker+flag).
 *
 * weight = nonWitnessBytes*4 + witnessBytes;  vsize = ceil(weight / 4).
 */

const P2TR_PKSCRIPT_BYTES = 34;
const OUTPUT_BYTES = 8 + 1 + P2TR_PKSCRIPT_BYTES; // 43
const INPUT_NONWITNESS_BYTES = 36 + 1 + 4; // 41
const INPUT_WITNESS_BYTES = 1 + 1 + 64; // 66 (key-path: single 64-byte sig)
const SEGWIT_MARKER_FLAG = 2;

/** Compact-size (varint) byte length for a count. */
function varIntSize(n: number): number {
  if (n < 0xfd) return 1;
  if (n <= 0xffff) return 3;
  if (n <= 0xffffffff) return 5;
  return 9;
}

/**
 * Estimate the virtual size (vbytes) of a P2TR-only, key-path-signed tx with
 * `nIn` inputs and `nOut` outputs (all P2TR).
 */
export function estimateVsize(nIn: number, nOut: number): number {
  const nonWitness =
    4 + // version
    4 + // locktime
    varIntSize(nIn) +
    varIntSize(nOut) +
    nIn * INPUT_NONWITNESS_BYTES +
    nOut * OUTPUT_BYTES;

  const witness = SEGWIT_MARKER_FLAG + nIn * INPUT_WITNESS_BYTES;

  const weight = nonWitness * 4 + witness;
  return Math.ceil(weight / 4);
}

/**
 * Network relay fee in Grain for a tx of the given vsize.
 * fee = max(relayFeePerKb, ceil(relayFeePerKb * vsize / 1000)) — floored to the
 * per-kB rate so a tiny tx never rounds to a zero fee (txrules.FeeForSerializeSize).
 */
export function relayFeeForVsize(vsize: number, relayFeePerKb: bigint): bigint {
  const raw = (relayFeePerKb * BigInt(vsize) + 999n) / 1000n; // ceil
  return raw < relayFeePerKb ? relayFeePerKb : raw;
}
