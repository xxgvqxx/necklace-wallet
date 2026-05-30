/**
 * Necklace flat-fee policy constants and selection (docs/fee-policy.md).
 *
 * NON-NEGOTIABLE (fee-policy §2, §6):
 *   - The Necklace fee is a FLAT PRL amount, not a percentage.
 *   - It is materialised as a SEPARATE, VISIBLE P2TR output paying a pinned,
 *     per-network Necklace address — never skimmed from change, never hidden in
 *     the relay fee, never fetched from the API at runtime.
 *   - It must always clear the dust floor (~546 Grain). If it would be dust, the
 *     build fails closed rather than emitting a dust output.
 *   - The fee line is shown on the ConfirmTransaction screen before signing,
 *     every time, with no way to suppress it.
 *   - Fee amount + address are COMPILE-TIME constants. Changing them requires a
 *     new, reviewable release.
 *
 * The mainnet fee address is PINNED (see FEE_ADDRESS_BY_NETWORK). Networks with
 * no pinned address (`null`) fail closed — building a send there THROWS rather
 * than emitting a placeholder (fee-policy §5). Necklace ships mainnet-only
 * (`ACTIVE_NETWORK = mainnet`); the regtest address is a dev/test fixture only.
 */

import {
  DUST_THRESHOLD_GRAIN,
  GRAIN_PER_PRL,
  type Grain,
  type NecklaceFee,
  type Network,
} from "@necklace/shared";

/**
 * The flat Necklace fee, in Grain: 0.1 PRL per transaction. Materialised as a
 * separate, visible P2TR output to the pinned per-network fee address and shown
 * on the confirm screen before signing. Well above the dust floor.
 */
export const FLAT_FEE_GRAIN: Grain = GRAIN_PER_PRL / 10n; // 0.1 PRL

/**
 * Pinned per-network Necklace fee addresses. `null` = NOT pinned for that
 * network (must be set before any release on that network — fee-policy §5).
 * Each must be a valid witness-v1 (P2TR) bech32m address whose HRP matches the
 * network.
 *
 * The regtest address below is a valid `rprl` v1 P2TR used only for the dev
 * workflow; it is NOT a real treasury address. It is deterministically derived
 * by wallet-core `deriveAddress` from the dev key 0x07..07 (BIP-86 P2TR), so it
 * round-trips and passes address validation; it is not spendable by anyone in
 * particular and exists only so the regtest send path has a valid fee output.
 */
export const FEE_ADDRESS_BY_NETWORK: Record<Network, string | null> = {
  // Necklace mainnet fee-collection address (valid prl P2TR, verified).
  mainnet: "prl1pl0c9aqvmvhm4ml8nrc7s0cezrgx3el67nwxeywpjcwl6a696hp6s5p8jhf",
  testnet: null,
  testnet2: null,
  // Dead at runtime in the mainnet-only build (ACTIVE_NETWORK = mainnet); kept
  // only so the fee-output unit tests have a valid address to exercise.
  regtest:
    "rprl1pw53jtgez0wf69n06fchp0ctk48620zdscnrj8heh86wykp9mv20qdcu0t8",
  simnet: null,
  signet: null,
};

/** Thrown when the fee policy cannot be satisfied (fail-closed). */
export class FeePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FeePolicyError";
  }
}

/**
 * Resolve the visible flat Necklace fee for a network, failing closed if the
 * address is unpinned or the amount would be at/below dust. The returned object
 * is materialised as a real, visible tx output and itemised on the confirm
 * screen.
 */
export function requireNecklaceFee(network: Network): NecklaceFee {
  const address = FEE_ADDRESS_BY_NETWORK[network];
  if (!address) {
    throw new FeePolicyError(
      `Necklace fee address is not configured for ${network}. ` +
        `Refusing to build a send (fee-policy §5 forbids placeholder/missing fee).`,
    );
  }
  if (FLAT_FEE_GRAIN < DUST_THRESHOLD_GRAIN) {
    throw new FeePolicyError(
      `Configured flat fee (${FLAT_FEE_GRAIN} Grain) is below the dust floor. ` +
        `Refusing to emit a dust fee output (fee-policy §2).`,
    );
  }
  return { address, value: FLAT_FEE_GRAIN };
}

/** True if a fee address is pinned for the network (UI can disable Send otherwise). */
export function isFeeConfigured(network: Network): boolean {
  return FEE_ADDRESS_BY_NETWORK[network] !== null;
}
