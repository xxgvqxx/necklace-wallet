/**
 * Unlock session (multi-account).
 *
 * Every unlocked account's decrypted secret is held in worker memory while
 * unlocked, keyed by account id, so switching the active account needs no
 * password re-entry. To survive MV3 service-worker eviction (so the user isn't
 * re-prompted on every popup reopen), the whole map is ALSO persisted to
 * `chrome.storage.session` via an injected {@link SessionStore} — RAM-only,
 * trusted-contexts, cleared on browser close. See session-store.ts for the
 * security tradeoff. With no store injected (tests) the session is purely
 * in-memory.
 *
 * The session auto-locks after a configurable inactivity timeout (default 5 min)
 * and on explicit lock; locking zeroes every in-memory secret and clears the
 * persisted copy. The derived AES key is NOT persisted — a rehydrated session
 * carries a null key (nothing in the unlock window needs it; signing re-derives
 * from the sign-time password).
 */

import type { DecryptedSecret } from "./vault-types.js";
import type {
  PersistedAccountSecret,
  PersistedSession,
  SessionStore,
} from "./session-store.js";

/** Default auto-lock timeout: 5 minutes of inactivity. */
export const DEFAULT_LOCK_TIMEOUT_MS = 5 * 60 * 1000;

/** Per-account in-memory entry. */
interface SessionEntry {
  secret: DecryptedSecret;
  /** Address of the account, for sanity checks. */
  address: string;
}

interface SessionState {
  /** All unlocked accounts' secrets, keyed by account id. */
  entries: Map<string, SessionEntry>;
  /** id of the active account; requireSecret/requireAddress operate on it. */
  activeId: string;
  /**
   * Non-extractable AES key from the unlock KDF, when available. Null for a
   * session rehydrated from storage after worker eviction (the key cannot be
   * serialized). Operations that need it (rare) must re-derive from a password.
   */
  key: CryptoKey | null;
  /** Timestamp (ms) the session auto-locks at. */
  lockAt: number;
}

let session: SessionState | null = null;
let lockTimer: ReturnType<typeof setTimeout> | null = null;
let timeoutMs = DEFAULT_LOCK_TIMEOUT_MS;

/** Injected cross-reopen persistence. Null = in-memory only (tests). */
let store: SessionStore | null = null;
/** Memoized rehydration so a respawned worker restores the session exactly once. */
let rehydratePromise: Promise<void> | null = null;

/** Wire the persistence store (worker startup). Pass null to disable. */
export function setSessionStore(s: SessionStore | null): void {
  store = s;
}

/** Listeners notified whenever lock state changes (e.g. to refresh UI). */
type LockListener = (locked: boolean) => void;
const lockListeners = new Set<LockListener>();

/** Subscribe to lock-state changes. Returns an unsubscribe function. */
export function onLockStateChange(fn: LockListener): () => void {
  lockListeners.add(fn);
  return () => lockListeners.delete(fn);
}

function emitLockState(locked: boolean): void {
  for (const fn of lockListeners) {
    try {
      fn(locked);
    } catch {
      // A listener throwing must never break locking.
    }
  }
}

/** The current auto-lock timeout (ms). */
export function getLockTimeout(): number {
  return timeoutMs;
}

/** Configure the auto-lock timeout. Re-arms (and re-persists) an active session. */
export function setLockTimeout(ms: number): void {
  if (!Number.isFinite(ms) || ms <= 0) throw new Error("lock timeout must be > 0");
  timeoutMs = ms;
  if (session) touchSession();
}

/** Set the timeout AND persist it (so it survives worker restarts). */
export async function setAndPersistLockTimeout(ms: number): Promise<void> {
  setLockTimeout(ms);
  if (store) await store.setTimeoutMs(ms);
}

/** Load the persisted timeout (worker startup); falls back to the default. */
export async function loadPersistedLockTimeout(): Promise<void> {
  if (!store) return;
  try {
    const ms = await store.getTimeoutMs();
    if (ms && ms > 0) {
      timeoutMs = ms;
      if (session) touchSession();
    }
  } catch {
    // keep default
  }
}

/** Whether the wallet is currently unlocked (in-memory secret present). */
export function isUnlocked(): boolean {
  return session !== null;
}

/** One account's unlocked material, as handed to {@link startSession}. */
export interface SessionAccount {
  id: string;
  secret: DecryptedSecret;
  address: string;
}

/**
 * Start an unlocked session holding EVERY account's decrypted secret. Replaces
 * any existing session (zeroing the old secrets first), arms the auto-lock
 * timer, and persists the session so it survives worker eviction within the
 * unlock window.
 *
 * @param accounts every unlocked account (id + secret + address).
 * @param activeId the id to mark active; must be present in `accounts`.
 * @param key the in-memory wallet key (null for a rehydrated session).
 */
export function startSession(
  accounts: readonly SessionAccount[],
  activeId: string,
  key: CryptoKey | null,
): void {
  if (session) zeroAll(session.entries);
  if (accounts.length === 0) throw new Error("cannot start a session with no accounts");
  const entries = new Map<string, SessionEntry>();
  for (const a of accounts) {
    // Own a private copy so zeroing on lock never mutates the caller's object.
    entries.set(a.id, { secret: cloneSecret(a.secret), address: a.address });
  }
  const active = entries.has(activeId) ? activeId : (accounts[0] as SessionAccount).id;
  session = {
    entries,
    activeId: active,
    key,
    lockAt: Date.now() + timeoutMs,
  };
  armTimer();
  void persistCurrent();
  emitLockState(false);
}

/** Persist the current session to the store (fire-and-forget). */
async function persistCurrent(): Promise<void> {
  if (!store || !session) return;
  try {
    const accounts: PersistedAccountSecret[] = [];
    for (const [id, entry] of session.entries) {
      accounts.push({ id, secret: cloneSecret(entry.secret), address: entry.address });
    }
    await store.setSession({
      accounts,
      activeId: session.activeId,
      expiresAt: session.lockAt,
    });
  } catch {
    // Persistence is best-effort; failing only means a reopen re-prompts.
  }
}

/** Zero every secret in a session map (best-effort wipe). */
function zeroAll(entries: Map<string, SessionEntry>): void {
  for (const entry of entries.values()) zeroSecret(entry.secret);
}

/** The active account id, or null if locked. */
export function getActiveAccountId(): string | null {
  return session ? session.activeId : null;
}

/**
 * Set the active account in the in-memory session (no password) and re-persist.
 * Throws if locked or the id is not unlocked in this session.
 */
export function setActiveAccount(id: string): void {
  if (!session) throw new Error("wallet is locked");
  if (!session.entries.has(id)) {
    throw new Error("account is not in the unlocked session");
  }
  session.activeId = id;
  touchSession();
}

/**
 * Add (or replace) an account's decrypted secret in the unlocked session, and
 * optionally make it active. Used by addAccount while unlocked. Throws if locked.
 */
export function addSessionAccount(
  account: SessionAccount,
  makeActive: boolean,
): void {
  if (!session) throw new Error("wallet is locked");
  const existing = session.entries.get(account.id);
  if (existing) zeroSecret(existing.secret);
  session.entries.set(account.id, {
    secret: cloneSecret(account.secret),
    address: account.address,
  });
  if (makeActive) session.activeId = account.id;
  touchSession();
}

/**
 * Remove an account's secret from the unlocked session (zeroing it). If it was
 * active, switch to `fallbackActiveId`. No-op if locked or absent.
 */
export function removeSessionAccount(id: string, fallbackActiveId: string): void {
  if (!session) return;
  const existing = session.entries.get(id);
  if (existing) {
    zeroSecret(existing.secret);
    session.entries.delete(id);
  }
  if (session.activeId === id) session.activeId = fallbackActiveId;
  touchSession();
}


/** Shallow structural clone of a secret (all fields are primitives). */
function cloneSecret(secret: DecryptedSecret): DecryptedSecret {
  switch (secret.kind) {
    case "secp256k1-privkey":
      return { kind: secret.kind, privateKeyHex: secret.privateKeyHex };
    case "bip39-mnemonic":
      return {
        kind: secret.kind,
        mnemonic: secret.mnemonic,
        ...(secret.passphrase !== undefined ? { passphrase: secret.passphrase } : {}),
      };
    case "watch-only-xpub":
      return { kind: secret.kind, xpub: secret.xpub };
  }
}

/** Read the ACTIVE account's session entry, or throw if locked / missing. */
function requireActiveEntry(): SessionEntry {
  if (!session) throw new Error("wallet is locked");
  const entry = session.entries.get(session.activeId);
  if (!entry) throw new Error("active account is not unlocked");
  return entry;
}

/**
 * Return the ACTIVE account's unlocked secret, or throw if locked. Touches the
 * session so activity defers auto-lock. Callers MUST NOT persist or log it.
 */
export function requireSecret(): DecryptedSecret {
  const entry = requireActiveEntry();
  touchSession();
  return entry.secret;
}

/** Return the ACTIVE account's address, or throw if locked. */
export function requireAddress(): string {
  const entry = requireActiveEntry();
  touchSession();
  return entry.address;
}

/** Return a specific unlocked account's secret, or throw if locked / absent. */
export function requireSecretFor(id: string): DecryptedSecret {
  if (!session) throw new Error("wallet is locked");
  const entry = session.entries.get(id);
  if (!entry) throw new Error("account is not unlocked");
  touchSession();
  return entry.secret;
}

/** Return the in-memory derived AES key, or throw if locked / not available. */
export function requireKey(): CryptoKey {
  if (!session) throw new Error("wallet is locked");
  if (!session.key) {
    throw new Error("session key unavailable; re-enter your password");
  }
  touchSession();
  return session.key;
}

/** Defer the auto-lock deadline by the configured timeout from now. */
export function touchSession(): void {
  if (!session) return;
  session.lockAt = Date.now() + timeoutMs;
  armTimer();
  void persistCurrent();
}

/** Lock the wallet: zero and drop all in-memory secret material + persisted copy. */
export function lock(): void {
  if (lockTimer) {
    clearTimeout(lockTimer);
    lockTimer = null;
  }
  const wasUnlocked = session !== null;
  if (session) {
    zeroAll(session.entries);
    session = null;
  }
  if (store) void store.clearSession().catch(() => undefined);
  if (wasUnlocked) emitLockState(true);
}

/**
 * Restore an unlocked session from the persistence store if one exists and has
 * not expired (used after a worker respawn). Returns whether a session was
 * restored. A restored session has a null AES key.
 */
export async function rehydrate(): Promise<boolean> {
  if (session) return true; // already unlocked in this worker
  if (!store) return false;
  let persisted: PersistedSession | null;
  try {
    persisted = await store.getSession();
  } catch {
    return false;
  }
  if (!persisted) return false;
  if (Date.now() >= persisted.expiresAt) {
    void store.clearSession().catch(() => undefined);
    return false;
  }
  if (!persisted.accounts || persisted.accounts.length === 0) {
    void store.clearSession().catch(() => undefined);
    return false;
  }
  const entries = new Map<string, SessionEntry>();
  for (const a of persisted.accounts) {
    entries.set(a.id, { secret: cloneSecret(a.secret), address: a.address });
  }
  const activeId = entries.has(persisted.activeId)
    ? persisted.activeId
    : (persisted.accounts[0] as PersistedAccountSecret).id;
  session = {
    entries,
    activeId,
    key: null,
    lockAt: persisted.expiresAt,
  };
  armTimer();
  emitLockState(false);
  return true;
}

/** Rehydrate at most once per worker lifetime (call before reading lock state). */
export function ensureRehydrated(): Promise<void> {
  if (!rehydratePromise) {
    rehydratePromise = rehydrate().then(
      () => undefined,
      () => undefined,
    );
  }
  return rehydratePromise;
}

function armTimer(): void {
  if (lockTimer) clearTimeout(lockTimer);
  if (!session) return;
  const delay = Math.max(0, session.lockAt - Date.now());
  lockTimer = setTimeout(() => {
    // Re-check: activity may have pushed the deadline out.
    if (session && Date.now() >= session.lockAt) {
      lock();
    } else if (session) {
      armTimer();
    }
  }, delay);
  // Don't keep an MV3 worker alive purely for the lock timer, if supported.
  (lockTimer as unknown as { unref?: () => void })?.unref?.();
}

/**
 * Best-effort wipe of secret string fields. JS strings are immutable so this
 * cannot truly scrub the backing store; it drops our references so the GC can
 * reclaim them and removes the values from the live object.
 */
function zeroSecret(secret: DecryptedSecret): void {
  switch (secret.kind) {
    case "secp256k1-privkey":
      (secret as { privateKeyHex: string }).privateKeyHex = "";
      break;
    case "bip39-mnemonic":
      (secret as { mnemonic: string }).mnemonic = "";
      if (secret.passphrase !== undefined) {
        (secret as { passphrase?: string }).passphrase = "";
      }
      break;
    case "watch-only-xpub":
      (secret as { xpub: string }).xpub = "";
      break;
  }
}

/** Test-only: reset all session state, listeners, store, and timeout. */
export function __resetSession(): void {
  lock();
  lockListeners.clear();
  timeoutMs = DEFAULT_LOCK_TIMEOUT_MS;
  store = null;
  rehydratePromise = null;
}
