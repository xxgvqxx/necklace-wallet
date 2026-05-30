/**
 * Transaction builder for Necklace.
 *
 * Builds an UNSIGNED Pearl transaction (wire.TxVersion = 1) from selected UTXOs,
 * recipient outputs, an optional change output, and — critically — the explicit,
 * VISIBLE Necklace flat-fee output (USER DECISION: the wallet fee is a separate
 * extra P2TR output, shown before signing, never hidden).
 *
 * Output ordering note: Pearl randomizes the change position before signing
 * (RandomizeChangePosition). We keep a DETERMINISTIC order here
 * (recipients, then visible Necklace fee, then change) so the preview shown to
 * the user is stable and the fixtures are reproducible; the background/UI layer
 * may shuffle change position later if desired without affecting validity.
 *
 * Each input carries its BIP-341 signing context (prevValue + prevPkScript +
 * x-only internal key + optional tapscript root) because BIP-341 sighash commits
 * input values and scripts — these MUST be supplied to the signer
 * (Phase 1 critical constraint).
 *
 * Sources: wallet/wallet/txauthor/author.go (NewUnsignedTransaction),
 * createtx.go, node/wire/msgtx.go.
 */

import { DUST_THRESHOLD_GRAIN, type Grain } from "@necklace/shared";
import { decodeAddress } from "./address.js";
import type { CandidateUtxo } from "./utxo.js";
import type { TxInput, TxOutput, WireTx } from "./serialize.js";

/** Default input sequence (final, no RBF/locktime semantics). */
export const DEFAULT_SEQUENCE = 0xffffffff;
/** Pearl default transaction version (wire.TxVersion). */
export const DEFAULT_TX_VERSION = 1;

/** Roles let the UI render each output as a distinct, labelled line item. */
export type OutputRole = "recipient" | "necklace_fee" | "change";

/** Per-input data the signer needs (BIP-341 commits prevValue + prevScript). */
export interface SigningInput {
  txid: string;
  vout: number;
  sequence: number;
  /** Value of the prevout being spent, in Grain (committed in BIP-341 sighash). */
  prevValue: Grain;
  /** scriptPubKey of the prevout being spent. */
  prevPkScript: Uint8Array;
  /**
   * x-only (32-byte) internal public key for the Taproot key-path spend. Set
   * from the wallet key that controls this UTXO.
   */
  tapInternalKey?: Uint8Array;
  /**
   * 32-byte tapscript merkle root, if the address carries an XMSS commitment.
   * null/undefined = standard BIP-86 key (no commitment). The key-path spend
   * still tweaks the private key by this root (Phase 1).
   */
  tapMerkleRoot?: Uint8Array | null;
}

/** An output annotated with its role and (when known) destination address. */
export interface AnnotatedOutput extends TxOutput {
  role: OutputRole;
  address?: string;
}

/** A recipient the user wants to pay. */
export interface OutputSpec {
  /** Destination bech32m P2TR address. */
  address: string;
  /** Amount in Grain. */
  value: Grain;
}

/**
 * A draft transaction: the wire skeleton plus the signing context and
 * role-annotated outputs for the preview UI.
 */
export interface TransactionDraft {
  tx: WireTx;
  /** Per-input signing context, index-aligned with tx.inputs. */
  signingInputs: SigningInput[];
  /** Role-annotated outputs, index-aligned with tx.outputs. */
  annotatedOutputs: AnnotatedOutput[];
}

/** Thrown on invalid transaction construction. */
export class TransactionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransactionError";
  }
}

/** Decode a bech32m address to its scriptPubKey, asserting it is a valid Pearl addr. */
function addressToPkScript(address: string): Uint8Array {
  return decodeAddress(address).scriptPubKey;
}

/**
 * Build an unsigned transaction from selected inputs and recipient outputs,
 * plus an optional change output. The visible Necklace flat fee is added
 * separately via {@link addWalletFeeOutput} (kept explicit so it can never be
 * folded silently into another output).
 *
 * @param outputs        recipient outputs (address + Grain value)
 * @param selectedUtxos  the chosen inputs (with prevValue + script + key)
 * @param changeAddress  wallet change address, or undefined for no change
 * @param changeValue    change amount in Grain (ignored if it would be dust)
 */
export function buildTransaction(
  outputs: readonly OutputSpec[],
  selectedUtxos: readonly SelectedInput[],
  changeAddress: string | undefined,
  changeValue: Grain = 0n,
): TransactionDraft {
  if (selectedUtxos.length === 0) {
    throw new TransactionError("transaction must have at least one input");
  }
  if (outputs.length === 0) {
    throw new TransactionError("transaction must have at least one recipient");
  }

  const inputs: TxInput[] = [];
  const signingInputs: SigningInput[] = [];
  for (const u of selectedUtxos) {
    if (u.value < 0n) {
      throw new TransactionError("input value is negative");
    }
    inputs.push({
      txid: u.txid,
      vout: u.vout,
      scriptSig: new Uint8Array(0),
      sequence: u.sequence ?? DEFAULT_SEQUENCE,
      witness: [],
    });
    signingInputs.push({
      txid: u.txid,
      vout: u.vout,
      sequence: u.sequence ?? DEFAULT_SEQUENCE,
      prevValue: u.value,
      prevPkScript: hexToScript(u.scriptPubKeyHex),
      tapInternalKey: u.tapInternalKey,
      tapMerkleRoot: u.tapMerkleRoot ?? null,
    });
  }

  const txOutputs: TxOutput[] = [];
  const annotated: AnnotatedOutput[] = [];

  for (const out of outputs) {
    if (out.value < DUST_THRESHOLD_GRAIN) {
      throw new TransactionError(
        `recipient output ${out.value} Grain is below the dust floor (${DUST_THRESHOLD_GRAIN})`,
      );
    }
    const pkScript = addressToPkScript(out.address);
    txOutputs.push({ value: out.value, pkScript });
    annotated.push({
      value: out.value,
      pkScript,
      role: "recipient",
      address: out.address,
    });
  }

  // Change output last (deterministic); omitted if dust or zero.
  if (changeAddress !== undefined && changeValue >= DUST_THRESHOLD_GRAIN) {
    const pkScript = addressToPkScript(changeAddress);
    txOutputs.push({ value: changeValue, pkScript });
    annotated.push({
      value: changeValue,
      pkScript,
      role: "change",
      address: changeAddress,
    });
  } else if (changeAddress !== undefined && changeValue > 0n) {
    // Non-zero but dust change: refuse silently dropping value without telling
    // the caller; they should fold it into the fee via the selector instead.
    throw new TransactionError(
      `change ${changeValue} Grain is below the dust floor; fold it into the fee instead of emitting dust`,
    );
  }

  return {
    tx: {
      version: DEFAULT_TX_VERSION,
      inputs,
      outputs: txOutputs,
      locktime: 0,
    },
    signingInputs,
    annotatedOutputs: annotated,
  };
}

/**
 * Add the explicit, VISIBLE Necklace flat-fee output to a draft.
 *
 * The flat fee is a real extra P2TR output of a fixed Grain amount paid to the
 * Necklace fee address. It is inserted BEFORE any change output so the preview
 * lists: recipients, Necklace fee, change. Never hidden; must be above dust.
 *
 * Returns a NEW draft (does not mutate the input). Call this before signing so
 * the user sees the fee line item.
 */
export function addWalletFeeOutput(
  draft: TransactionDraft,
  feeAddress: string,
  flatFeeAmount: Grain,
): TransactionDraft {
  if (flatFeeAmount <= 0n) {
    throw new TransactionError("Necklace flat fee must be positive");
  }
  if (flatFeeAmount < DUST_THRESHOLD_GRAIN) {
    throw new TransactionError(
      `Necklace flat fee ${flatFeeAmount} Grain is below the dust floor (${DUST_THRESHOLD_GRAIN})`,
    );
  }
  const pkScript = addressToPkScript(feeAddress);

  // Insert the fee output immediately before a trailing change output (if any),
  // otherwise append it. This keeps the order: recipients, necklace_fee, change.
  const outputs = [...draft.tx.outputs];
  const annotated = [...draft.annotatedOutputs];

  const changeIdx = annotated.findIndex((o) => o.role === "change");
  const insertAt = changeIdx === -1 ? outputs.length : changeIdx;

  outputs.splice(insertAt, 0, { value: flatFeeAmount, pkScript });
  annotated.splice(insertAt, 0, {
    value: flatFeeAmount,
    pkScript,
    role: "necklace_fee",
    address: feeAddress,
  });

  return {
    tx: { ...draft.tx, outputs },
    signingInputs: draft.signingInputs,
    annotatedOutputs: annotated,
  };
}

/** Total of all output values in a draft, in Grain. */
export function totalOutputValue(draft: TransactionDraft): Grain {
  return draft.tx.outputs.reduce((acc, o) => acc + o.value, 0n);
}

/** Total of all input prevValues in a draft, in Grain. */
export function totalInputValue(draft: TransactionDraft): Grain {
  return draft.signingInputs.reduce((acc, i) => acc + i.prevValue, 0n);
}

/** Implied miner fee (inputs - outputs), in Grain. Throws if negative. */
export function impliedMinerFee(draft: TransactionDraft): Grain {
  const fee = totalInputValue(draft) - totalOutputValue(draft);
  if (fee < 0n) {
    throw new TransactionError("outputs exceed inputs (negative miner fee)");
  }
  return fee;
}

/** A selected input augmented with the key material needed to sign it. */
export interface SelectedInput extends CandidateUtxo {
  /** Sequence override (defaults to 0xffffffff). */
  sequence?: number;
  /** x-only internal public key controlling this UTXO. */
  tapInternalKey?: Uint8Array;
  /** Tapscript merkle root, if the address carries an XMSS commitment. */
  tapMerkleRoot?: Uint8Array | null;
}

function hexToScript(hex: string): Uint8Array {
  const clean = hex.toLowerCase();
  if (clean.length % 2 !== 0 || /[^0-9a-f]/.test(clean)) {
    throw new TransactionError(`invalid pkScript hex: "${hex}"`);
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}
