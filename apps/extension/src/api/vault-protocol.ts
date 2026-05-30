/**
 * The message protocol between the UI (popup/pages) and the background service
 * worker, from the UI's point of view.
 *
 * ARCHITECTURE / OWNERSHIP NOTE
 * -----------------------------
 * The background service worker and `src/background/messages.ts` are owned by
 * the vault/background agents. This file is the UI-side contract describing the
 * messages this UI sends and the responses it expects the vault to return. The
 * vault agent must implement handlers for every `VaultRequest.type` below.
 *
 * SECURITY INVARIANTS (threat-model §0, §3):
 *   - The decrypted private key lives ONLY in the background worker's memory,
 *     and only while unlocked. It is never returned to the UI, never persisted
 *     in plaintext, never logged, and never sent to the network.
 *   - The PASSWORD is sent to the background worker ONLY at the moment of
 *     unlock/sign (it must cross the port boundary to decrypt the vault), and
 *     the worker must zero it after use. It is NEVER sent to the network and
 *     NEVER stored. The UI keeps it in a variable only long enough to post it.
 *   - SIGNING happens in the background (it needs the key). The UI sends a fully
 *     described `TxDraft` (every output, including the visible Necklace fee) and
 *     receives back only the signed `rawHex` + `txid` — never key material.
 *   - The UI must have already displayed every output to the user (the
 *     ConfirmTransaction screen) before issuing SIGN_TX. The worker signs what
 *     it is given; user-intent integrity is the UI's responsibility.
 */

import type {
  DerivedAddress,
  KeyImportKind,
  Network,
  SignedTx,
} from "@necklace/shared";
import type { WireTxDraft } from "./tx-wire.js";

/** A non-secret summary of one account, for the account switcher UI. */
export interface VaultAccountInfo {
  /** Stable opaque account id. */
  id: string;
  /** Human-facing label (e.g. "Account 1"). */
  label: string;
  /** The account's receive address (public). May be absent if undecodable. */
  address?: string;
  /** True if this account is watch-only (cannot sign). */
  watchOnly: boolean;
}

/**
 * High-level vault lifecycle state, mirrored into the UI.
 *
 * MULTI-ACCOUNT: `accounts` lists every account and `activeAccountId` names the
 * active one. The top-level `address`/`watchOnly` fields reflect the ACTIVE
 * account (kept for backwards-compatible single-account consumers).
 */
export interface VaultState {
  /** True once a vault exists in chrome.storage.local. */
  hasVault: boolean;
  /** True when no decrypted key is held in memory. */
  locked: boolean;
  /** The active network this build/vault targets. */
  network: Network;
  /** The ACTIVE account's receive address, if a vault exists (public). */
  address?: DerivedAddress;
  /** True if the ACTIVE account is watch-only (xpub/address import; cannot sign). */
  watchOnly?: boolean;
  /**
   * True if the stored vault was created on a different network than this
   * (mainnet-only) build — e.g. a leftover regtest wallet. The UI surfaces a
   * reset affordance instead of silently showing a wrong-network address.
   */
  networkMismatch?: boolean;
  /** Current auto-lock timeout in ms (so Settings can show the active value). */
  lockTimeoutMs?: number;
  /** Every account in the wallet (id, label, address, watchOnly). */
  accounts?: VaultAccountInfo[];
  /** id of the active account. */
  activeAccountId?: string;
}

/** Payload to create a wallet from imported key material. */
export interface ImportPayload {
  kind: KeyImportKind;
  /** The secret/material the user supplied (WIF, raw hex, mnemonic, or xpub). */
  secret: string;
  /** Encryption password chosen by the user. */
  password: string;
  /** For mnemonic imports, an optional BIP-39 passphrase. */
  mnemonicPassphrase?: string;
}

/** Payload to generate a brand-new wallet in the background. */
export interface CreatePayload {
  password: string;
  /**
   * Number of mnemonic words to generate (12 or 24). Generation happens in the
   * background; the UI shows the returned mnemonic for backup, then discards it.
   */
  wordCount?: 12 | 24;
}

/**
 * Payload to ADD a new account to an already-unlocked vault. No password is
 * needed — the in-memory wallet key (from unlock) re-encrypts the new secret.
 * Reuses the create/import shapes minus the password.
 *
 *  - `mode: "generate"` -> generates a fresh mnemonic (returned once for backup)
 *  - `mode: "import"`   -> imports WIF / raw hex / mnemonic / xpub (no mnemonic
 *    returned)
 */
export type AddAccountPayload =
  | { mode: "generate"; label?: string; wordCount?: 12 | 24 }
  | {
      mode: "import";
      label?: string;
      kind: KeyImportKind;
      secret: string;
      mnemonicPassphrase?: string;
    };

/** Messages the UI sends to the background worker. */
export type VaultRequest =
  | { type: "PING" }
  | { type: "GET_VAULT_STATE" }
  | { type: "CREATE_WALLET"; payload: CreatePayload }
  | { type: "IMPORT_WALLET"; payload: ImportPayload }
  | { type: "UNLOCK"; password: string }
  | { type: "LOCK" }
  | { type: "RESET_VAULT" }
  /** Set the auto-lock inactivity timeout (ms); persisted. */
  | { type: "SET_LOCK_TIMEOUT"; ms: number }
  /**
   * Sign a fully-described draft. Password is supplied here (sign-time only).
   * The draft is the JSON-safe {@link WireTxDraft} (Grain amounts as strings) so
   * it can cross chrome.runtime.sendMessage, which cannot serialize bigint.
   */
  | { type: "SIGN_TX"; draft: WireTxDraft; password: string }
  /** Reveal the active account's mnemonic/secret for backup; requires the password. */
  | { type: "REVEAL_SECRET"; password: string }
  /** Add a new account to the unlocked vault (generate or import). No password. */
  | { type: "ADD_ACCOUNT"; payload: AddAccountPayload }
  /** Switch the active account. No password. */
  | { type: "SWITCH_ACCOUNT"; id: string }
  /** Rename an account. No password. */
  | { type: "RENAME_ACCOUNT"; id: string; label: string }
  /** Remove an account (keeps >= 1; rejects removing the last). No password. */
  | { type: "REMOVE_ACCOUNT"; id: string };

/** Responses the UI expects back from the background worker. */
export type VaultResponse =
  | { type: "PONG" }
  | { type: "VAULT_STATE"; state: VaultState }
  /** Returned after CREATE_WALLET: the mnemonic to back up (shown once). */
  | { type: "WALLET_CREATED"; state: VaultState; mnemonic: string }
  | { type: "WALLET_IMPORTED"; state: VaultState }
  | { type: "UNLOCKED"; state: VaultState }
  | { type: "LOCKED"; state: VaultState }
  | { type: "VAULT_RESET" }
  | { type: "SIGNED_TX"; signed: SignedTx }
  | { type: "SECRET"; secret: string }
  /** Returned after ADD_ACCOUNT(generate): the mnemonic to back up (shown once). */
  | { type: "ACCOUNT_ADDED"; state: VaultState; mnemonic: string }
  /** Returned after SWITCH/RENAME/REMOVE_ACCOUNT: the refreshed state. */
  | { type: "ACCOUNTS_CHANGED"; state: VaultState }
  /** Any failure the worker reports; `code` lets the UI distinguish causes. */
  | { type: "ERROR"; code: VaultErrorCode; message: string };

/** Stable error codes the vault may return. */
export type VaultErrorCode =
  | "WRONG_PASSWORD"
  | "NO_VAULT"
  | "VAULT_EXISTS"
  | "LOCKED"
  | "INVALID_KEY"
  | "WATCH_ONLY"
  | "SIGN_FAILED"
  /** The persisted vault record is structurally corrupt and cannot be parsed. */
  | "CORRUPT_VAULT"
  | "UNKNOWN";

export const MESSAGE_SOURCE = "necklace" as const;
