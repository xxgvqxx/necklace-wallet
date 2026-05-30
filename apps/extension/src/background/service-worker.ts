/**
 * MV3 background service worker.
 *
 * Responsibilities:
 *  - hold the decrypted key in memory while unlocked, and persist the unlock to
 *    chrome.storage.session so it survives worker eviction within the auto-lock
 *    window (no re-prompt on every popup reopen — see vault/session-store.ts);
 *  - mediate vault create/import/unlock/lock/reset/reveal/sign + lock-timeout
 *    via a single typed message API (../api/vault-protocol.ts, ./dispatch.ts);
 *  - lock the stores down to trusted contexts on startup;
 *  - never sign XMSS in-browser (the unified protocol offers no XMSS sign).
 *
 * It wires `@necklace/wallet-core` into the vault at startup (deriver + signer)
 * and the chrome.storage.session-backed persistence store, then restores any
 * unexpired session (a respawned worker rehydrates before handling messages).
 */

import { ensureTrustedAccessLevel } from "../vault/storage.js";
import {
  ensureRehydrated,
  enforceLockTimeout,
  loadPersistedLockTimeout,
  lock,
  setSessionStore,
} from "../vault/session.js";
import { makeChromeSessionStore } from "../vault/session-store.js";
import { setAddressDeriver } from "../vault/derive.js";
import { setTransactionSigner } from "../vault/signer.js";
import { walletCoreDeriver, walletCoreSigner } from "../vault/wallet-core-adapter.js";
import { handleMessage } from "./dispatch.js";
import type { VaultRequest, VaultResponse } from "./messages.js";

// Wire the cross-reopen persistence store FIRST (before rehydrate/timeout load).
const sessionStore = makeChromeSessionStore();
setSessionStore(sessionStore);
void sessionStore.ensureAccessLevel();

// Wire the audited crypto (wallet-core) into the vault seams.
setAddressDeriver(walletCoreDeriver);
setTransactionSigner(walletCoreSigner);

// Restrict chrome.storage.local to trusted contexts as early as possible.
void ensureTrustedAccessLevel();

// Load the saved auto-lock timeout, then restore an unexpired session (this
// path runs when the worker is respawned after eviction mid-session).
void loadPersistedLockTimeout();
void ensureRehydrated();

// Lock (and clear the persisted session) on browser start or extension
// install/update — never carry an unlocked session across those events.
chrome.runtime.onStartup?.addListener(() => {
  lock();
  void ensureTrustedAccessLevel();
});
chrome.runtime.onInstalled?.addListener(() => {
  lock();
  void ensureTrustedAccessLevel();
});

// Auto-lock backstop. MV3 evicts the idle worker, which drops the in-heap
// setTimeout that enforces the inactivity timeout — so a periodic alarm wakes
// the worker to re-lock the persisted session once its deadline passes, even if
// the popup is never reopened. The alive-worker case still locks precisely via
// the setTimeout; this only covers the evicted case.
const AUTOLOCK_ALARM = "necklace-autolock";
chrome.alarms?.create(AUTOLOCK_ALARM, { periodInMinutes: 1 });
chrome.alarms?.onAlarm.addListener((alarm) => {
  if (alarm.name === AUTOLOCK_ALARM) void enforceLockTimeout();
});

chrome.runtime.onMessage.addListener(
  (
    message: VaultRequest,
    sender,
    sendResponse: (response: VaultResponse) => void,
  ): boolean => {
    // Defense-in-depth: accept messages only from this extension's own pages.
    // There is no externally_connectable or content script today, so the sender
    // can only be the popup — but reject anything else so a future manifest
    // change can't silently expose the vault to a web origin.
    if (!sender || sender.id !== chrome.runtime.id) {
      sendResponse({ type: "ERROR", code: "UNKNOWN", message: "forbidden sender" });
      return false;
    }
    // All handlers are async; resolve then respond. Returning true keeps the
    // message channel open for the async sendResponse.
    handleMessage(message).then(
      (response) => sendResponse(response),
      (err: unknown) => {
        const msg = err instanceof Error ? err.message : "internal error";
        sendResponse({ type: "ERROR", code: "UNKNOWN", message: msg });
      },
    );
    return true;
  },
);
