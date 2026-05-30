/**
 * ImportWallet — import an existing key and encrypt it locally.
 *
 * Supported formats (Phase 1 import.go / wif.go): WIF (base58check), raw 32-byte
 * hex private key, BIP-39 mnemonic (-> BIP-32 -> BIP-86 seed), and xpub /
 * account extended PUBLIC key (watch-only — cannot sign). XMSS material is never
 * importable (it is always HD-derived), so it is not offered here.
 *
 * The secret and password are sent to the background worker (which does the
 * actual decode/derive/encrypt) in a single message and are cleared from this
 * component immediately. Neither is ever logged or sent to the network.
 *
 * In "add" mode (the wallet is already unlocked) there is no password step: the
 * background re-uses the in-memory wallet key to encrypt the imported account.
 */

import { useMemo, useState } from "react";
import type { KeyImportKind } from "@necklace/shared";
import { vault, VaultError } from "../api/index.js";
import {
  Button,
  ErrorState,
  Header,
  PasswordField,
} from "../components/index.js";
import { color, font, radius, space } from "../components/theme.js";

interface KindOption {
  kind: KeyImportKind;
  label: string;
  hint: string;
  watchOnly?: boolean;
}

const KINDS: KindOption[] = [
  { kind: "mnemonic", label: "Recovery phrase", hint: "12 or 24 words, space-separated." },
  { kind: "wif", label: "WIF private key", hint: "Base58 key beginning with a network prefix." },
  { kind: "rawHex", label: "Raw private key", hint: "64 hex characters (32 bytes)." },
  { kind: "xpub", label: "Watch-only (xpub)", hint: "Account extended public key — view only, cannot send.", watchOnly: true },
];

export interface ImportWalletProps {
  onImported: () => void;
  onBack: () => void;
  /**
   * "import" (default): first-run, choose a password and create the vault.
   * "add": vault already unlocked — import a new account using the in-memory key
   * (no password step).
   */
  mode?: "import" | "add";
}

export function ImportWallet({
  onImported,
  onBack,
  mode = "import",
}: ImportWalletProps): React.JSX.Element {
  const isAdd = mode === "add";
  const [kind, setKind] = useState<KeyImportKind>("mnemonic");
  const [secret, setSecret] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = useMemo(() => KINDS.find((k) => k.kind === kind)!, [kind]);
  const isWatchOnly = selected.watchOnly === true;

  // Watch-only imports still need a password (to protect the stored xpub/metadata),
  // but the user is told this wallet cannot send. In "add" mode there is no
  // password step (the in-memory wallet key is reused).
  const passwordsOk = isAdd || (password.length >= 8 && password === confirm);
  const canSubmit = secret.trim().length > 0 && passwordsOk && !busy;

  async function handleImport(): Promise<void> {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      if (isAdd) {
        await vault.addAccount({ mode: "import", kind, secret: secret.trim() });
      } else {
        await vault.import({ kind, secret: secret.trim(), password });
      }
      // Clear secrets from memory ASAP.
      setSecret("");
      setPassword("");
      setConfirm("");
      onImported();
    } catch (err) {
      if (err instanceof VaultError && err.code === "INVALID_KEY") {
        setError("That key material couldn't be read. Check the format and try again.");
      } else if (err instanceof VaultError && err.code === "VAULT_EXISTS") {
        setError("A wallet already exists. Reset it first to import a different one.");
      } else {
        setError(err instanceof Error ? err.message : "Import failed.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
      <Header title={isAdd ? "Import account" : "Import wallet"} onBack={onBack} />

      <div style={{ display: "flex", flexWrap: "wrap", gap: space.xs }}>
        {KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            onClick={() => {
              setKind(k.kind);
              setError(null);
            }}
            style={{
              fontSize: 11,
              fontWeight: 600,
              padding: `${space.xs}px ${space.sm}px`,
              borderRadius: radius.sm,
              cursor: "pointer",
              color: kind === k.kind ? color.accentText : color.textDim,
              background: kind === k.kind ? color.accent : color.surfaceAlt,
              border: `1px solid ${kind === k.kind ? color.accent : color.border}`,
            }}
          >
            {k.label}
          </button>
        ))}
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: space.xs }}>
        <label style={{ fontSize: 12, color: color.textDim, fontFamily: font.family }}>
          {selected.label}
        </label>
        <textarea
          value={secret}
          rows={kind === "mnemonic" ? 3 : 2}
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          placeholder={selected.hint}
          onChange={(e) => setSecret(e.target.value)}
          style={{
            fontFamily: font.mono,
            fontSize: 12,
            color: color.text,
            background: color.surfaceAlt,
            border: `1px solid ${color.border}`,
            borderRadius: radius.sm,
            padding: space.sm,
            resize: "none",
            wordBreak: "break-all",
            outline: "none",
          }}
        />
        <span style={{ fontSize: 11, color: color.textFaint }}>{selected.hint}</span>
      </div>

      {isWatchOnly && (
        <div
          style={{
            fontSize: 11,
            color: color.warn,
            background: color.surfaceAlt,
            border: `1px solid ${color.border}`,
            borderRadius: radius.sm,
            padding: space.sm,
          }}
        >
          Watch-only: you'll be able to view balances and history, but this wallet
          cannot sign or send transactions.
        </div>
      )}

      {!isAdd && (
        <>
          <PasswordField
            value={password}
            onChange={setPassword}
            label="New password (min 8 chars)"
            placeholder="Choose a strong password"
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
        </>
      )}

      {isAdd && (
        <span style={{ fontSize: 11, color: color.textFaint }}>
          This account is encrypted with your existing wallet password.
        </span>
      )}

      {error && <ErrorState message={error} />}

      <Button fullWidth busy={busy} disabled={!canSubmit} onClick={handleImport}>
        {isAdd ? "Import account" : "Import wallet"}
      </Button>
    </div>
  );
}
