/**
 * Map API UTXO/balance payloads into the internal `@necklace/shared` shapes the
 * tx builder consumes, applying the MVP coin-selection rules locally.
 *
 * Coin selection skips non-P2TR scripts (createtx.go findEligibleOutputs); the
 * MVP signs P2TR key-path only, so a non-P2TR UTXO is unspendable by this
 * wallet and is filtered out here before it can reach the builder.
 */

import type { Utxo } from "@necklace/shared";
import type { ApiUtxo } from "../api/index.js";

/** A P2TR scriptPubKey is `5120` (OP_1 PUSH32) + 32-byte key = 34 bytes hex(68). */
const P2TR_PKSCRIPT_RE = /^5120[0-9a-f]{64}$/i;

/** True if a hex pkScript is a witness-v1 (P2TR) program. */
export function isP2trScript(pkScriptHex: string): boolean {
  return P2TR_PKSCRIPT_RE.test(pkScriptHex);
}

/**
 * Convert API UTXOs to internal `Utxo[]`, keeping only spendable P2TR outputs
 * with at least `minConf` confirmations.
 */
export function toSpendableUtxos(
  apiUtxos: ApiUtxo[],
  opts: { minConf?: number } = {},
): Utxo[] {
  const minConf = opts.minConf ?? 1;
  const out: Utxo[] = [];
  for (const u of apiUtxos) {
    if (!isP2trScript(u.pkScript)) continue;
    if ((u.confirmations ?? 0) < minConf) continue;
    out.push({
      txid: u.txid,
      vout: u.vout,
      value: u.value,
      scriptPubKeyHex: u.pkScript,
      confirmations: u.confirmations,
    });
  }
  return out;
}
