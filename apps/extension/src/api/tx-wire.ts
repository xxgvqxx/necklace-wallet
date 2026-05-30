/**
 * Wire form of a {@link TxDraft} for crossing the chrome.runtime messaging
 * boundary.
 *
 * `chrome.runtime.sendMessage` serializes with JSON, which CANNOT represent
 * `bigint` — and PRL amounts (Grain) are bigint. Sending a raw TxDraft therefore
 * fails with "Could not serialize message". So the SIGN_TX message carries all
 * Grain amounts as decimal strings; the worker converts them back to bigint
 * before signing. Display/UI keep using the bigint `TxDraft`.
 */

import type {
  NecklaceFee,
  Network,
  TxDraft,
  TxRecipient,
  Utxo,
} from "@necklace/shared";

interface WireUtxo {
  txid: string;
  vout: number;
  value: string;
  scriptPubKeyHex: string;
  address?: string;
  confirmations?: number;
}
interface WireAmountTarget {
  address: string;
  value: string;
}

/** JSON-safe TxDraft: every Grain (bigint) field is a decimal string. */
export interface WireTxDraft {
  network: Network;
  inputs: WireUtxo[];
  recipients: WireAmountTarget[];
  change?: WireAmountTarget;
  necklaceFee?: WireAmountTarget;
  minerFee: string;
}

/** TxDraft -> JSON-safe wire form (bigint -> string). */
export function toWireTxDraft(d: TxDraft): WireTxDraft {
  return {
    network: d.network,
    inputs: d.inputs.map((u) => ({
      txid: u.txid,
      vout: u.vout,
      value: u.value.toString(),
      scriptPubKeyHex: u.scriptPubKeyHex,
      ...(u.address !== undefined ? { address: u.address } : {}),
      ...(u.confirmations !== undefined ? { confirmations: u.confirmations } : {}),
    })),
    recipients: d.recipients.map((r) => ({ address: r.address, value: r.value.toString() })),
    ...(d.change ? { change: { address: d.change.address, value: d.change.value.toString() } } : {}),
    ...(d.necklaceFee
      ? { necklaceFee: { address: d.necklaceFee.address, value: d.necklaceFee.value.toString() } }
      : {}),
    minerFee: d.minerFee.toString(),
  };
}

/** Wire form -> TxDraft (string -> bigint). */
export function fromWireTxDraft(w: WireTxDraft): TxDraft {
  const inputs: Utxo[] = w.inputs.map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: BigInt(u.value),
    scriptPubKeyHex: u.scriptPubKeyHex,
    ...(u.address !== undefined ? { address: u.address } : {}),
    ...(u.confirmations !== undefined ? { confirmations: u.confirmations } : {}),
  }));
  const recipients: TxRecipient[] = w.recipients.map((r) => ({
    address: r.address,
    value: BigInt(r.value),
  }));
  return {
    network: w.network,
    inputs,
    recipients,
    ...(w.change ? { change: { address: w.change.address, value: BigInt(w.change.value) } as TxRecipient } : {}),
    ...(w.necklaceFee
      ? { necklaceFee: { address: w.necklaceFee.address, value: BigInt(w.necklaceFee.value) } as NecklaceFee }
      : {}),
    minerFee: BigInt(w.minerFee),
  };
}
