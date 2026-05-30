/**
 * Public surface of the extension's `api/` layer.
 *
 *   - {@link ChainClient}: the chain read/broadcast interface used by the UI.
 *   - {@link BlockbookClient}: ChainClient backed by the public Pearl Blockbook
 *     (the mainnet-only MVP backend).
 *   - {@link ApiClient}: a generic ChainClient for a self-hosted API (retained
 *     for future self-hosting; not wired in the mainnet build).
 *   - {@link vault}: typed message client for the background vault worker.
 *   - schema/error types for both.
 *
 * Nothing here holds or transmits secrets to the network; the only secret that
 * crosses the vault message boundary is the password, at unlock/sign time only.
 */

import { BlockbookClient } from "./blockbook-client.js";
import type { ChainClient } from "./client.js";
import { ACTIVE_NETWORK, CHAIN_BASE_URL } from "./config.js";

export { ApiClient } from "./client.js";
export type { ChainClient } from "./client.js";
export { BlockbookClient } from "./blockbook-client.js";
export { ApiError, humanizeApiError, isAlreadyKnown } from "./errors.js";
export type { ApiErrorKind } from "./errors.js";
export { vault, VaultError } from "./vault-client.js";
export { ACTIVE_NETWORK, API_BASE_URL, CHAIN_BASE_URL } from "./config.js";
export type {
  VaultState,
  VaultRequest,
  VaultResponse,
  VaultErrorCode,
  ImportPayload,
  CreatePayload,
  AddAccountPayload,
  VaultAccountInfo,
} from "./vault-protocol.js";
export * from "./schemas.js";

let singleton: ChainClient | undefined;

/** The shared chain client (Blockbook, mainnet). */
export function getApiClient(): ChainClient {
  if (!singleton) {
    singleton = new BlockbookClient({
      baseUrl: CHAIN_BASE_URL,
      network: ACTIVE_NETWORK,
    });
  }
  return singleton;
}
