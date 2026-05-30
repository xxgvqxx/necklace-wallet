/**
 * Promise-based, typed wrapper around `chrome.runtime.sendMessage` for talking
 * to the background vault worker.
 *
 * The UI never touches the key. It asks the worker to unlock, sign, etc., and
 * receives back only public results (state, signed rawHex, mnemonic-for-backup).
 * Passwords are passed through here straight into a single sendMessage call and
 * not retained by this module.
 *
 * SECURITY: never `console.log` a request or response object from this module —
 * CREATE/IMPORT/UNLOCK/SIGN/REVEAL payloads contain a password and (for
 * create/import/reveal) seed material. The lint rule bans `console.log`, and we
 * deliberately log nothing here.
 */

import type { TxDraft } from "@necklace/shared";
import type { VaultErrorCode, VaultRequest, VaultResponse } from "./vault-protocol.js";
import { toWireTxDraft } from "./tx-wire.js";

/** Thrown when the vault worker returns an ERROR response. */
export class VaultError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = "VaultError";
    this.code = code;
  }
}

/**
 * Sends a typed request to the background worker and resolves with the typed
 * response, throwing a {@link VaultError} on an ERROR response or a transport
 * failure. We do not narrow the response to the request here (the union is
 * small); callers assert the variant they expect.
 */
async function send(request: VaultRequest): Promise<VaultResponse> {
  let response: VaultResponse | undefined;
  try {
    response = (await chrome.runtime.sendMessage(request)) as
      | VaultResponse
      | undefined;
  } catch (cause) {
    // Worker not ready / port closed. Surface as a generic vault error.
    throw new VaultError(
      "UNKNOWN",
      cause instanceof Error ? cause.message : "Background worker unavailable",
    );
  }
  if (!response) {
    throw new VaultError("UNKNOWN", "No response from background worker");
  }
  if (response.type === "ERROR") {
    throw new VaultError(response.code, response.message);
  }
  return response;
}

/** Assert a response is of a particular variant, else throw. */
function expect<T extends VaultResponse["type"]>(
  res: VaultResponse,
  type: T,
): Extract<VaultResponse, { type: T }> {
  if (res.type !== type) {
    throw new VaultError(
      "UNKNOWN",
      `Unexpected response "${res.type}" (wanted "${type}")`,
    );
  }
  return res as Extract<VaultResponse, { type: T }>;
}

export const vault = {
  async ping(): Promise<boolean> {
    const res = await send({ type: "PING" });
    return res.type === "PONG";
  },

  async getState() {
    const res = await send({ type: "GET_VAULT_STATE" });
    return expect(res, "VAULT_STATE").state;
  },

  async create(password: string, wordCount?: 12 | 24) {
    const res = await send({
      type: "CREATE_WALLET",
      payload: { password, wordCount },
    });
    return expect(res, "WALLET_CREATED");
  },

  async import(payload: Extract<VaultRequest, { type: "IMPORT_WALLET" }>["payload"]) {
    const res = await send({ type: "IMPORT_WALLET", payload });
    return expect(res, "WALLET_IMPORTED").state;
  },

  async unlock(password: string) {
    const res = await send({ type: "UNLOCK", password });
    return expect(res, "UNLOCKED").state;
  },

  async lock() {
    const res = await send({ type: "LOCK" });
    return expect(res, "LOCKED").state;
  },

  async reset(): Promise<void> {
    const res = await send({ type: "RESET_VAULT" });
    expect(res, "VAULT_RESET");
  },

  async setLockTimeout(ms: number) {
    const res = await send({ type: "SET_LOCK_TIMEOUT", ms });
    return expect(res, "VAULT_STATE").state;
  },

  async sign(draft: TxDraft, password: string) {
    // Convert bigint Grain amounts to strings: chrome.runtime.sendMessage uses
    // JSON serialization, which cannot represent bigint.
    const res = await send({ type: "SIGN_TX", draft: toWireTxDraft(draft), password });
    return expect(res, "SIGNED_TX").signed;
  },

  async revealSecret(password: string) {
    const res = await send({ type: "REVEAL_SECRET", password });
    return expect(res, "SECRET").secret;
  },

  /**
   * Add an account to the already-unlocked vault. Returns the refreshed state
   * and, for `mode: "generate"`, the backup mnemonic to show once.
   */
  async addAccount(payload: Extract<VaultRequest, { type: "ADD_ACCOUNT" }>["payload"]) {
    const res = await send({ type: "ADD_ACCOUNT", payload });
    return expect(res, "ACCOUNT_ADDED");
  },

  async switchAccount(id: string) {
    const res = await send({ type: "SWITCH_ACCOUNT", id });
    return expect(res, "ACCOUNTS_CHANGED").state;
  },

  async renameAccount(id: string, label: string) {
    const res = await send({ type: "RENAME_ACCOUNT", id, label });
    return expect(res, "ACCOUNTS_CHANGED").state;
  },

  async removeAccount(id: string) {
    const res = await send({ type: "REMOVE_ACCOUNT", id });
    return expect(res, "ACCOUNTS_CHANGED").state;
  },
} as const;
