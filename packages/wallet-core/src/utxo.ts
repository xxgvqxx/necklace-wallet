/**
 * UTXO eligibility + coin selection for Necklace.
 *
 * Mirrors Pearl's wallet (wallet/wallet/createtx.go):
 *   - findEligibleOutputs: skip outputs that are not P2TR, not mature
 *     (coinbase needs CoinbaseMaturity=100 confs), or below the minconf policy;
 *   - sortByAmount + sort.Reverse: candidates are tried LARGEST-first;
 *   - makeInputSource: greedily accumulate inputs until currentTotal >= target,
 *     where the target grows to cover the recomputed network fee as inputs are
 *     added.
 *
 * The selector is fee-aware: the "target" it must cover is
 *   recipients + visible Necklace flat fee + estimated network/miner fee.
 * The network fee depends on the input count, so we recompute it on every step,
 * exactly like txauthor does as it pulls from the InputSource.
 */

import {
  DUST_THRESHOLD_GRAIN,
  sumGrain,
  type Grain,
  type Utxo,
} from "@necklace/shared";
import {
  DEFAULT_RELAY_FEE_PER_KB,
  estimateNetworkFee,
  P2TR_PK_SCRIPT_SIZE,
} from "./fees.js";

/** Pearl CoinbaseMaturity — coinbase outputs need this many confirmations. */
export const COINBASE_MATURITY = 100;

/** A spendable candidate: a Utxo plus the metadata needed to judge eligibility. */
export interface CandidateUtxo extends Utxo {
  /** Whether this output was created by a coinbase transaction. */
  fromCoinbase?: boolean;
  /** Pre-computed spendable flag from the indexer, if provided (overrides checks). */
  spendable?: boolean;
}

/** Fee inputs for the selector. */
export interface SelectFeePolicy {
  /** Visible flat Necklace fee, in Grain (a separate explicit output). */
  flatFeeGrain: Grain;
  /** pkScript sizes (bytes) of the explicit outputs: recipients + the flat fee. */
  outputScriptSizes: readonly number[];
  /** Relay fee rate in Grain per 1000 bytes (default 1000). */
  relayFeePerKb?: Grain;
  /** Minimum confirmations a UTXO needs to be eligible (default 1). */
  minConfirmations?: number;
}

/** The result of a successful selection. */
export interface SelectionResult {
  /** Chosen inputs, in the order they were accumulated (largest-first). */
  selected: CandidateUtxo[];
  /** Sum of selected input values, in Grain. */
  totalInputGrain: Grain;
  /** Sum of recipient outputs, in Grain (the target excluding fees). */
  recipientGrain: Grain;
  /** Visible flat Necklace fee, in Grain. */
  flatFeeGrain: Grain;
  /** Estimated network/miner fee for the final input/output set, in Grain. */
  networkFeeGrain: Grain;
  /** Change to return to the wallet, in Grain (0 if none / folded into fee). */
  changeGrain: Grain;
  /** Whether a P2TR change output should be added. */
  hasChange: boolean;
}

/** Thrown when funds are insufficient or inputs are invalid. */
export class CoinSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoinSelectionError";
  }
}

/** A P2TR pkScript is `0x51 0x20 <32 bytes>` (34 bytes). */
function isP2trScript(scriptPubKeyHex: string): boolean {
  const lower = scriptPubKeyHex.toLowerCase();
  return lower.length === P2TR_PK_SCRIPT_SIZE * 2 && lower.startsWith("5120");
}

/**
 * Filter a UTXO set down to spendable, Taproot, mature, confirmed outputs.
 * Port of findEligibleOutputs' eligibility checks.
 */
export function filterEligible(
  utxos: readonly CandidateUtxo[],
  minConfirmations = 1,
): CandidateUtxo[] {
  return utxos.filter((u) => {
    if (u.spendable === false) return false;
    if (!isP2trScript(u.scriptPubKeyHex)) return false;
    const confs = u.confirmations ?? 0;
    if (confs < minConfirmations) return false;
    if (u.fromCoinbase && confs < COINBASE_MATURITY) return false;
    if (u.value <= 0n) return false;
    return true;
  });
}

/** Sort candidates largest-value first (sort.Reverse(sortByAmount)). Stable, non-mutating. */
export function sortLargestFirst(
  utxos: readonly CandidateUtxo[],
): CandidateUtxo[] {
  return [...utxos].sort((a, b) => {
    if (a.value < b.value) return 1;
    if (a.value > b.value) return -1;
    return 0;
  });
}

/**
 * Select UTXOs to fund `recipientGrain` plus the visible flat fee plus the
 * (recomputed) network fee, using Pearl's largest-first greedy strategy.
 *
 * The network fee is recomputed after every added input (it grows with input
 * count). Once the accumulated total covers recipients + flat fee + network
 * fee, we stop. A change output is added when the leftover after fees is at or
 * above the dust floor; otherwise the leftover is dropped into the miner fee
 * (no dust change), matching wallet behaviour.
 *
 * @throws CoinSelectionError when eligible funds cannot cover the target.
 */
export function selectUtxos(
  utxos: readonly CandidateUtxo[],
  recipientGrain: Grain,
  feePolicy: SelectFeePolicy,
): SelectionResult {
  if (recipientGrain < 0n) {
    throw new CoinSelectionError("recipient amount is negative");
  }
  const relayFeePerKb = feePolicy.relayFeePerKb ?? DEFAULT_RELAY_FEE_PER_KB;
  const minConfs = feePolicy.minConfirmations ?? 1;

  const eligible = sortLargestFirst(filterEligible(utxos, minConfs));

  const flatFeeGrain = feePolicy.flatFeeGrain;
  const baseOutputScriptSizes = feePolicy.outputScriptSizes;
  const requiredOutputs = recipientGrain + flatFeeGrain;

  const selected: CandidateUtxo[] = [];
  let totalInputGrain = 0n;
  const remaining = [...eligible];

  // Greedy accumulate, recomputing the fee-inclusive target each step.
  // We must consider BOTH the no-change and with-change fee so we don't
  // under-fund the case where a change output is ultimately required.
  for (;;) {
    const numInputs = selected.length;
    // Fee if a change output is added (the common case).
    const feeWithChange =
      numInputs === 0
        ? estimateNetworkFee(1, baseOutputScriptSizes, true, relayFeePerKb)
        : estimateNetworkFee(numInputs, baseOutputScriptSizes, true, relayFeePerKb);

    const targetWithChange = requiredOutputs + feeWithChange;

    if (numInputs > 0 && totalInputGrain >= targetWithChange) break;

    // Also satisfy the no-change target (smaller), in case change is dust.
    const feeNoChange =
      numInputs === 0
        ? estimateNetworkFee(1, baseOutputScriptSizes, false, relayFeePerKb)
        : estimateNetworkFee(numInputs, baseOutputScriptSizes, false, relayFeePerKb);
    const targetNoChange = requiredOutputs + feeNoChange;
    if (numInputs > 0 && totalInputGrain >= targetNoChange) break;

    const next = remaining.shift();
    if (next === undefined) {
      // Out of inputs and still short.
      throw new CoinSelectionError(
        `insufficient funds: have ${totalInputGrain} Grain, need at least ${targetNoChange} Grain ` +
          `(recipients ${recipientGrain} + flat fee ${flatFeeGrain} + network fee)`,
      );
    }
    selected.push(next);
    totalInputGrain += next.value;
  }

  // Decide change vs. fold-into-fee using the final input count.
  const numInputs = selected.length;
  const feeWithChange = estimateNetworkFee(
    numInputs,
    baseOutputScriptSizes,
    true,
    relayFeePerKb,
  );
  const feeNoChange = estimateNetworkFee(
    numInputs,
    baseOutputScriptSizes,
    false,
    relayFeePerKb,
  );

  const leftoverWithChange =
    totalInputGrain - requiredOutputs - feeWithChange;

  if (leftoverWithChange >= DUST_THRESHOLD_GRAIN) {
    return {
      selected,
      totalInputGrain,
      recipientGrain,
      flatFeeGrain,
      networkFeeGrain: feeWithChange,
      changeGrain: leftoverWithChange,
      hasChange: true,
    };
  }

  // Change would be dust (or negative): drop it; the leftover becomes extra
  // miner fee. Verify we still cover the no-change requirement.
  const leftoverNoChange = totalInputGrain - requiredOutputs - feeNoChange;
  if (leftoverNoChange < 0n) {
    throw new CoinSelectionError(
      `insufficient funds after fees: have ${totalInputGrain} Grain, ` +
        `need ${requiredOutputs + feeNoChange} Grain`,
    );
  }
  return {
    selected,
    totalInputGrain,
    recipientGrain,
    flatFeeGrain,
    // Excess (would-be dust change) is absorbed into the actual miner fee.
    networkFeeGrain: feeNoChange + leftoverNoChange,
    changeGrain: 0n,
    hasChange: false,
  };
}

/** Convenience: total spendable value of an eligible-or-raw UTXO set, in Grain. */
export function spendableTotal(
  utxos: readonly CandidateUtxo[],
  minConfirmations = 1,
): Grain {
  return sumGrain(filterEligible(utxos, minConfirmations).map((u) => u.value));
}
