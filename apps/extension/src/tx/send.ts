/**
 * Send-flow orchestration.
 *
 * The flow is strictly ordered so a signature is never produced before the user
 * has seen every output (threat-model §1, fee-policy §2):
 *
 *   1. The UI builds a {@link TxPreview} locally (preview.ts) and renders the
 *      ConfirmTransaction screen — recipient, the visible flat Necklace fee, the
 *      network fee, change, and total. NO password is requested yet.
 *   2. Only when the user approves does the UI collect the password and call
 *      {@link confirmAndSend}. The password is passed to the background vault at
 *      SIGN time only; it never touches the network and is not retained here.
 *   3. The vault signs the exact `draft` from the preview and returns the signed
 *      `rawHex` + `txid`. The key never leaves the worker.
 *   4. The UI POSTs only `rawHex` to the broadcast API. A duplicate
 *      (`ALREADY_KNOWN`) is treated as success (idempotent retry).
 *
 * This module performs NO signing itself and holds NO key. The only secret it
 * forwards is the password, straight into the vault call.
 */

import type { SignedTx, TxDraft } from "@necklace/shared";
import { ApiError, getApiClient, isAlreadyKnown, vault } from "../api/index.js";
import type { TxPreview } from "./preview.js";

export interface SendResult {
  /** Transaction id (display hex). */
  txid: string;
  /** True if the node accepted it (or it was already known). */
  accepted: boolean;
  /** True if the tx was already in the mempool/chain (success-equivalent). */
  alreadyKnown: boolean;
}

export type SendOutcome =
  | { ok: true; result: SendResult }
  | { ok: false; stage: "sign" | "broadcast"; error: unknown };

/**
 * Sign the previewed draft via the background vault, then broadcast it.
 *
 * `password` is consumed once and not stored. The caller (Send/Confirm screen)
 * should clear its own password field as soon as this resolves or rejects.
 */
export async function confirmAndSend(
  preview: TxPreview,
  password: string,
): Promise<SendOutcome> {
  // 1) Sign in the background (the key lives only there).
  let signed: SignedTx;
  try {
    signed = await signDraft(preview.draft, password);
  } catch (error) {
    return { ok: false, stage: "sign", error };
  }

  // 2) Broadcast only the signed raw hex. Nothing secret is sent.
  try {
    const res = await getApiClient().broadcast(signed.rawHex);
    return {
      ok: true,
      result: {
        txid: res.txid,
        accepted: res.accepted,
        alreadyKnown: res.alreadyKnown ?? false,
      },
    };
  } catch (error) {
    // A 409 ALREADY_KNOWN is success-equivalent. We computed the txid locally
    // (the vault returns it), so we can still report success.
    if (isAlreadyKnown(error)) {
      return {
        ok: true,
        result: { txid: signed.txid, accepted: true, alreadyKnown: true },
      };
    }
    return { ok: false, stage: "broadcast", error };
  }
}

/**
 * Ask the background vault to sign a draft. Separated so the Confirm screen can
 * sign and broadcast in distinct steps if it wants to show progress.
 */
export async function signDraft(
  draft: TxDraft,
  password: string,
): Promise<SignedTx> {
  return vault.sign(draft, password);
}

/**
 * Retry broadcasting an already-signed tx (idempotent by txid). Safe to call
 * after a NODE_DOWN failure; requires no password and no key.
 */
export async function rebroadcast(signed: SignedTx): Promise<SendResult> {
  try {
    const res = await getApiClient().broadcast(signed.rawHex);
    return {
      txid: res.txid,
      accepted: res.accepted,
      alreadyKnown: res.alreadyKnown ?? false,
    };
  } catch (error) {
    if (isAlreadyKnown(error)) {
      return { txid: signed.txid, accepted: true, alreadyKnown: true };
    }
    if (error instanceof ApiError) throw error;
    throw error;
  }
}
