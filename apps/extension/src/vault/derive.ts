/**
 * Address-derivation seam.
 *
 * Turning a secret (private key / mnemonic / xpub) into a bech32m P2TR address
 * and x-only public key is the crypto agent's domain (`@necklace/wallet-core`:
 * the audited TS port of Pearl's bech32m + WIF + BIP-86 + Schnorr path, pinned
 * to the repo KATs). That package is still a placeholder, so the vault depends
 * on this injectable interface rather than on wallet-core internals. The
 * background worker wires the real implementation once wallet-core lands; tests
 * inject a deterministic stub.
 *
 * This module performs NO crypto itself — it only routes to the injected
 * deriver. It never logs the secret.
 */

import type { DecryptedSecret, VaultChain } from "./vault-types.js";

/** Output of deriving an address from a secret. */
export interface DerivedIdentity {
  /** Primary bech32m (P2TR, witness v1) receive address. */
  address: string;
  /** Compressed / x-only public key hex. Public. */
  publicKeyHex: string;
  /**
   * Optional deterministic XMSS public commitment hex (HKDF over m/222'). Public,
   * recomputable off-browser. Recording it never requires XMSS signing.
   */
  xmssCommitmentHex?: string;
}

/** Generated material plus its derived identity. */
export interface GeneratedWallet {
  secret: DecryptedSecret;
  identity: DerivedIdentity;
}

/**
 * The crypto operations the vault needs from wallet-core. All pure; no I/O.
 */
export interface AddressDeriver {
  /** Derive address + pubkey for a secret on a given chain. */
  derive(secret: DecryptedSecret, chain: VaultChain): Promise<DerivedIdentity>;
  /**
   * Generate a fresh wallet in-browser. SAFE per protocol-findings: a random
   * secp256k1 key / BIP-39 seed via crypto.getRandomValues, with deterministic
   * BIP-86 address derivation. Generation NEVER signs XMSS (only derives the
   * public commitment), so it is stateless and safe.
   */
  generate(chain: VaultChain): Promise<GeneratedWallet>;
}

let deriver: AddressDeriver | null = null;

/** Wire the real (or stub) deriver. Called once at worker startup / in tests. */
export function setAddressDeriver(d: AddressDeriver): void {
  deriver = d;
}

function getDeriver(): AddressDeriver {
  if (!deriver) {
    throw new Error(
      "address deriver not configured: wallet-core must be wired via setAddressDeriver()",
    );
  }
  return deriver;
}

export function deriveIdentity(
  secret: DecryptedSecret,
  chain: VaultChain,
): Promise<DerivedIdentity> {
  return getDeriver().derive(secret, chain);
}

export function generateWallet(chain: VaultChain): Promise<GeneratedWallet> {
  return getDeriver().generate(chain);
}
