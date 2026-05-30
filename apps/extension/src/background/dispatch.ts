/**
 * Pure message dispatcher for the background worker.
 *
 * Maps a `VaultRequest` (the single, `@necklace/shared`-typed protocol — see
 * `api/vault-protocol.ts`, re-exported by `messages.ts`) to a `VaultResponse` by
 * calling the vault manager. Kept free of any `chrome.*` runtime API so it is
 * unit-testable in a plain node environment (`service-worker.ts` does the
 * `chrome.runtime` wiring).
 *
 * BOUNDARY MAPPING
 *  - The UI never sends a `chain`. The build's `ACTIVE_NETWORK` -> `VaultChain`
 *    mapping (`chainForActiveNetwork`) chooses where the vault is stored; the
 *    precise `Network` to derive/sign with is `resolveNetwork(chain)`.
 *  - The UI's `password` is the manager's `passphrase` argument, renamed here.
 *  - `VaultState.address` is produced as a `DerivedAddress` by decoding the
 *    stored bech32m via wallet-core (`toDerivedAddress`).
 *
 * SECURITY
 *  - Errors are normalized to typed `{ code, message }` via `toVaultError`; we
 *    NEVER include passphrases, secrets, or KDF/cipher internals in an error.
 *  - XMSS signing is hard-sealed by omission: the unified protocol offers no
 *    XMSS sign request, so the OTS index is never advanced in-browser
 *    (protocol-findings.md §5).
 *  - Nothing here logs the request payload (it can contain a password/secret).
 */

import {
  addAccount,
  deleteVault,
  generateNewWallet,
  getStatus,
  importSecret,
  lockVault,
  removeAccount,
  renameAccount,
  revealSecretWithPassword,
  signDraft,
  switchAccount,
  unlock,
  type VaultStatus,
} from "../vault/manager.js";
import {
  chainForActiveNetwork,
  parseImport,
  resolveNetwork,
  toDerivedAddress,
} from "../vault/wallet-core-adapter.js";
import { toVaultError } from "../vault/errors.js";
import {
  ensureRehydrated,
  getLockTimeout,
  setAndPersistLockTimeout,
} from "../vault/session.js";
import { ACTIVE_NETWORK } from "../api/config.js";
import { fromWireTxDraft } from "../api/tx-wire.js";
import type { VaultRequest, VaultResponse, VaultState } from "./messages.js";

/**
 * Build the UI-facing `VaultState` from the manager's `VaultStatus`, decoding
 * the stored address into a `DerivedAddress` and reporting the precise network.
 */
function toVaultState(status: VaultStatus): VaultState {
  const network = status.chain ? resolveNetwork(status.chain) : ACTIVE_NETWORK;
  const base: VaultState = {
    hasVault: status.hasVault,
    locked: status.locked,
    network,
    networkMismatch:
      status.hasVault && status.chain !== undefined
        ? status.chain !== chainForActiveNetwork()
        : false,
    lockTimeoutMs: getLockTimeout(),
    ...(status.watchOnly !== undefined ? { watchOnly: status.watchOnly } : {}),
    ...(status.activeAccountId !== undefined
      ? { activeAccountId: status.activeAccountId }
      : {}),
  };
  if (status.address) {
    base.address = toDerivedAddress(status.address, network);
  }
  if (status.accounts) {
    base.accounts = status.accounts.map((a) => ({
      id: a.id,
      label: a.label,
      watchOnly: a.watchOnly,
      // Surface the raw bech32m string for the switcher; it is already validated
      // at create/import time. Keep it a plain string (not a DerivedAddress).
      ...(a.address ? { address: a.address } : {}),
    }));
  }
  return base;
}

/**
 * Handle one request and resolve a response. Always resolves (never rejects);
 * failures become `{ type: "ERROR", code, message }`.
 */
export async function handleMessage(
  message: VaultRequest,
): Promise<VaultResponse> {
  try {
    // Restore an unlocked session persisted before a worker eviction, so the
    // user isn't re-prompted on reopen within the auto-lock window.
    await ensureRehydrated();
    switch (message.type) {
      case "PING":
        return { type: "PONG" };

      case "GET_VAULT_STATE": {
        const status = await getStatus();
        return { type: "VAULT_STATE", state: toVaultState(status) };
      }

      case "CREATE_WALLET": {
        const { password, wordCount } = message.payload;
        // wordCount is honored by the wallet-core generator (12 default);
        // the manager generates + persists, returning the backup mnemonic.
        void wordCount;
        const { status, mnemonic } = await generateNewWallet(
          password,
          chainForActiveNetwork(),
        );
        return { type: "WALLET_CREATED", state: toVaultState(status), mnemonic };
      }

      case "IMPORT_WALLET": {
        const { kind, secret, password, mnemonicPassphrase } = message.payload;
        const parsed = parseImport(kind, secret, mnemonicPassphrase);
        const status = await importSecret(password, chainForActiveNetwork(), parsed);
        return { type: "WALLET_IMPORTED", state: toVaultState(status) };
      }

      case "UNLOCK": {
        const status = await unlock(message.password);
        return { type: "UNLOCKED", state: toVaultState(status) };
      }

      case "LOCK":
        return { type: "LOCKED", state: toVaultState(lockVault()) };

      case "RESET_VAULT":
        await deleteVault();
        return { type: "VAULT_RESET" };

      case "SET_LOCK_TIMEOUT": {
        await setAndPersistLockTimeout(message.ms);
        return { type: "VAULT_STATE", state: toVaultState(await getStatus()) };
      }

      case "SIGN_TX": {
        const network = resolveNetwork(chainForActiveNetwork());
        const draft = fromWireTxDraft(message.draft);
        const signed = await signDraft(message.password, draft, network);
        return { type: "SIGNED_TX", signed };
      }

      case "REVEAL_SECRET": {
        const secret = await revealSecretWithPassword(message.password);
        return { type: "SECRET", secret };
      }

      case "ADD_ACCOUNT": {
        const p = message.payload;
        if (p.mode === "generate") {
          const { status, mnemonic } = await addAccount({
            mode: "generate",
            ...(p.label !== undefined ? { label: p.label } : {}),
            ...(p.password !== undefined ? { password: p.password } : {}),
          });
          return { type: "ACCOUNT_ADDED", state: toVaultState(status), mnemonic };
        }
        const parsed = parseImport(p.kind, p.secret, p.mnemonicPassphrase);
        const { status, mnemonic } = await addAccount({
          mode: "import",
          secret: parsed,
          ...(p.label !== undefined ? { label: p.label } : {}),
          ...(p.password !== undefined ? { password: p.password } : {}),
        });
        return { type: "ACCOUNT_ADDED", state: toVaultState(status), mnemonic };
      }

      case "SWITCH_ACCOUNT": {
        const status = await switchAccount(message.id);
        return { type: "ACCOUNTS_CHANGED", state: toVaultState(status) };
      }

      case "RENAME_ACCOUNT": {
        const status = await renameAccount(message.id, message.label);
        return { type: "ACCOUNTS_CHANGED", state: toVaultState(status) };
      }

      case "REMOVE_ACCOUNT": {
        const status = await removeAccount(message.id);
        return { type: "ACCOUNTS_CHANGED", state: toVaultState(status) };
      }

      default: {
        const _never: never = message;
        const { code, message: msg } = toVaultError(
          new Error(`unknown message: ${String((_never as { type?: string }).type)}`),
        );
        return { type: "ERROR", code, message: msg };
      }
    }
  } catch (err) {
    // Typed, secret-free error. `toVaultError` maps to a stable VaultErrorCode.
    const { code, message: msg } = toVaultError(err);
    return { type: "ERROR", code, message: msg };
  }
}
