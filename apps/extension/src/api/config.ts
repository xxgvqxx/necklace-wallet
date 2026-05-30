/**
 * Build-time chain configuration for the extension.
 *
 * Necklace is MAINNET-ONLY: it reads chain data and broadcasts via the public
 * Pearl Blockbook (Trezor v2 API). The chain host below is pinned here and in
 * the manifest host_permissions + CSP connect-src (the SafeTrade price feed is
 * the only other pinned host).
 *
 * The mainnet Necklace fee address is pinned in ../tx/fee.ts, so sending is
 * enabled; any network with no pinned fee address fails closed.
 */

import type { Network } from "@necklace/shared";

/** The single chain-data host (mirrors manifest host_permissions). */
export const CHAIN_BASE_URL = "https://blockbook.pearlresearch.ai";

/** Active network. Necklace is mainnet-only. */
export const ACTIVE_NETWORK: Network = "mainnet";

/**
 * @deprecated Alias for {@link CHAIN_BASE_URL}; retained so existing importers
 * keep working.
 */
export const API_BASE_URL = CHAIN_BASE_URL;
