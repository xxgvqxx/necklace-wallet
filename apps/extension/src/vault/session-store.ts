/**
 * Cross-reopen unlock persistence + the (non-secret) auto-lock timeout.
 *
 * WHY: MV3 evicts idle service workers (~30s), which drops the in-memory unlock
 * and forces a password re-entry on every popup reopen. To honor the user's
 * auto-lock WINDOW across reopens, the unlocked session is persisted to
 * `chrome.storage.session`.
 *
 * SECURITY TRADEOFF (deliberate, user-requested): during the unlock window the
 * decrypted secret lives in `chrome.storage.session` as well as worker memory.
 * `chrome.storage.session` is RAM-ONLY (never written to disk), is cleared when
 * the browser fully closes, and defaults to — and is pinned here to —
 * TRUSTED_CONTEXTS (unreachable from web pages / content scripts). It is cleared
 * on lock, on expiry, and on browser close. Signing still requires the password
 * at sign time regardless (threat-model: password only at signing).
 *
 * The auto-lock timeout (a non-secret preference) lives in
 * `chrome.storage.local`.
 */

import type { DecryptedSecret } from "./vault-types.js";

/** One persisted account entry: its id mapped to its decrypted secret + address. */
export interface PersistedAccountSecret {
  id: string;
  secret: DecryptedSecret;
  address: string;
}

export interface PersistedSession {
  /**
   * Every unlocked account's decrypted secret (so switching needs no password).
   * Persisted to chrome.storage.session (RAM-only, trusted-contexts, cleared on
   * browser close) — same deliberate tradeoff as the single-account design.
   */
  accounts: PersistedAccountSecret[];
  /** id of the active account at persist time. */
  activeId: string;
  /** Epoch ms after which the session must re-lock. */
  expiresAt: number;
}

export interface SessionStore {
  getSession(): Promise<PersistedSession | null>;
  setSession(s: PersistedSession): Promise<void>;
  clearSession(): Promise<void>;
  /** Persisted auto-lock timeout in ms, or null if unset. */
  getTimeoutMs(): Promise<number | null>;
  setTimeoutMs(ms: number): Promise<void>;
  /** Restrict session storage to trusted contexts (idempotent, best-effort). */
  ensureAccessLevel(): Promise<void>;
}

const SESSION_KEY = "necklace.session.v1";
const TIMEOUT_KEY = "necklace.lockTimeoutMs";

/** Production store: chrome.storage.session (unlock) + chrome.storage.local (timeout). */
export function makeChromeSessionStore(): SessionStore {
  return {
    async getSession() {
      const o = await chrome.storage.session.get(SESSION_KEY);
      const v = o[SESSION_KEY];
      return v ? (v as PersistedSession) : null;
    },
    async setSession(s) {
      await chrome.storage.session.set({ [SESSION_KEY]: s });
    },
    async clearSession() {
      await chrome.storage.session.remove(SESSION_KEY);
    },
    async getTimeoutMs() {
      const o = await chrome.storage.local.get(TIMEOUT_KEY);
      const v = o[TIMEOUT_KEY];
      return typeof v === "number" && v > 0 ? v : null;
    },
    async setTimeoutMs(ms) {
      await chrome.storage.local.set({ [TIMEOUT_KEY]: ms });
    },
    async ensureAccessLevel() {
      try {
        const sess = chrome.storage.session as unknown as {
          setAccessLevel?: (o: { accessLevel: string }) => Promise<void>;
        };
        await sess.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" });
      } catch {
        // Older Chrome: session storage already defaults to trusted contexts.
      }
    },
  };
}
