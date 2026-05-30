/**
 * Transaction-signer seam.
 *
 * Building + Schnorr-signing a Pearl transaction is `@necklace/wallet-core`'s
 * domain. The vault depends on this injectable interface (mirroring `derive.ts`)
 * rather than importing wallet-core directly, so the vault package stays
 * crypto-free and tests can inject a deterministic signer. The worker wires the
 * real implementation at startup via `setTransactionSigner(...)`.
 *
 * SIGN-WHAT-YOU-SEE (security-critical, threat-model §1/§2): the implementation
 * MUST build outputs in the canonical order [recipients…, necklaceFee, change]
 * and, BEFORE releasing any signature, assert that the built transaction's
 * (address,value) output multiset equals the approved `TxDraft` and that
 * Σinputs − Σoutputs equals `draft.minerFee`. Any mismatch must throw
 * (SIGN_FAILED) so a backend lying about a UTXO value can never redirect a
 * payment — it can only produce an invalid signature.
 *
 * This module performs NO crypto and holds NO key. It routes the draft + the
 * already-decrypted controlling key to the injected signer. It never logs the
 * key or the secret.
 */

import type { Network, SignedTx, TxDraft } from "@necklace/shared";
import type { DecryptedSecret } from "./vault-types.js";

/**
 * What the signer needs to sign a draft for a single-key wallet.
 *
 * The signer receives the just-decrypted secret (NOT key bytes) and the precise
 * network, and derives the single controlling key internally. This keeps the
 * vault manager crypto-free (it only routes) and lets tests inject a stub signer
 * that ignores the secret. The signer MUST NOT log or persist the secret.
 */
export interface SignRequest {
  /** The exact, user-approved draft (every output, the miner fee). */
  draft: TxDraft;
  /** The decrypted secret controlling the wallet (single-key MVP). */
  secret: DecryptedSecret;
  /** The precise network to derive/sign for (selects HRP / coin type). */
  network: Network;
}

/** The signing operation wallet-core provides. */
export interface TransactionSigner {
  /** Build + sign the draft, returning the broadcastable raw hex + txid. */
  sign(request: SignRequest): Promise<SignedTx>;
}

let signer: TransactionSigner | null = null;

/** Wire the real (or stub) transaction signer. Called once at worker startup / in tests. */
export function setTransactionSigner(s: TransactionSigner): void {
  signer = s;
}

function getSigner(): TransactionSigner {
  if (!signer) {
    throw new Error(
      "transaction signer not configured: wallet-core must be wired via setTransactionSigner()",
    );
  }
  return signer;
}

/** Sign a draft via the injected signer. */
export function signTransactionDraft(request: SignRequest): Promise<SignedTx> {
  return getSigner().sign(request);
}
