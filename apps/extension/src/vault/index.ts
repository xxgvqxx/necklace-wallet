/**
 * Vault barrel. Re-exports the public surface used by the background worker
 * and tests. Internal-only helpers (e.g. test resets, backend overrides) are
 * imported directly from their modules.
 */

export * from "./vault-types.js";
export * from "./manager.js";
export {
  setAddressDeriver,
  type AddressDeriver,
  type DerivedIdentity,
  type GeneratedWallet,
} from "./derive.js";
export { setArgon2idFn, type Argon2idFn } from "./kdf.js";
export {
  ensureTrustedAccessLevel,
  hasVault,
  loadVault,
  loadVaultFile,
} from "./storage.js";
export {
  isUnlocked,
  lock,
  onLockStateChange,
  setLockTimeout,
  DEFAULT_LOCK_TIMEOUT_MS,
} from "./session.js";
