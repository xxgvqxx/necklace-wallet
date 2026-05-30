/**
 * Settings — wallet management: lock now, reveal the recovery phrase (requires
 * the password and is shown only transiently), reset/remove the wallet
 * (destructive, with confirmation), and view network + address info.
 *
 * Revealing the secret requires re-entering the password; the secret is held in
 * local state only while shown and is wiped when leaving the reveal view. It is
 * never logged or sent to the network.
 */

import { useState } from "react";
import type { VaultState } from "../api/index.js";
import { vault, VaultError } from "../api/index.js";
import {
  AddressDisplay,
  Button,
  Card,
  ErrorState,
  Header,
  PasswordField,
} from "../components/index.js";
import { color, font, radius, space } from "../components/theme.js";
import { getThemeMode, setThemeMode, type ThemeMode } from "../theme/theme-mode.js";
import type { Navigate } from "./types.js";

export interface SettingsProps {
  state: VaultState;
  navigate: Navigate;
  /** Called after lock/reset so the shell re-reads vault state. */
  onVaultChanged: () => void;
}

type View = "menu" | "reveal" | "reset";

/** Auto-lock inactivity options. */
const LOCK_OPTIONS: { label: string; ms: number }[] = [
  { label: "1 minute", ms: 60_000 },
  { label: "5 minutes", ms: 5 * 60_000 },
  { label: "15 minutes", ms: 15 * 60_000 },
  { label: "30 minutes", ms: 30 * 60_000 },
  { label: "1 hour", ms: 60 * 60_000 },
];
const DEFAULT_LOCK_MS = 5 * 60_000;

export function Settings({ state, navigate, onVaultChanged }: SettingsProps): React.JSX.Element {
  const [view, setView] = useState<View>("menu");
  const [theme, setTheme] = useState<ThemeMode>(getThemeMode());
  const [lockMs, setLockMs] = useState<number>(state.lockTimeoutMs ?? DEFAULT_LOCK_MS);

  const accountCount = state.accounts?.length ?? 1;
  const isLastAccount = accountCount <= 1;

  if (view === "reveal") {
    return <RevealSecret onBack={() => setView("menu")} />;
  }
  if (view === "reset") {
    return (
      <ResetWallet
        onBack={() => setView("menu")}
        isLastAccount={isLastAccount}
        activeAccountId={state.activeAccountId}
        onReset={() => {
          onVaultChanged();
        }}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
      <Header title="Settings" onBack={() => navigate({ name: "home" })} />

      <Card>
        <div style={{ fontSize: 11, color: color.textDim }}>Network</div>
        <div style={{ fontSize: 14, fontWeight: 600, marginTop: 2 }}>
          {state.network}
          {state.watchOnly ? " • watch-only" : ""}
        </div>
      </Card>

      {state.address && (
        <AddressDisplay address={state.address.address} label="Wallet address" />
      )}

      <Card>
        <div style={{ fontSize: 11, color: color.textDim }}>Appearance</div>
        <div style={{ display: "flex", gap: space.sm, marginTop: space.sm }}>
          {(["dark", "light"] as ThemeMode[]).map((m) => {
            const active = theme === m;
            return (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setThemeMode(m);
                  setTheme(m);
                }}
                style={{
                  flex: 1,
                  padding: `${space.sm}px`,
                  borderRadius: radius.sm,
                  border: `1px solid ${active ? color.accent : color.border}`,
                  background: active ? color.surfaceAlt : "transparent",
                  color: active ? color.text : color.textDim,
                  fontFamily: font.family,
                  fontSize: 13,
                  fontWeight: active ? 600 : 400,
                  textTransform: "capitalize",
                  cursor: "pointer",
                }}
              >
                {m === "dark" ? "Monokai" : "Monokai Light"}
              </button>
            );
          })}
        </div>
      </Card>

      <Card>
        <div style={{ fontSize: 11, color: color.textDim }}>
          Auto-lock after inactivity
        </div>
        <select
          value={String(lockMs)}
          onChange={(e) => {
            const ms = Number(e.target.value);
            setLockMs(ms);
            void vault.setLockTimeout(ms);
          }}
          style={{
            marginTop: space.sm,
            width: "100%",
            fontFamily: font.family,
            fontSize: 13,
            color: color.text,
            background: color.surfaceAlt,
            border: `1px solid ${color.border}`,
            borderRadius: radius.sm,
            padding: space.sm,
            outline: "none",
          }}
        >
          {LOCK_OPTIONS.map((o) => (
            <option key={o.ms} value={o.ms}>
              {o.label}
            </option>
          ))}
        </select>
        <div style={{ fontSize: 10, color: color.textFaint, marginTop: space.xs }}>
          The wallet stays unlocked across reopens until this much idle time
          passes. Sending always asks for your password.
        </div>
      </Card>

      <Button variant="secondary" fullWidth onClick={() => navigate({ name: "accounts" })}>
        Manage accounts
      </Button>

      <Button
        variant="secondary"
        fullWidth
        onClick={async () => {
          await vault.lock();
          onVaultChanged();
        }}
      >
        Lock wallet
      </Button>

      {!state.watchOnly && (
        <Button variant="secondary" fullWidth onClick={() => setView("reveal")}>
          Reveal recovery phrase
        </Button>
      )}

      <Button variant="danger" fullWidth onClick={() => setView("reset")}>
        {isLastAccount
          ? "Remove wallet from this device"
          : "Remove this account"}
      </Button>
    </div>
  );
}

function RevealSecret({ onBack }: { onBack: () => void }): React.JSX.Element {
  const [password, setPassword] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reveal(): Promise<void> {
    if (password.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      const s = await vault.revealSecret(password);
      setSecret(s);
      setPassword("");
    } catch (err) {
      setPassword("");
      if (err instanceof VaultError && err.code === "WRONG_PASSWORD") {
        setError("That password is incorrect.");
      } else {
        setError(err instanceof Error ? err.message : "Unable to reveal.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
      <Header
        title="Recovery phrase"
        onBack={() => {
          setSecret(null); // wipe on leave
          onBack();
        }}
      />
      <ErrorState
        title="Keep this private"
        message="Anyone with your recovery phrase can spend your funds. Never share it or enter it on a website."
      />

      {secret === null ? (
        <>
          <PasswordField
            value={password}
            onChange={setPassword}
            label="Confirm your password"
            autoFocus
            onEnter={reveal}
          />
          {error && <ErrorState kind="wrong-password" message={error} />}
          <Button fullWidth busy={busy} disabled={password.length === 0} onClick={reveal}>
            Reveal
          </Button>
        </>
      ) : (
        <div
          style={{
            fontFamily: font.mono,
            fontSize: 13,
            lineHeight: 1.6,
            color: color.text,
            background: color.surfaceAlt,
            border: `1px solid ${color.border}`,
            borderRadius: radius.md,
            padding: space.md,
            wordBreak: "break-word",
          }}
        >
          {secret}
        </div>
      )}
    </div>
  );
}

function ResetWallet({
  onBack,
  onReset,
  isLastAccount,
  activeAccountId,
}: {
  onBack: () => void;
  onReset: () => void;
  /** When true this is the only account, so we remove the whole wallet. */
  isLastAccount: boolean;
  /** id of the active account (removed when not the last account). */
  activeAccountId?: string;
}): React.JSX.Element {
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Removing one of several accounts is a lighter action — no RESET typing.
  const ready = isLastAccount ? confirmText.trim().toUpperCase() === "RESET" : true;

  async function doReset(): Promise<void> {
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (isLastAccount || !activeAccountId) {
        await vault.reset();
      } else {
        await vault.removeAccount(activeAccountId);
      }
      onReset();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Remove failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
      <Header title={isLastAccount ? "Remove wallet" : "Remove account"} onBack={onBack} />
      <ErrorState
        title="This cannot be undone"
        message={
          isLastAccount
            ? "This removes the encrypted wallet from this device. You can only restore it with your recovery phrase. Make sure you have it written down."
            : "This removes the active account from this device. You can only restore it with that account's recovery phrase. Make sure you have it written down. Your other accounts are unaffected."
        }
      />
      {isLastAccount && (
        <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
          <label style={{ fontSize: 12, color: color.textDim }}>
            Type RESET to confirm
          </label>
          <input
            value={confirmText}
            autoCapitalize="characters"
            spellCheck={false}
            onChange={(e) => setConfirmText(e.target.value)}
            style={{
              fontFamily: font.mono,
              fontSize: 14,
              color: color.text,
              background: color.surfaceAlt,
              border: `1px solid ${color.border}`,
              borderRadius: radius.sm,
              padding: space.sm,
              outline: "none",
            }}
          />
        </div>
      )}
      {error && <ErrorState message={error} />}
      <Button variant="danger" fullWidth busy={busy} disabled={!ready} onClick={doReset}>
        {isLastAccount ? "Permanently remove wallet" : "Remove this account"}
      </Button>
    </div>
  );
}
