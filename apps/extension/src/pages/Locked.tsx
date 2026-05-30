/**
 * Locked — the unlock screen shown when a vault exists but is locked. Collects
 * the password and asks the background worker to decrypt the key into memory.
 * The password is held only in local state long enough to call unlock and is
 * cleared immediately afterwards; it is never logged or sent to the network.
 */

import { useState } from "react";
import { vault, VaultError } from "../api/index.js";
import { Button, ErrorState, PasswordField } from "../components/index.js";
import { Logo } from "../components/Logo.js";
import { color, font, space } from "../components/theme.js";

export interface LockedProps {
  /** Called after a successful unlock so the shell can refresh state. */
  onUnlocked: () => void;
  /** Optional escape hatch to the destructive reset flow (Settings). */
  onForgotPassword?: () => void;
}

export function Locked({ onUnlocked, onForgotPassword }: LockedProps): React.JSX.Element {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleUnlock(): Promise<void> {
    if (password.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    try {
      await vault.unlock(password);
      setPassword(""); // clear the secret from memory ASAP
      onUnlocked();
    } catch (err) {
      setPassword("");
      if (err instanceof VaultError && err.code === "WRONG_PASSWORD") {
        setError("That password is incorrect.");
      } else {
        setError(err instanceof Error ? err.message : "Unable to unlock.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space.lg,
        flex: 1,
        justifyContent: "center",
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div style={{ display: "flex", justifyContent: "center" }}>
          <Logo size={56} />
        </div>
        <h1 style={{ fontSize: 18, margin: `${space.sm}px 0 0`, fontFamily: font.family }}>
          Necklace
        </h1>
        <p style={{ fontSize: 12, color: color.textDim, marginTop: space.xs }}>
          Unlock your wallet to continue.
        </p>
      </div>

      <PasswordField
        value={password}
        onChange={setPassword}
        autoFocus
        onEnter={handleUnlock}
      />

      {error && (
        <ErrorState kind="wrong-password" title="Couldn't unlock" message={error} />
      )}

      <Button
        fullWidth
        busy={busy}
        disabled={password.length === 0}
        onClick={handleUnlock}
      >
        Unlock
      </Button>

      {onForgotPassword && (
        <Button variant="ghost" fullWidth onClick={onForgotPassword}>
          Forgot password? Reset wallet
        </Button>
      )}
    </div>
  );
}
