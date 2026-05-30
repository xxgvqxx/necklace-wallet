/**
 * CreateWallet — generate a brand-new wallet in the background and walk the user
 * through backing up the recovery phrase.
 *
 * In-browser generation is SAFE here (Phase 1 "Generate-wallet-in-browser
 * safe: true"): the send/receive path uses only stateless secp256k1 Schnorr
 * signing; the stateful XMSS OTS path is deferred and never signed in-browser,
 * so there is no rollback footgun in generating a BIP-39/BIP-32 seed locally.
 *
 * Flow (first-run "create" mode):
 *   1) choose a password (encrypts the new key locally);
 *   2) the background worker generates the mnemonic and returns it ONCE;
 *   3) the user is shown the phrase to write down;
 *   4) a confirmation step checks a couple of words, then we finish.
 *
 * In "add" mode (the wallet is already unlocked), there is no password step: the
 * background re-uses the in-memory wallet key to encrypt the new account. We jump
 * straight to generating + backing up the new account's phrase.
 *
 * The mnemonic lives only in component state during backup and is cleared on
 * completion. It is never logged or sent to the network.
 */

import { useEffect, useMemo, useState } from "react";
import { vault, VaultError } from "../api/index.js";
import {
  Button,
  ErrorState,
  Header,
  PasswordField,
} from "../components/index.js";
import { color, font, radius, space } from "../components/theme.js";

type Step = "password" | "backup" | "verify";

export interface CreateWalletProps {
  onCreated: () => void;
  onBack: () => void;
  /**
   * "create" (default): first-run, choose a password and create the vault.
   * "add": vault already unlocked — generate a new account using the in-memory
   * key (no password step).
   */
  mode?: "create" | "add";
}

export function CreateWallet({
  onCreated,
  onBack,
  mode = "create",
}: CreateWalletProps): React.JSX.Element {
  const isAdd = mode === "add";
  const [step, setStep] = useState<Step>(isAdd ? "backup" : "password");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [mnemonic, setMnemonic] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [generating, setGenerating] = useState(false);

  const words = useMemo(
    () => (mnemonic ? mnemonic.trim().split(/\s+/) : []),
    [mnemonic],
  );

  const passwordsOk = password.length >= 8 && password === confirm;

  // In "add" mode, generate the new account immediately (no password screen).
  useEffect(() => {
    if (!isAdd || mnemonic || generating) return;
    setGenerating(true);
    void (async () => {
      setError(null);
      try {
        const res = await vault.addAccount({ mode: "generate" });
        setMnemonic(res.mnemonic);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Couldn't add an account.");
      } finally {
        setGenerating(false);
      }
    })();
  }, [isAdd, mnemonic, generating]);

  async function handleGenerate(): Promise<void> {
    if (!passwordsOk || busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await vault.create(password);
      setMnemonic(res.mnemonic);
      setStep("backup");
    } catch (err) {
      if (err instanceof VaultError && err.code === "VAULT_EXISTS") {
        setError("A wallet already exists. Reset it first to create a new one.");
      } else {
        setError(err instanceof Error ? err.message : "Couldn't create a wallet.");
      }
    } finally {
      setBusy(false);
    }
  }

  function finish(): void {
    // Wipe sensitive local state on completion.
    setMnemonic("");
    setPassword("");
    setConfirm("");
    onCreated();
  }

  if (step === "password") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
        <Header title="Create wallet" onBack={onBack} />
        <p style={{ fontSize: 12, color: color.textDim, lineHeight: 1.5, margin: 0 }}>
          Choose a password to encrypt your new wallet on this device. You'll back
          up a recovery phrase next.
        </p>
        <PasswordField
          value={password}
          onChange={setPassword}
          label="New password (min 8 chars)"
          placeholder="Choose a strong password"
          autoFocus
        />
        <PasswordField
          value={confirm}
          onChange={setConfirm}
          label="Confirm password"
          placeholder="Re-enter the password"
        />
        {password.length > 0 && password !== confirm && (
          <span style={{ fontSize: 11, color: color.danger }}>
            Passwords don't match.
          </span>
        )}
        {error && <ErrorState message={error} />}
        <Button fullWidth busy={busy} disabled={!passwordsOk} onClick={handleGenerate}>
          Generate wallet
        </Button>
      </div>
    );
  }

  if (step === "backup") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
        <Header
          title={isAdd ? "Back up your new account" : "Back up your phrase"}
          {...(isAdd ? { onBack } : {})}
        />
        {isAdd && words.length === 0 && !error && (
          <p style={{ fontSize: 12, color: color.textDim, lineHeight: 1.5, margin: 0 }}>
            Generating your new account…
          </p>
        )}
        {error && <ErrorState message={error} />}
        <p style={{ fontSize: 12, color: color.warn, lineHeight: 1.5, margin: 0 }}>
          Write these words down in order and keep them somewhere safe. Anyone with
          this phrase can spend your funds. Necklace can't recover it for you.
        </p>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: space.xs,
            background: color.surface,
            border: `1px solid ${color.border}`,
            borderRadius: radius.md,
            padding: space.md,
          }}
        >
          {words.map((w, i) => (
            <div
              key={`${i}-${w}`}
              style={{
                display: "flex",
                gap: space.xs,
                fontFamily: font.mono,
                fontSize: 12,
                color: color.text,
              }}
            >
              <span style={{ color: color.textFaint, width: 18, textAlign: "right" }}>
                {i + 1}
              </span>
              <span>{w}</span>
            </div>
          ))}
        </div>

        <label
          style={{
            display: "flex",
            gap: space.sm,
            fontSize: 12,
            color: color.textDim,
            alignItems: "flex-start",
          }}
        >
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(e) => setAcknowledged(e.target.checked)}
          />
          I've written down my recovery phrase.
        </label>

        <Button
          fullWidth
          disabled={!acknowledged || words.length === 0}
          onClick={() => setStep("verify")}
        >
          Continue
        </Button>
      </div>
    );
  }

  // step === "verify"
  return <VerifyBackup words={words} onConfirmed={finish} onBack={() => setStep("backup")} />;
}

/** Word positions (1-indexed) the user must re-enter to confirm their backup. */
const VERIFY_POSITIONS = [4, 8, 12];

/**
 * Spot-check verification: instead of retyping the whole phrase, the user
 * confirms a few specific words (the 4th, 8th, and 12th). Enough to prove the
 * phrase was written down without making it tedious.
 */
function VerifyBackup({
  words,
  onConfirmed,
  onBack,
}: {
  words: string[];
  onConfirmed: () => void;
  onBack: () => void;
}): React.JSX.Element {
  // Only ask for positions that exist (a 12-word phrase has all of 4/8/12).
  const positions = VERIFY_POSITIONS.filter((p) => p <= words.length);
  const [entries, setEntries] = useState<Record<number, string>>({});

  const isCorrect = (pos: number): boolean =>
    (entries[pos] ?? "").trim().toLowerCase() === (words[pos - 1] ?? "").toLowerCase();
  const allCorrect = positions.length > 0 && positions.every(isCorrect);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
      <Header title="Confirm your phrase" onBack={onBack} />
      <p style={{ fontSize: 12, color: color.textDim, lineHeight: 1.5, margin: 0 }}>
        To confirm you saved your recovery phrase, enter words{" "}
        {positions.join(", ")}.
      </p>

      <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        {positions.map((pos) => {
          const val = entries[pos] ?? "";
          const touched = val.trim().length > 0;
          const ok = isCorrect(pos);
          const borderColor = touched
            ? ok
              ? color.success
              : color.danger
            : color.border;
          return (
            <div
              key={pos}
              style={{ display: "flex", flexDirection: "column", gap: space.xs }}
            >
              <label style={{ fontSize: 12, color: color.textDim }}>
                Word #{pos}
              </label>
              <input
                value={val}
                spellCheck={false}
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                placeholder={`Word ${pos}`}
                onChange={(e) =>
                  setEntries((prev) => ({ ...prev, [pos]: e.target.value }))
                }
                style={{
                  fontFamily: font.mono,
                  fontSize: 13,
                  color: color.text,
                  background: color.surfaceAlt,
                  border: `1px solid ${borderColor}`,
                  borderRadius: radius.sm,
                  padding: space.sm,
                  outline: "none",
                }}
              />
            </div>
          );
        })}
      </div>

      <Button fullWidth disabled={!allCorrect} onClick={onConfirmed}>
        Confirm and finish
      </Button>
    </div>
  );
}
