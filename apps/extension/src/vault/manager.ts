/**
 * Vault manager — the high-level operations the background worker exposes.
 *
 * Ties together KDF (kdf.ts), AEAD (encrypt.ts), persistence (storage.ts),
 * the in-memory unlock session (session.ts) and the address-derivation seam
 * (derive.ts).
 *
 * MULTI-ACCOUNT MODEL
 * -------------------
 * The vault file (vault-types.ts: `VaultFile`, v2) holds many `VaultAccount`s
 * under ONE wallet-level KDF (a single salt). The single password derives ONE
 * AES key that encrypts/decrypts EVERY account's payload (each payload keeps its
 * own random IV). So unlock = 1 KDF + N AES-GCM decrypts, and switching the
 * active account needs NO password. The legacy single-account v1 record is
 * losslessly migrated to a one-account v2 file on load (see storage.ts).
 *
 * Security invariants enforced here:
 *  - The passphrase is used only to derive a non-extractable AES key; it is
 *    never stored and never logged.
 *  - The decrypted secrets live only in the session (memory). `exportSecret`
 *    returns the ACTIVE account's secret to the trusted popup on explicit user
 *    request and never to the network.
 *  - Only the encrypted `VaultFile` is persisted, to `chrome.storage.local`.
 *  - XMSS signing is sealed: the OTS index is never advanced and signing is
 *    refused (see service-worker). Generation only records the public XMSS
 *    commitment.
 */

import {
  deriveIdentity,
  generateWallet,
  type DerivedIdentity,
} from "./derive.js";
import { decryptSecret, encryptSecret } from "./encrypt.js";
import {
  defaultPbkdf2Params,
  deriveAesKey,
  generateSalt,
} from "./kdf.js";
import {
  deleteVault as storageDeleteVault,
  loadVaultFile,
  randomId,
  saveVaultFile,
  updateVaultAtomic,
} from "./storage.js";
import {
  addSessionAccount,
  getActiveAccountId,
  isUnlocked,
  lock,
  removeSessionAccount,
  requireKey,
  requireSecret,
  setActiveAccount,
  startSession,
  type SessionAccount,
} from "./session.js";
import {
  VAULT_FILE_VERSION,
  XMSS_MAX_SIGNATURES,
  XMSS_SCHEME,
  type DecryptedSecret,
  type EncryptedPayload,
  type KdfParams,
  type VaultAccount,
  type VaultChain,
  type VaultFile,
  type XmssCommitmentState,
} from "./vault-types.js";
import {
  LockedError,
  NoVaultError,
  VaultExistsError,
  WatchOnlyError,
  WrongPasswordError,
} from "./errors.js";
import { signTransactionDraft } from "./signer.js";
import type { Network, SignedTx, TxDraft } from "@necklace/shared";

/** Public, non-secret summary of one account for the UI. */
export interface AccountSummary {
  id: string;
  label: string;
  address: string;
  watchOnly: boolean;
}

/** Public, non-secret summary of vault state for the UI. */
export interface VaultStatus {
  hasVault: boolean;
  locked: boolean;
  /** Active account's chain. */
  chain?: VaultChain;
  /** Active account's receive address. */
  address?: string;
  /** Active account is watch-only. */
  watchOnly?: boolean;
  /** XMSS commitment present + always sealed in the MVP (active account). */
  xmssSealed?: boolean;
  /** Every account (id, label, address, watchOnly). */
  accounts?: AccountSummary[];
  /** id of the active account. */
  activeAccountId?: string;
}

/** Build the sealed XMSS commitment state recorded on full-key accounts. */
function sealedXmssState(commitmentHex?: string): XmssCommitmentState {
  return {
    scheme: XMSS_SCHEME,
    maxSignatures: XMSS_MAX_SIGNATURES,
    nextOtsIndex: 0,
    signingSealed: true,
    ...(commitmentHex ? { commitmentHex } : {}),
  };
}

function isWatchOnly(secret: DecryptedSecret): boolean {
  return secret.kind === "watch-only-xpub";
}

/** Assemble a fresh `VaultAccount` from a derived identity + an encrypted payload. */
function makeAccount(
  id: string,
  label: string,
  chain: VaultChain,
  secret: DecryptedSecret,
  identity: DerivedIdentity,
  payload: EncryptedPayload,
): VaultAccount {
  const now = Date.now();
  const watchOnly = isWatchOnly(secret);
  return {
    id,
    label,
    chain,
    address: identity.address,
    ...(identity.publicKeyHex ? { publicKeyHex: identity.publicKeyHex } : {}),
    secretKind: secret.kind,
    watchOnly,
    payload,
    ...(watchOnly ? {} : { xmss: sealedXmssState(identity.xmssCommitmentHex) }),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Create the FIRST vault file (no vault exists yet): a fresh wallet-level KDF +
 * a single "Account 1", then enter an unlocked session. Used by the first-time
 * create/import path.
 */
async function createFirstAccount(
  passphrase: string,
  chain: VaultChain,
  secret: DecryptedSecret,
  identity: DerivedIdentity,
): Promise<VaultFile> {
  if (await loadVaultFile()) {
    throw new VaultExistsError(
      "a vault already exists; add an account instead of creating a new one",
    );
  }
  const salt = generateSalt();
  const kdfParams: KdfParams = defaultPbkdf2Params(salt);
  const key = await deriveAesKey(passphrase, kdfParams);
  const payload = await encryptSecret(key, secret);
  const id = randomId();
  const account = makeAccount(id, "Account 1", chain, secret, identity, payload);
  const file: VaultFile = {
    version: VAULT_FILE_VERSION,
    activeAccountId: id,
    kdfParams,
    accounts: [account],
  };
  await saveVaultFile(file);
  // Immediately enter an unlocked session so the user can act without re-typing.
  startSession([{ id, secret, address: account.address }], id, key);
  return file;
}

/**
 * Import an existing secret (WIF/raw-hex private key, mnemonic, or watch-only
 * xpub) as the FIRST wallet (first-run onboarding). Returns the public status.
 */
export async function importSecret(
  passphrase: string,
  chain: VaultChain,
  secret: DecryptedSecret,
): Promise<VaultStatus> {
  requireStrongPassphrase(passphrase);
  const identity = await deriveIdentity(secret, chain);
  const file = await createFirstAccount(passphrase, chain, secret, identity);
  return statusFromFile(file, /* locked */ false);
}

/** Result of generating a wallet: the public status plus the backup string. */
export interface GenerateResult {
  status: VaultStatus;
  /** The mnemonic to show ONCE for backup (raw privkey hex if generated as one). */
  mnemonic: string;
}

/**
 * Generate a brand-new wallet in-browser as the FIRST wallet (first-run
 * onboarding) and create the vault file. Returns the backup string (mnemonic) so
 * the UI can show it ONCE; it is never persisted in the clear and the UI
 * discards it after the user confirms backup.
 */
export async function generateNewWallet(
  passphrase: string,
  chain: VaultChain,
): Promise<GenerateResult> {
  requireStrongPassphrase(passphrase);
  const { secret, identity } = await generateWallet(chain);
  const file = await createFirstAccount(passphrase, chain, secret, identity);
  const mnemonic = backupStringFor(secret);
  return { status: statusFromFile(file, /* locked */ false), mnemonic };
}

/** Describes a new account to add to an already-unlocked vault. */
export type AddAccountSpec =
  | { mode: "generate"; label?: string }
  | { mode: "import"; label?: string; secret: DecryptedSecret };

/**
 * Add a new account to an ALREADY-UNLOCKED vault. No password is needed: the
 * in-memory wallet key (from unlock) re-encrypts the new account's secret. The
 * new account is appended, persisted, added to the session map, and made active.
 *
 * Generation returns the backup mnemonic (shown once). Import returns no
 * mnemonic.
 *
 * Requires the wallet to be unlocked AND the in-memory key to be available
 * (a rehydrated session has key=null — the UI must re-unlock first).
 */
export async function addAccount(
  spec: AddAccountSpec,
): Promise<GenerateResult> {
  if (!isUnlocked()) throw new LockedError("wallet is locked");
  const file = await loadVaultFile();
  if (!file) throw new NoVaultError("no vault to add an account to");
  // The in-memory wallet key re-encrypts the new secret. A session rehydrated
  // after worker eviction carries no key (it cannot be serialized); the UI must
  // re-unlock (re-enter the password) before adding an account.
  let key: CryptoKey;
  try {
    key = requireKey();
  } catch {
    throw new LockedError("re-enter your password to add an account");
  }

  const chain = file.accounts[0]?.chain ?? "pearl-mainnet";

  let secret: DecryptedSecret;
  let identity: DerivedIdentity;
  let mnemonic = "";
  if (spec.mode === "generate") {
    const gen = await generateWallet(chain);
    secret = gen.secret;
    identity = gen.identity;
    mnemonic = backupStringFor(secret);
  } else {
    secret = spec.secret;
    identity = await deriveIdentity(secret, chain);
  }

  const payload = await encryptSecret(key, secret);
  const id = randomId();
  const label = spec.label?.trim() || nextDefaultLabel(file.accounts);
  const account = makeAccount(id, label, chain, secret, identity, payload);

  const updated = await updateVaultAtomic((cur) => {
    if (!cur) throw new NoVaultError("vault disappeared while adding an account");
    return {
      ...cur,
      accounts: [...cur.accounts, account],
      activeAccountId: id,
    };
  });
  if (!updated) throw new Error("add account failed");

  // Add to the unlocked session and switch active to it.
  addSessionAccount({ id, secret, address: account.address }, /* makeActive */ true);

  return {
    status: statusFromFile(updated, /* locked */ false),
    mnemonic,
  };
}

/** Switch the active account (no password). Persists + updates the session. */
export async function switchAccount(id: string): Promise<VaultStatus> {
  const file = await loadVaultFile();
  if (!file) throw new NoVaultError("no vault");
  if (!file.accounts.some((a) => a.id === id)) {
    throw new NoVaultError("no such account");
  }
  const updated = await updateVaultAtomic((cur) => {
    if (!cur) throw new NoVaultError("vault disappeared while switching accounts");
    if (!cur.accounts.some((a) => a.id === id)) {
      throw new NoVaultError("no such account");
    }
    return { ...cur, activeAccountId: id };
  });
  if (!updated) throw new Error("switch account failed");
  if (isUnlocked()) setActiveAccount(id);
  return statusFromFile(updated, !isUnlocked());
}

/** Rename an account. Persists. No password. */
export async function renameAccount(id: string, label: string): Promise<VaultStatus> {
  const trimmed = label.trim();
  if (trimmed.length === 0) throw new Error("label must not be empty");
  const updated = await updateVaultAtomic((cur) => {
    if (!cur) throw new NoVaultError("no vault");
    if (!cur.accounts.some((a) => a.id === id)) throw new NoVaultError("no such account");
    return {
      ...cur,
      accounts: cur.accounts.map((a) =>
        a.id === id ? { ...a, label: trimmed, updatedAt: Date.now() } : a,
      ),
    };
  });
  if (!updated) throw new Error("rename failed");
  return statusFromFile(updated, !isUnlocked());
}

/**
 * Remove an account. MUST keep >= 1 account (rejects removing the last). If the
 * removed account is active, switches active to another account. Drops it from
 * the unlocked session map too.
 */
export async function removeAccount(id: string): Promise<VaultStatus> {
  const file = await loadVaultFile();
  if (!file) throw new NoVaultError("no vault");
  if (!file.accounts.some((a) => a.id === id)) throw new NoVaultError("no such account");
  if (file.accounts.length <= 1) {
    throw new VaultExistsError("cannot remove the last account; reset the wallet instead");
  }

  let nextActiveId = file.activeAccountId;
  const updated = await updateVaultAtomic((cur) => {
    if (!cur) throw new NoVaultError("vault disappeared while removing an account");
    const remaining = cur.accounts.filter((a) => a.id !== id);
    if (remaining.length === 0) {
      throw new VaultExistsError("cannot remove the last account; reset the wallet instead");
    }
    nextActiveId =
      cur.activeAccountId === id ? (remaining[0] as VaultAccount).id : cur.activeAccountId;
    return { ...cur, accounts: remaining, activeAccountId: nextActiveId };
  });
  if (!updated) throw new Error("remove failed");

  if (isUnlocked()) removeSessionAccount(id, nextActiveId);
  return statusFromFile(updated, !isUnlocked());
}

/** The displayable backup string for a secret (mnemonic / privkey hex / xpub). */
function backupStringFor(secret: DecryptedSecret): string {
  switch (secret.kind) {
    case "bip39-mnemonic":
      return secret.mnemonic;
    case "secp256k1-privkey":
      return secret.privateKeyHex;
    case "watch-only-xpub":
      return secret.xpub;
  }
}

/** Pick a default label like "Account N" for the next account. */
function nextDefaultLabel(accounts: readonly VaultAccount[]): string {
  return `Account ${accounts.length + 1}`;
}

/**
 * Decrypt a payload, normalizing the opaque cipher failure into a typed
 * `WrongPasswordError` (a wrong passphrase and a tampered ciphertext are
 * intentionally indistinguishable — GCM auth fails either way).
 */
async function decryptOrThrow(
  key: CryptoKey,
  payload: EncryptedPayload,
): Promise<DecryptedSecret> {
  try {
    return await decryptSecret(key, payload);
  } catch (err) {
    throw new WrongPasswordError(
      err instanceof Error ? err.message : "wrong password or corrupt vault",
    );
  }
}

/**
 * Unlock the vault: derive the ONE wallet key, decrypt EVERY account payload
 * into the session map, mark the file's active account, start the session.
 */
export async function unlock(passphrase: string): Promise<VaultStatus> {
  const file = await loadVaultFile();
  if (!file) throw new NoVaultError("no vault to unlock");
  const key = await deriveAesKey(passphrase, file.kdfParams);

  const accounts: SessionAccount[] = [];
  for (const a of file.accounts) {
    const secret = await decryptOrThrow(key, a.payload);
    accounts.push({ id: a.id, secret, address: a.address });
  }
  startSession(accounts, file.activeAccountId, key);
  return statusFromFile(file, /* locked */ false);
}

/** Find the active account in a file (falls back to the first). */
function activeAccount(file: VaultFile): VaultAccount {
  return (
    file.accounts.find((a) => a.id === file.activeAccountId) ??
    (file.accounts[0] as VaultAccount)
  );
}

/**
 * Sign a fully-described, user-approved draft for the ACTIVE account.
 *
 * DEFENSE-IN-DEPTH: re-derives the AES key from the password supplied AT SIGN
 * TIME and decrypts the active account's secret independently of the unlocked
 * session ("password only at sign time"). Rejects watch-only accounts.
 */
export async function signDraft(
  password: string,
  draft: TxDraft,
  network: Network,
): Promise<SignedTx> {
  const file = await loadVaultFile();
  if (!file) throw new NoVaultError("no vault to sign with");
  const account = activeAccount(file);
  if (account.watchOnly) {
    throw new WatchOnlyError("watch-only account cannot sign");
  }
  const key = await deriveAesKey(password, file.kdfParams);
  const secret = await decryptOrThrow(key, account.payload);
  if (secret.kind === "watch-only-xpub") {
    throw new WatchOnlyError("watch-only account cannot sign");
  }
  return signTransactionDraft({ draft, secret, network });
}

/** Lock the wallet (zero in-memory secrets). */
export function lockVault(): VaultStatus {
  lock();
  return { hasVault: true, locked: true };
}

/**
 * Export the ACTIVE account's decrypted secret to the (trusted) caller. Requires
 * an unlocked session. This is the explicit "reveal my key/recovery phrase"
 * action; the result MUST stay in the trusted popup and is NEVER sent anywhere.
 */
export function exportSecret(): DecryptedSecret {
  if (!isUnlocked()) throw new LockedError("wallet is locked");
  return requireSecret();
}

/**
 * Reveal the ACTIVE account's recovery secret for backup, re-deriving the key
 * from the password supplied at reveal time (independent of the session, like
 * signDraft). The result MUST stay in the trusted popup and is NEVER sent to the
 * network or logged.
 */
export async function revealSecretWithPassword(password: string): Promise<string> {
  const file = await loadVaultFile();
  if (!file) throw new NoVaultError("no vault");
  const account = activeAccount(file);
  const key = await deriveAesKey(password, file.kdfParams);
  const secret = await decryptOrThrow(key, account.payload);
  return backupStringFor(secret);
}

/**
 * Change the passphrase: re-derive a new wallet key under a fresh salt and
 * RE-ENCRYPT EVERY account payload with it (fresh IV per account). Requires the
 * correct current passphrase as a second factor (verified by decrypting).
 */
export async function changePassword(
  currentPassphrase: string,
  newPassphrase: string,
): Promise<VaultStatus> {
  requireStrongPassphrase(newPassphrase);
  const file = await loadVaultFile();
  if (!file) throw new NoVaultError("no vault");

  // Verify current passphrase by decrypting every account (independent of session).
  const currentKey = await deriveAesKey(currentPassphrase, file.kdfParams);
  const decrypted: { id: string; secret: DecryptedSecret; address: string }[] = [];
  for (const a of file.accounts) {
    decrypted.push({
      id: a.id,
      secret: await decryptOrThrow(currentKey, a.payload),
      address: a.address,
    });
  }

  // Re-derive under a fresh salt and re-encrypt every payload.
  const salt = generateSalt();
  const kdfParams = defaultPbkdf2Params(salt);
  const newKey = await deriveAesKey(newPassphrase, kdfParams);
  const reencrypted = new Map<string, EncryptedPayload>();
  for (const d of decrypted) {
    reencrypted.set(d.id, await encryptSecret(newKey, d.secret));
  }

  const updated = await updateVaultAtomic((cur) => {
    if (!cur) throw new Error("vault disappeared during password change");
    return {
      ...cur,
      kdfParams,
      accounts: cur.accounts.map((a) => {
        const p = reencrypted.get(a.id);
        return p ? { ...a, payload: p, updatedAt: Date.now() } : a;
      }),
    };
  });
  if (!updated) throw new Error("password change failed");

  // Refresh the session: rebuild with the new key if currently unlocked.
  if (isUnlocked()) {
    startSession(decrypted, getActiveAccountId() ?? updated.activeAccountId, newKey);
  }
  return statusFromFile(updated, !isUnlocked());
}

/** Permanently delete the ENTIRE vault (all accounts) and lock. */
export async function deleteVault(): Promise<VaultStatus> {
  lock();
  await storageDeleteVault();
  return { hasVault: false, locked: true };
}

/** Read the public vault status without unlocking. */
export async function getStatus(): Promise<VaultStatus> {
  const file = await loadVaultFile();
  if (!file) return { hasVault: false, locked: true };
  return statusFromFile(file, !isUnlocked());
}

/**
 * Get the in-memory derived AES key (for re-encrypt flows). Exposed for the
 * worker; throws if locked. Never returns raw key bytes (the key is
 * non-extractable).
 */
export function getSessionKey(): CryptoKey {
  return requireKey();
}

function statusFromFile(file: VaultFile, locked: boolean): VaultStatus {
  const account = activeAccount(file);
  return {
    hasVault: true,
    locked,
    chain: account.chain,
    address: account.address,
    watchOnly: account.watchOnly,
    xmssSealed: account.xmss ? account.xmss.signingSealed : undefined,
    activeAccountId: file.activeAccountId,
    accounts: file.accounts.map((a) => ({
      id: a.id,
      label: a.label,
      address: a.address,
      watchOnly: a.watchOnly,
    })),
  };
}

/**
 * Minimal passphrase strength gate. The real strength bar is the high-iteration
 * KDF; this just refuses trivially empty / too-short passphrases so a vault is
 * never created with an effectively-null key.
 */
function requireStrongPassphrase(passphrase: string): void {
  if (typeof passphrase !== "string" || passphrase.length < 8) {
    throw new Error("passphrase must be at least 8 characters");
  }
}
