/**
 * Auto-lock enforcement tests — focused on the lock-DEADLINE behavior that
 * limits how long the decrypted secret lives in RAM, including the
 * `enforceLockTimeout()` backstop that re-locks after MV3 has evicted the
 * worker (when the in-heap setTimeout no longer exists).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  __resetSession,
  enforceLockTimeout,
  isUnlocked,
  setLockTimeout,
  setSessionStore,
  startSession,
  type SessionAccount,
} from "./session.js";
import type { PersistedSession, SessionStore } from "./session-store.js";

/** Minimal in-memory SessionStore mirroring chrome.storage.session semantics. */
function memStore() {
  const s = {
    _session: null as PersistedSession | null,
    _timeout: null as number | null,
    async getSession() {
      return s._session;
    },
    async setSession(v: PersistedSession) {
      s._session = v;
    },
    async clearSession() {
      s._session = null;
    },
    async getTimeoutMs() {
      return s._timeout;
    },
    async setTimeoutMs(ms: number) {
      s._timeout = ms;
    },
    async ensureAccessLevel() {},
  };
  return s satisfies SessionStore & {
    _session: PersistedSession | null;
    _timeout: number | null;
  };
}

const acct: SessionAccount = {
  id: "a1",
  secret: { kind: "secp256k1-privkey", privateKeyHex: "11".repeat(32) },
  address: "prl1xtest",
};

function persisted(expiresAt: number): PersistedSession {
  return {
    accounts: [{ id: acct.id, secret: acct.secret, address: acct.address }],
    activeId: acct.id,
    expiresAt,
  };
}

describe("session auto-lock enforcement", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    __resetSession();
  });
  afterEach(() => {
    __resetSession();
    vi.useRealTimers();
  });

  it("locks an alive session once its deadline has passed", async () => {
    setLockTimeout(60_000);
    startSession([acct], "a1", null);
    expect(isUnlocked()).toBe(true);
    vi.setSystemTime(61_000); // past the 60s deadline
    await enforceLockTimeout();
    expect(isUnlocked()).toBe(false);
  });

  it("keeps an unexpired alive session unlocked", async () => {
    setLockTimeout(60_000);
    startSession([acct], "a1", null);
    vi.setSystemTime(30_000); // still within the window
    await enforceLockTimeout();
    expect(isUnlocked()).toBe(true);
  });

  it("clears an EXPIRED persisted session on a respawned worker (backstop)", async () => {
    const store = memStore();
    store._session = persisted(50_000); // a previous worker's session, now expired
    vi.setSystemTime(60_000);
    setSessionStore(store);
    await enforceLockTimeout(); // rehydrate sees expiry -> clears, stays locked
    expect(isUnlocked()).toBe(false);
    expect(store._session).toBeNull();
  });

  it("restores an unexpired persisted session without locking early", async () => {
    const store = memStore();
    store._session = persisted(120_000);
    vi.setSystemTime(60_000);
    setSessionStore(store);
    await enforceLockTimeout(); // not expired -> rehydrates, stays unlocked
    expect(isUnlocked()).toBe(true);
  });
});
