/**
 * Fee model for Necklace.
 *
 * Two distinct fees, both denominated in Grain (1 PRL = 1e8 Grain):
 *
 *  1. NETWORK / MINER FEE — implicit, paid to miners as
 *     (sum inputs - sum outputs). Estimated from the transaction's virtual size
 *     and a relay-fee-per-kB rate, exactly as Pearl does.
 *
 *  2. NECKLACE FLAT FEE — an explicit, visible extra P2TR OUTPUT of a fixed
 *     Grain amount, shown to the user before signing (USER DECISION). It is
 *     never hidden and must be above the dust floor.
 *
 * Vsize / fee math ported from Pearl (authoritative):
 *   node/blockchain/vsize.go      -> CalcVsize, WitnessScaleFactor = 4
 *   wallet/wallet/txsizes/size.go -> P2TR sizes, EstimateVirtualSize
 *   wallet/wallet/txrules/rules.go-> FeeForSerializeSize, DefaultRelayFeePerKb=1000
 *   node/btcutil/amount.go        -> Grain (int64), MaxGrain
 */

import {
  DUST_THRESHOLD_GRAIN,
  MAX_GRAIN,
  type Grain,
} from "@necklace/shared";

/** SegWit discount divisor: each witness byte counts as 0.25 vbytes (vsize.go). */
export const WITNESS_SCALE_FACTOR = 4;

/** Default minimum relay fee, in Grain per 1000 bytes (txrules DefaultRelayFeePerKb = 1e3). */
export const DEFAULT_RELAY_FEE_PER_KB: Grain = 1000n;

// --- Pearl P2TR size constants (txsizes/size.go) ---

/** OP_1 (1) + OP_DATA_32 (1) + 32-byte program. */
export const P2TR_PK_SCRIPT_SIZE = 1 + 1 + 32; // 34
/** value(8) + varint scriptlen(1) + pkScript(34). */
export const P2TR_OUTPUT_SIZE = 8 + 1 + P2TR_PK_SCRIPT_SIZE; // 43
/** outpoint(36) + scriptSig varint(1) + empty scriptSig(0) + sequence(4). */
export const REDEEM_P2TR_INPUT_SIZE = 32 + 4 + 1 + 0 + 4; // 41
/** witness items varint(1) + sig len varint(1) + 65-byte worst-case sig. */
export const REDEEM_P2TR_INPUT_WITNESS_WEIGHT = 1 + 1 + 65; // 67

/** Thrown for invalid fee configuration. */
export class FeeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeeError";
  }
}

/** Bitcoin/btcd varint serialize size (wire.VarIntSerializeSize). */
export function varIntSerializeSize(n: number): number {
  if (n < 0xfd) return 1;
  if (n <= 0xffff) return 3;
  if (n <= 0xffffffff) return 5;
  return 9;
}

/** ceil(a / b) for non-negative integers. */
function ceilDiv(a: number, b: number): number {
  return Math.floor((a + b - 1) / b);
}

/**
 * CalcVsize: vsize = baseSize + ceil(witnessSize / WitnessScaleFactor).
 * Direct port of node/blockchain/vsize.go.
 */
export function calcVsize(baseSize: number, witnessSize: number): number {
  return baseSize + ceilDiv(witnessSize, WITNESS_SCALE_FACTOR);
}

/**
 * Estimate the virtual size (vbytes) of a Taproot-only transaction with
 * `numInputs` P2TR inputs and the given output pkScript sizes, optionally
 * adding a P2TR change output.
 *
 * Port of txsizes.EstimateVirtualSize (Taproot-only path). `outputScriptSizes`
 * are the pkScript byte-lengths of every explicit output (recipient + Necklace
 * fee + any extra). For P2TR outputs that is 34.
 */
export function estimateVirtualSize(
  numInputs: number,
  outputScriptSizes: readonly number[],
  addChangeOutput: boolean,
): number {
  const totalInputs = numInputs;
  let outputCount = outputScriptSizes.length;

  let changeOutputSize = 0;
  if (addChangeOutput) {
    const changeScriptSize = P2TR_PK_SCRIPT_SIZE;
    changeOutputSize =
      8 + varIntSerializeSize(changeScriptSize) + changeScriptSize;
    outputCount += 1;
  }

  const sumOutputs = outputScriptSizes.reduce(
    (acc, scriptSize) => acc + 8 + varIntSerializeSize(scriptSize) + scriptSize,
    0,
  );

  const baseSize =
    8 +
    varIntSerializeSize(totalInputs) +
    varIntSerializeSize(outputCount) +
    totalInputs * REDEEM_P2TR_INPUT_SIZE +
    sumOutputs +
    changeOutputSize;

  let witnessWeight = 0;
  if (totalInputs > 0) {
    // +2 weight for segwit marker + flag.
    witnessWeight =
      2 +
      varIntSerializeSize(totalInputs) +
      totalInputs * REDEEM_P2TR_INPUT_WITNESS_WEIGHT;
  }

  return calcVsize(baseSize, witnessWeight);
}

/**
 * FeeForSerializeSize: fee = relayFeePerKb * size / 1000, with a floor of
 * relayFeePerKb when the result would be 0, clamped to [0, MaxGrain].
 * Direct port of txrules.FeeForSerializeSize. `size` is in vbytes.
 */
export function feeForSerializeSize(
  relayFeePerKb: Grain,
  size: number,
): Grain {
  let fee = (relayFeePerKb * BigInt(size)) / 1000n;
  if (fee === 0n && relayFeePerKb > 0n) {
    fee = relayFeePerKb;
  }
  if (fee < 0n || fee > MAX_GRAIN) {
    fee = MAX_GRAIN;
  }
  return fee;
}

/**
 * Estimate the network (miner) fee in Grain for a Taproot transaction.
 *
 * @param numInputs        number of P2TR inputs to be spent
 * @param outputScriptSizes pkScript byte-lengths of every explicit output
 *                          (recipient + visible Necklace fee + ...), e.g. 34 each
 * @param addChangeOutput  whether a P2TR change output will be added
 * @param relayFeePerKb    fee rate in Grain per 1000 bytes (default 1000)
 */
export function estimateNetworkFee(
  numInputs: number,
  outputScriptSizes: readonly number[],
  addChangeOutput: boolean,
  relayFeePerKb: Grain = DEFAULT_RELAY_FEE_PER_KB,
): Grain {
  const vsize = estimateVirtualSize(
    numInputs,
    outputScriptSizes,
    addChangeOutput,
  );
  return feeForSerializeSize(relayFeePerKb, vsize);
}

/**
 * The flat-fee policy for Necklace. The fee is a fixed Grain amount paid to a
 * fixed Necklace fee address, rendered as a visible, separate output.
 */
export interface FlatFeePolicy {
  /** Fixed fee amount, in Grain. Must be above the dust floor. */
  flatFeeGrain: Grain;
  /** P2TR bech32m address the flat fee is paid to. */
  feeAddress: string;
}

/**
 * Validate a flat-fee policy: amount must be a positive Grain value at or above
 * the dust floor (so the explicit fee output is relayable).
 */
export function assertValidFlatFee(policy: FlatFeePolicy): void {
  if (policy.flatFeeGrain < 0n) {
    throw new FeeError("flat fee is negative");
  }
  if (policy.flatFeeGrain > 0n && policy.flatFeeGrain < DUST_THRESHOLD_GRAIN) {
    throw new FeeError(
      `flat fee ${policy.flatFeeGrain} Grain is below the dust floor (${DUST_THRESHOLD_GRAIN} Grain)`,
    );
  }
  if (policy.flatFeeGrain > MAX_GRAIN) {
    throw new FeeError("flat fee exceeds supply cap");
  }
}
