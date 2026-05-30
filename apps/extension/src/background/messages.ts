/**
 * The message protocol between the popup/pages (UI) and the background service
 * worker.
 *
 * SINGLE SOURCE OF TRUTH
 * ----------------------
 * The canonical, `@necklace/shared`-typed protocol lives in
 * `src/api/vault-protocol.ts`. Both the UI (`vault-client.ts`) and the worker
 * (`dispatch.ts`, `service-worker.ts`) import the SAME definitions from here,
 * which simply re-exports that module. The previous, divergent vault-internal
 * union (`GENERATE_WALLET`/`IMPORT_SECRET`/`EXPORT_SECRET`/`VAULT_STATUS`) is
 * gone — the worker now speaks the UI's protocol verbatim.
 *
 * HARD RULE: passphrases and decrypted secrets cross this boundary ONLY between
 * the trusted extension UI (popup/options) and the trusted background worker,
 * both of which run under the strict extension CSP in trusted contexts. They are
 * NEVER forwarded to the network and NEVER logged. The reveal of a secret
 * (`REVEAL_SECRET` -> `SECRET`) is the only message that carries a decrypted
 * secret OUT of the worker, and only on explicit user action.
 */

export type {
  VaultRequest,
  VaultResponse,
  VaultState,
  VaultErrorCode,
  ImportPayload,
  CreatePayload,
  AddAccountPayload,
  VaultAccountInfo,
} from "../api/vault-protocol.js";
export { MESSAGE_SOURCE } from "../api/vault-protocol.js";
