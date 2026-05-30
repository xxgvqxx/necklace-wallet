/**
 * Session persistence / rehydration (cross-reopen unlock). Uses an injected
 * in-memory SessionStore — no chrome. Validates that a non-expired persisted
 * session restores after a simulated worker respawn, an expired one does not,
 * and locking clears the persisted copy.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  __resetSession,
  getActiveAccountId,
  isUnlocked,
  lock,
  rehydrate,
  requireAddress,
  requireSecretFor,
  setSessionStore,
  startSession,
} from "../src/vault/session.js";
import type { PersistedSession, SessionStore } from "../src/vault/session-store.js";

function memStore(initial: PersistedSession | null = null): SessionStore & {
  current: () => PersistedSession | null;
} {
  let saved: PersistedSession | null = initial;
  return {
    current: () => saved,
    async getSession() {
      return saved;
    },
    async setSession(s) {
      saved = s;
    },
    async clearSession() {
      saved = null;
    },
    async getTimeoutMs() {
      return null;
    },
    async setTimeoutMs() {
      /* noop */
    },
    async ensureAccessLevel() {
      /* noop */
    },
  };
}

const SECRET = {
  kind: "secp256k1-privkey" as const,
  privateKeyHex: "ab".repeat(32),
};
const SECRET2 = {
  kind: "secp256k1-privkey" as const,
  privateKeyHex: "cd".repeat(32),
};
const ADDR = "prl1paardr2nczq0rx5rqpfwnvpzm497zvux64y0f7wjgcs7xuuuh2nnqksluzv";
const ADDR2 = "prl1pxdl637ggw0zwrdxqkxkn4llnes5ljz2nql0k3n4qz2qnavf6n9mqc4qtdw";

afterEach(() => __resetSession());

describe("session persistence / rehydrate", () => {
  it("restores a non-expired persisted session after a worker respawn", async () => {
    const store = memStore({
      accounts: [{ id: "a1", secret: SECRET, address: ADDR }],
      activeId: "a1",
      expiresAt: Date.now() + 60_000,
    });
    setSessionStore(store);
    expect(isUnlocked()).toBe(false);
    expect(await rehydrate()).toBe(true);
    expect(isUnlocked()).toBe(true);
  });

  it("rehydrates the WHOLE multi-account map + active id", async () => {
    const store = memStore({
      accounts: [
        { id: "a1", secret: SECRET, address: ADDR },
        { id: "a2", secret: SECRET2, address: ADDR2 },
      ],
      activeId: "a2",
      expiresAt: Date.now() + 60_000,
    });
    setSessionStore(store);
    expect(await rehydrate()).toBe(true);
    expect(isUnlocked()).toBe(true);
    // Active account's secret/address come from the rehydrated map.
    expect(requireSecretFor("a1")).toEqual(SECRET);
    expect(requireSecretFor("a2")).toEqual(SECRET2);
    expect(getActiveAccountId()).toBe("a2");
    expect(requireAddress()).toBe(ADDR2);
  });

  it("does NOT restore an expired session (and clears it)", async () => {
    const store = memStore({
      accounts: [{ id: "a1", secret: SECRET, address: ADDR }],
      activeId: "a1",
      expiresAt: Date.now() - 1,
    });
    setSessionStore(store);
    expect(await rehydrate()).toBe(false);
    expect(isUnlocked()).toBe(false);
    expect(store.current()).toBeNull();
  });

  it("persists every account on unlock and clears on lock", async () => {
    const store = memStore(null);
    setSessionStore(store);
    startSession(
      [
        { id: "a1", secret: SECRET, address: ADDR },
        { id: "a2", secret: SECRET2, address: ADDR2 },
      ],
      "a2",
      null,
    );
    // startSession persists fire-and-forget; let microtasks flush.
    await Promise.resolve();
    expect(store.current()).not.toBeNull();
    expect(store.current()?.accounts).toHaveLength(2);
    expect(store.current()?.activeId).toBe("a2");
    lock();
    await Promise.resolve();
    expect(store.current()).toBeNull();
    expect(isUnlocked()).toBe(false);
  });

  it("with no store injected, stays in-memory only (no throw)", async () => {
    setSessionStore(null);
    startSession([{ id: "a1", secret: SECRET, address: ADDR }], "a1", null);
    expect(isUnlocked()).toBe(true);
    expect(await rehydrate()).toBe(true); // already unlocked
    lock();
    expect(isUnlocked()).toBe(false);
  });
});
