/**
 * Typed vault errors.
 *
 * The manager throws these so the background dispatcher can map a failure to a
 * stable `VaultErrorCode` without string-sniffing. The `code` values are exactly
 * the codes the UI protocol (`api/vault-protocol.ts`) understands.
 *
 * SECURITY: error messages here are opaque and secret-free. They never embed a
 * passphrase, a decrypted secret, key bytes, or any request payload. The
 * dispatcher surfaces only `{ code, message }`.
 */

import type { VaultErrorCode } from "../api/vault-protocol.js";

/** A vault operation failure carrying a stable, UI-facing error code. */
export class VaultManagerError extends Error {
  readonly code: VaultErrorCode;
  constructor(code: VaultErrorCode, message: string) {
    super(message);
    this.name = "VaultManagerError";
    this.code = code;
  }
}

/** No vault exists to operate on (unlock / sign / reveal / change-password). */
export class NoVaultError extends VaultManagerError {
  constructor(message = "no vault exists") {
    super("NO_VAULT", message);
    this.name = "NoVaultError";
  }
}

/** A vault already exists; refuse to create/import a second one. */
export class VaultExistsError extends VaultManagerError {
  constructor(message = "a vault already exists; remove it before creating a new one") {
    super("VAULT_EXISTS", message);
    this.name = "VaultExistsError";
  }
}

/** The wallet is locked but the operation needs an unlocked session. */
export class LockedError extends VaultManagerError {
  constructor(message = "wallet is locked") {
    super("LOCKED", message);
    this.name = "LockedError";
  }
}

/** The supplied password did not decrypt the vault (GCM auth failure). */
export class WrongPasswordError extends VaultManagerError {
  constructor(message = "wrong password") {
    super("WRONG_PASSWORD", message);
    this.name = "WrongPasswordError";
  }
}

/** The persisted vault record is structurally corrupt / cannot be parsed. */
export class CorruptVaultError extends VaultManagerError {
  constructor(message = "vault record is corrupt") {
    super("CORRUPT_VAULT", message);
    this.name = "CorruptVaultError";
  }
}

/** The imported key material was invalid (bad WIF / hex / xpub / mnemonic). */
export class InvalidKeyError extends VaultManagerError {
  constructor(message = "invalid key material") {
    super("INVALID_KEY", message);
    this.name = "InvalidKeyError";
  }
}

/** The vault is watch-only and cannot produce a signature. */
export class WatchOnlyError extends VaultManagerError {
  constructor(message = "watch-only vault cannot sign") {
    super("WATCH_ONLY", message);
    this.name = "WatchOnlyError";
  }
}

/** Signing failed (build/sign/serialize, or sign-what-you-see assertion). */
export class SignFailedError extends VaultManagerError {
  constructor(message = "signing failed") {
    super("SIGN_FAILED", message);
    this.name = "SignFailedError";
  }
}

/**
 * Map an arbitrary thrown value to a stable `VaultErrorCode`.
 *
 * Typed `VaultManagerError`s carry their own code. As a defense-in-depth
 * fallback we also recognize the opaque decrypt failure string from
 * `encrypt.ts` (which intentionally does NOT depend on this module) and a few
 * legacy message shapes, so a stray plain `Error` never collapses a
 * wrong-password into a generic `UNKNOWN`.
 *
 * The returned `message` is always secret-free (it is `err.message`, which by
 * construction never contains secrets in this codebase).
 */
export function toVaultError(err: unknown): { code: VaultErrorCode; message: string } {
  if (err instanceof VaultManagerError) {
    return { code: err.code, message: err.message };
  }
  const message = err instanceof Error ? err.message : "vault operation failed";
  const lower = message.toLowerCase();
  // encrypt.ts normalizes wrong-password AND tamper to this single string.
  if (lower.includes("wrong password or corrupt")) {
    return { code: "WRONG_PASSWORD", message };
  }
  if (lower.includes("watch-only")) {
    return { code: "WATCH_ONLY", message };
  }
  if (lower.includes("no vault")) {
    return { code: "NO_VAULT", message };
  }
  if (lower.includes("already exists")) {
    return { code: "VAULT_EXISTS", message };
  }
  if (lower.includes("locked")) {
    return { code: "LOCKED", message };
  }
  return { code: "UNKNOWN", message };
}
