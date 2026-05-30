/**
 * Build a transaction PREVIEW locally — the single source of truth the
 * ConfirmTransaction screen renders before any signature is produced.
 *
 * The preview itemises, separately and visibly (fee-policy §1, §3):
 *   1. amount to recipient,
 *   2. the FLAT Necklace fee (its own output to the pinned per-network address),
 *   3. the estimated NETWORK relay fee (paid to the chain),
 *   4. change back to the user,
 *   5. the total debited from the balance.
 *
 * Nothing here signs or touches the key. It only computes amounts and selects
 * coins, producing a {@link TxDraft} (the exact shape the vault signs) plus a
 * display-oriented {@link TxPreview}. It fails CLOSED:
 *   - if the Necklace fee address is unpinned or would be dust (FeePolicyError),
 *   - if funds cannot cover recipient + Necklace fee + relay fee (it names all
 *     three; it never silently drops the fee or reduces the send amount).
 */

import {
  DUST_THRESHOLD_GRAIN,
  sumGrain,
  type Grain,
  type NecklaceFee,
  type Network,
  type TxDraft,
  type TxRecipient,
  type Utxo,
} from "@necklace/shared";
import { requireNecklaceFee } from "./fee.js";
import { estimateVsize, relayFeeForVsize } from "./vsize.js";

/** Default relay-fee rate (Grain/kB) when the API is unavailable (DefaultRelayFeePerKb). */
export const DEFAULT_RELAY_FEE_PER_KB = 1000n;
/** Local lower bound the extension will never go below (== node default floor). */
export const MIN_RELAY_FEE_PER_KB = 1000n;
/** Local upper bound so a malicious API cannot push an absurd network fee (threat-model §2). */
export const MAX_RELAY_FEE_PER_KB = 100_000n;

export interface BuildPreviewParams {
  network: Network;
  /** Confirmed, spendable, P2TR UTXOs owned by the wallet. */
  utxos: Utxo[];
  /** Recipient address (already validated as P2TR for this network). */
  recipientAddress: string;
  /** Amount to send to the recipient, in Grain. */
  recipientValue: Grain;
  /** Change address (a wallet-owned P2TR address). */
  changeAddress: string;
  /** Relay fee rate (Grain/kB); clamped to [MIN, MAX]. Defaults to the floor. */
  relayFeePerKb?: bigint;
}

export interface TxPreview {
  network: Network;
  /** The exact draft the vault will sign (every output included). */
  draft: TxDraft;
  /** Selected inputs. */
  inputs: Utxo[];
  /** Recipient line. */
  recipient: TxRecipient;
  /** The visible flat Necklace fee line. */
  necklaceFee: NecklaceFee;
  /** Estimated network relay fee (Grain). */
  networkFee: Grain;
  /** Change returned to the user (Grain); 0n if dropped to fee. */
  change: Grain;
  /** True if change was below dust and absorbed into the network fee. */
  changeDropped: boolean;
  /** Total debited from balance = recipient + necklaceFee + networkFee. */
  totalDebit: Grain;
  /** Sum of selected inputs. */
  totalInput: Grain;
}

export class InsufficientFundsError extends Error {
  readonly required: Grain;
  readonly available: Grain;
  readonly recipientValue: Grain;
  readonly necklaceFee: Grain;
  readonly networkFee: Grain;
  constructor(params: {
    required: Grain;
    available: Grain;
    recipientValue: Grain;
    necklaceFee: Grain;
    networkFee: Grain;
  }) {
    super(
      "Insufficient funds: balance cannot cover the amount, the Necklace fee, " +
        "and the estimated network fee.",
    );
    this.name = "InsufficientFundsError";
    this.required = params.required;
    this.available = params.available;
    this.recipientValue = params.recipientValue;
    this.necklaceFee = params.necklaceFee;
    this.networkFee = params.networkFee;
  }
}

function clampRelayRate(rate: bigint): bigint {
  if (rate < MIN_RELAY_FEE_PER_KB) return MIN_RELAY_FEE_PER_KB;
  if (rate > MAX_RELAY_FEE_PER_KB) return MAX_RELAY_FEE_PER_KB;
  return rate;
}

/**
 * Greedy largest-first coin selection. Adds inputs until they cover
 * recipient + Necklace fee + the relay fee for the *current* input/output
 * count, recomputing the relay fee as the input set grows. Returns the selected
 * inputs and the relay fee for the chosen size (assuming a change output;
 * recomputed by the caller if change is dropped).
 */
function selectCoins(
  utxos: Utxo[],
  target: Grain,
  relayFeePerKb: bigint,
  nFixedOutputs: number,
): { inputs: Utxo[]; networkFee: Grain; totalInput: Grain } | null {
  const sorted = [...utxos].sort((a, b) =>
    a.value < b.value ? 1 : a.value > b.value ? -1 : 0,
  );
  const selected: Utxo[] = [];
  let total = 0n;
  for (const u of sorted) {
    selected.push(u);
    total += u.value;
    // Assume a change output exists during selection (nFixedOutputs + 1).
    const vsize = estimateVsize(selected.length, nFixedOutputs + 1);
    const networkFee = relayFeeForVsize(vsize, relayFeePerKb);
    if (total >= target + networkFee) {
      return { inputs: selected, networkFee, totalInput: total };
    }
  }
  return null;
}

/**
 * Build the full preview. Throws {@link FeePolicyError} (fee unpinned/dust) or
 * {@link InsufficientFundsError} (cannot fund) — both fail-closed.
 */
export function buildTxPreview(params: BuildPreviewParams): TxPreview {
  const {
    network,
    utxos,
    recipientAddress,
    recipientValue,
    changeAddress,
  } = params;

  const relayFeePerKb = clampRelayRate(
    params.relayFeePerKb ?? DEFAULT_RELAY_FEE_PER_KB,
  );

  // The flat Necklace fee — pinned, visible, fail-closed if unset/dust.
  const necklaceFee = requireNecklaceFee(network);

  const recipient: TxRecipient = {
    address: recipientAddress,
    value: recipientValue,
  };

  // Two fixed outputs before change: recipient + Necklace fee.
  const nFixedOutputs = 2;
  const target = recipientValue + necklaceFee.value;

  const selection = selectCoins(utxos, target, relayFeePerKb, nFixedOutputs);
  if (!selection) {
    const available = sumGrain(utxos.map((u) => u.value));
    // Best-effort fee estimate for the message using all utxos.
    const vsize = estimateVsize(Math.max(utxos.length, 1), nFixedOutputs + 1);
    const networkFee = relayFeeForVsize(vsize, relayFeePerKb);
    throw new InsufficientFundsError({
      required: target + networkFee,
      available,
      recipientValue,
      necklaceFee: necklaceFee.value,
      networkFee,
    });
  }

  const { inputs, totalInput } = selection;
  let { networkFee } = selection;

  // Compute change = inputs - recipient - necklaceFee - networkFee.
  let change = totalInput - target - networkFee;
  let changeDropped = false;

  if (change < 0n) {
    // Should not happen given selection succeeded, but guard fail-closed.
    throw new InsufficientFundsError({
      required: target + networkFee,
      available: totalInput,
      recipientValue,
      necklaceFee: necklaceFee.value,
      networkFee,
    });
  }

  if (change < DUST_THRESHOLD_GRAIN) {
    // Dropping change: no change output. Recompute the relay fee for the
    // smaller tx (fixed outputs only) and roll the leftover into the fee
    // (standard btcd behaviour — change-to-fee).
    changeDropped = true;
    const vsizeNoChange = estimateVsize(inputs.length, nFixedOutputs);
    const feeNoChange = relayFeeForVsize(vsizeNoChange, relayFeePerKb);
    // Everything not paid to recipient/Necklace becomes the network fee.
    networkFee = totalInput - target;
    // The recomputed minimum must still be met (it always is, since we only
    // grew the implicit fee). Guard anyway.
    if (networkFee < feeNoChange) {
      networkFee = feeNoChange;
    }
    change = 0n;
  }

  const changeRecipient: TxRecipient | undefined = changeDropped
    ? undefined
    : { address: changeAddress, value: change };

  const draft: TxDraft = {
    network,
    inputs,
    recipients: [recipient],
    change: changeRecipient,
    necklaceFee,
    minerFee: networkFee,
  };

  const totalDebit = recipientValue + necklaceFee.value + networkFee;

  return {
    network,
    draft,
    inputs,
    recipient,
    necklaceFee,
    networkFee,
    change,
    changeDropped,
    totalDebit,
    totalInput,
  };
}
