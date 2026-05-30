/**
 * Build-time chain configuration for the extension.
 *
 * Necklace is MAINNET-ONLY: it reads chain data and broadcasts via the public
 * Pearl Blockbook (Trezor v2 API). Exactly one https host is contacted (the
 * extension's single host_permissions entry + CSP connect-src), pinned here.
 *
 * Sending is fail-closed until a real mainnet Necklace fee address is pinned
 * (see ../tx/fee.ts); we never ship a placeholder mainnet fee address.
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
