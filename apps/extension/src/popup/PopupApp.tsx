/**
 * Root popup component and router.
 *
 * Gating logic, driven by the background vault state:
 *   - no vault           -> onboarding (Welcome / Import / Create)
 *   - vault, locked      -> Locked (unlock)
 *   - vault, unlocked    -> the authenticated route stack (Home, Send, …)
 *
 * Routing is a small in-memory state machine (no router lib needed for a
 * fixed-size popup). The app holds the current Route and passes `navigate` down.
 * No keys or passwords live here — those are handled by the screens that talk to
 * the background worker, and only transiently.
 */

import { useCallback, useEffect, useState } from "react";
import type { VaultState } from "../api/index.js";
import { vault, VaultError } from "../api/index.js";
import { ACTIVE_NETWORK } from "../api/index.js";
import { Button, ErrorState, Spinner } from "../components/index.js";
import { pageStyle, space } from "../components/theme.js";
import {
  Accounts,
  Activity,
  AddressLookup,
  ConfirmTransaction,
  Contacts,
  CreateWallet,
  Home,
  ImportWallet,
  Locked,
  Receive,
  Send,
  Sent,
  Settings,
  TransactionDetail,
  Welcome,
  type Route,
} from "../pages/index.js";

/** Onboarding sub-state when no vault exists. */
type Onboarding = "welcome" | "import" | "create";

export function PopupApp(): React.JSX.Element {
  const [vaultState, setVaultState] = useState<VaultState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [corrupt, setCorrupt] = useState(false);
  const [route, setRoute] = useState<Route>({ name: "home" });
  const [onboarding, setOnboarding] = useState<Onboarding>("welcome");

  /**
   * Re-read vault state WITHOUT changing the current route. Used by in-place
   * mutations (rename/remove on the Accounts page) that should not bounce the
   * user back to Home.
   */
  const refreshStateOnly = useCallback(async () => {
    try {
      const state = await vault.getState();
      setVaultState(state);
    } catch {
      // Leave the existing state; the next full refresh surfaces any error.
    }
  }, []);

  const refreshState = useCallback(async () => {
    setLoadError(null);
    setCorrupt(false);
    try {
      const state = await vault.getState();
      setVaultState(state);
      // Reset to home whenever vault state is (re)loaded post-auth.
      setRoute({ name: "home" });
    } catch (err) {
      // A structurally corrupt vault can't be opened with any password — offer a
      // dedicated recovery path (restore from phrase / reset) rather than a
      // generic error the user can only stare at.
      if (err instanceof VaultError && err.code === "CORRUPT_VAULT") {
        setCorrupt(true);
        setVaultState(null);
        return;
      }
      // The background worker may still be starting up; surface a clear error
      // rather than a blank screen.
      setLoadError(err instanceof Error ? err.message : "Couldn't reach the wallet service.");
      setVaultState(null);
    }
  }, []);

  useEffect(() => {
    void refreshState();
  }, [refreshState]);

  const navigate = useCallback((next: Route) => setRoute(next), []);

  // --- Corrupted vault: fail-closed recovery affordance ------------------

  if (corrupt) {
    return (
      <main style={pageStyle}>
        <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
          <ErrorState
            kind="generic"
            title="Wallet data is corrupted"
            message={
              "The encrypted wallet on this device can't be read. This usually means " +
              "the stored data was damaged. Restore from your recovery phrase, or reset " +
              "to remove the unreadable data and start over. Resetting cannot be undone " +
              "without your recovery phrase."
            }
          />
          <Button
            variant="danger"
            fullWidth
            onClick={async () => {
              await vault.reset();
              await refreshState();
            }}
          >
            Reset and start over
          </Button>
        </div>
      </main>
    );
  }

  // --- Loading / error gates ---------------------------------------------

  if (loadError) {
    return (
      <main style={pageStyle}>
        <ErrorState
          kind="backend-down"
          title="Wallet service unavailable"
          message={loadError}
          onRetry={() => void refreshState()}
        />
      </main>
    );
  }

  if (!vaultState) {
    return (
      <main style={pageStyle}>
        <Spinner label="Loading…" />
      </main>
    );
  }

  // --- Wrong-network vault: fail-closed reset affordance -----------------
  // A leftover wallet created on a non-mainnet network (e.g. regtest) can't be
  // used here — Necklace is mainnet-only. Offer a reset rather than silently
  // showing a wrong-network (rprl/tprl) address.
  if (vaultState.networkMismatch) {
    return (
      <main style={pageStyle}>
        <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
          <ErrorState
            kind="generic"
            title="Wallet is on a different network"
            message={
              "This wallet was created on a non-mainnet network and can't be used " +
              "here — Necklace is mainnet-only. Reset to create a new mainnet " +
              "(prl1…) wallet. Resetting removes the local wallet, so back up your " +
              "recovery phrase first if it holds anything you need."
            }
          />
          <Button
            variant="danger"
            fullWidth
            onClick={async () => {
              await vault.reset();
              await refreshState();
            }}
          >
            Reset and create a mainnet wallet
          </Button>
        </div>
      </main>
    );
  }

  // --- No vault: onboarding ----------------------------------------------

  if (!vaultState.hasVault) {
    return (
      <main style={pageStyle}>
        {onboarding === "welcome" && (
          <Welcome
            onImport={() => setOnboarding("import")}
            onCreate={() => setOnboarding("create")}
          />
        )}
        {onboarding === "import" && (
          <ImportWallet
            onImported={() => void refreshState()}
            onBack={() => setOnboarding("welcome")}
          />
        )}
        {onboarding === "create" && (
          <CreateWallet
            onCreated={() => void refreshState()}
            onBack={() => setOnboarding("welcome")}
          />
        )}
      </main>
    );
  }

  // --- Vault locked -------------------------------------------------------

  if (vaultState.locked) {
    return (
      <main style={pageStyle}>
        <Locked onUnlocked={() => void refreshState()} />
      </main>
    );
  }

  // --- Unlocked: authenticated route stack -------------------------------

  return (
    <main style={pageStyle}>
      {renderRoute(route, vaultState, navigate, refreshState, refreshStateOnly)}
    </main>
  );
}

function renderRoute(
  route: Route,
  state: VaultState,
  navigate: (r: Route) => void,
  refreshState: () => void,
  refreshStateOnly: () => void,
): React.JSX.Element {
  switch (route.name) {
    case "home":
      return <Home state={state} navigate={navigate} />;
    case "receive":
      return <Receive state={state} navigate={navigate} />;
    case "send":
      return (
        <Send state={state} navigate={navigate} prefillAddress={route.prefillAddress} />
      );
    case "contacts":
      return <Contacts navigate={navigate} />;
    case "confirm":
      return <ConfirmTransaction preview={route.preview} navigate={navigate} />;
    case "sent":
      return (
        <Sent txid={route.txid} alreadyKnown={route.alreadyKnown} navigate={navigate} />
      );
    case "activity":
      return <Activity state={state} navigate={navigate} />;
    case "txdetail":
      return <TransactionDetail txid={route.txid} state={state} navigate={navigate} />;
    case "lookup":
      return <AddressLookup navigate={navigate} />;
    case "accounts":
      return (
        <Accounts
          state={state}
          navigate={navigate}
          onChanged={() => refreshStateOnly()}
        />
      );
    case "settings":
      return (
        <Settings
          state={state}
          navigate={navigate}
          onVaultChanged={() => refreshState()}
        />
      );
  }
}

// Surface the build's active network for any consumer that wants it (the
// vault state is authoritative at runtime, but this confirms the build target).
export const POPUP_NETWORK = ACTIVE_NETWORK;
