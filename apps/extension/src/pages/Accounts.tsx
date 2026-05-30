/**
 * Accounts — the account switcher / manager.
 *
 * Lists every account (label, truncated address, active check). Tapping a row
 * switches the active account (no password — the whole wallet is unlocked by one
 * password) and returns home. An "Add account" action offers Generate or Import,
 * reusing the CreateWallet / ImportWallet flows in "add" mode (which call
 * ADD_ACCOUNT instead of creating the vault). Each account can be renamed; remove
 * is offered for every account but disabled when only one remains (the last
 * account can't be removed — reset the wallet from Settings instead).
 *
 * No secrets are handled here: switching/renaming/removing are all metadata
 * operations on the already-unlocked vault.
 */

import { useState } from "react";
import type { VaultState } from "../api/index.js";
import { vault, VaultError } from "../api/index.js";
import { Button, ErrorState, Header } from "../components/index.js";
import { color, font, radius, space } from "../components/theme.js";
import { CreateWallet } from "./CreateWallet.js";
import { ImportWallet } from "./ImportWallet.js";
import type { Navigate } from "./types.js";

export interface AccountsProps {
  state: VaultState;
  navigate: Navigate;
  /** Re-read vault state after a switch/add/rename/remove. */
  onChanged: () => void;
}

type View = "list" | "choose-add" | "add-generate" | "add-import";

/** Short avatar text: first two non-space chars of the label, uppercased. */
function avatarText(label: string): string {
  const cleaned = label.replace(/\s+/g, "");
  return (cleaned.slice(0, 2) || "A").toUpperCase();
}

/** Truncate a bech32m address for compact display. */
function truncateAddress(addr: string): string {
  if (addr.length <= 16) return addr;
  return `${addr.slice(0, 8)}…${addr.slice(-6)}`;
}

export function Accounts({ state, navigate, onChanged }: AccountsProps): React.JSX.Element {
  const [view, setView] = useState<View>("list");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);

  const accounts = state.accounts ?? [];
  const activeId = state.activeAccountId;
  const onlyOne = accounts.length <= 1;

  async function switchTo(id: string): Promise<void> {
    if (busy || id === activeId) {
      if (id === activeId) navigate({ name: "home" });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await vault.switchAccount(id);
      onChanged();
      navigate({ name: "home" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't switch account.");
      setBusy(false);
    }
  }

  async function doRename(id: string): Promise<void> {
    const label = renameValue.trim();
    if (label.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await vault.renameAccount(id, label);
      setRenaming(null);
      setRenameValue("");
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't rename account.");
    } finally {
      setBusy(false);
    }
  }

  async function doRemove(id: string): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      await vault.removeAccount(id);
      onChanged();
    } catch (err) {
      if (err instanceof VaultError && err.code === "VAULT_EXISTS") {
        setError("You can't remove your only account. Reset the wallet in Settings instead.");
      } else {
        setError(err instanceof Error ? err.message : "Couldn't remove account.");
      }
    } finally {
      setBusy(false);
      setConfirmingRemove(null);
    }
  }

  if (view === "add-generate") {
    return (
      <CreateWallet
        mode="add"
        onCreated={() => {
          onChanged();
          navigate({ name: "home" });
        }}
        onBack={() => setView("list")}
      />
    );
  }

  if (view === "add-import") {
    return (
      <ImportWallet
        mode="add"
        onImported={() => {
          onChanged();
          navigate({ name: "home" });
        }}
        onBack={() => setView("list")}
      />
    );
  }

  if (view === "choose-add") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
        <Header title="Add account" onBack={() => setView("list")} />
        <p style={{ fontSize: 12, color: color.textDim, lineHeight: 1.5, margin: 0 }}>
          Add another account to this wallet. It's protected by your existing
          password — you won't need to enter it again to switch.
        </p>
        <Button fullWidth onClick={() => setView("add-generate")}>
          Generate a new account
        </Button>
        <Button variant="secondary" fullWidth onClick={() => setView("add-import")}>
          Import an existing key
        </Button>
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
      <Header title="Accounts" onBack={() => navigate({ name: "home" })} />

      {error && <ErrorState message={error} />}

      <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        {accounts.map((acc) => {
          const isActive = acc.id === activeId;
          const isRenaming = renaming === acc.id;
          return (
            <div
              key={acc.id}
              style={{
                display: "flex",
                flexDirection: "column",
                gap: space.sm,
                background: color.surface,
                border: `1px solid ${isActive ? color.accent : color.border}`,
                borderRadius: radius.md,
                padding: space.md,
              }}
            >
              <div style={{ display: "flex", alignItems: "center", gap: space.sm }}>
                <span
                  aria-hidden
                  style={{
                    width: 32,
                    height: 32,
                    flexShrink: 0,
                    borderRadius: "50%",
                    background: color.surfaceAlt,
                    border: `1px solid ${color.border}`,
                    color: color.text,
                    fontSize: 12,
                    fontWeight: 700,
                    fontFamily: font.family,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  {avatarText(acc.label)}
                </span>
                <button
                  type="button"
                  onClick={() => void switchTo(acc.id)}
                  disabled={busy}
                  style={{
                    flex: 1,
                    textAlign: "left",
                    background: "transparent",
                    border: "none",
                    cursor: busy ? "default" : "pointer",
                    padding: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: 2,
                  }}
                >
                  <span
                    style={{
                      fontSize: 13,
                      fontWeight: 600,
                      color: color.text,
                      fontFamily: font.family,
                    }}
                  >
                    {acc.label}
                    {acc.watchOnly ? " • watch-only" : ""}
                  </span>
                  {acc.address && (
                    <span
                      style={{
                        fontSize: 11,
                        color: color.textDim,
                        fontFamily: font.mono,
                      }}
                    >
                      {truncateAddress(acc.address)}
                    </span>
                  )}
                </button>
                {isActive && (
                  <span
                    style={{
                      fontSize: 10,
                      fontWeight: 700,
                      color: color.accentText,
                      background: color.accent,
                      borderRadius: radius.sm,
                      padding: `2px ${space.xs}px`,
                      textTransform: "uppercase",
                    }}
                  >
                    Active
                  </span>
                )}
              </div>

              {isRenaming ? (
                <div style={{ display: "flex", gap: space.sm }}>
                  <input
                    value={renameValue}
                    autoFocus
                    spellCheck={false}
                    placeholder="Account name"
                    onChange={(e) => setRenameValue(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") void doRename(acc.id);
                      if (e.key === "Escape") setRenaming(null);
                    }}
                    style={{
                      flex: 1,
                      fontFamily: font.family,
                      fontSize: 12,
                      color: color.text,
                      background: color.surfaceAlt,
                      border: `1px solid ${color.border}`,
                      borderRadius: radius.sm,
                      padding: space.sm,
                      outline: "none",
                    }}
                  />
                  <button
                    type="button"
                    onClick={() => void doRename(acc.id)}
                    disabled={busy || renameValue.trim().length === 0}
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: color.accent,
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                    }}
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setRenaming(null)}
                    style={{
                      fontSize: 11,
                      color: color.textDim,
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                    }}
                  >
                    Cancel
                  </button>
                </div>
              ) : confirmingRemove === acc.id ? (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    gap: space.sm,
                    background: color.dangerSurface,
                    border: `1px solid ${color.danger}`,
                    borderRadius: radius.sm,
                    padding: space.sm,
                  }}
                >
                  <span style={{ fontSize: 11, color: color.text, lineHeight: 1.4 }}>
                    Remove {acc.label}? It will be deleted from this device. You can
                    only restore it with its recovery phrase.
                  </span>
                  <div style={{ display: "flex", gap: space.md }}>
                    <button
                      type="button"
                      onClick={() => void doRemove(acc.id)}
                      disabled={busy}
                      style={{
                        fontSize: 11,
                        fontWeight: 700,
                        color: color.danger,
                        background: "transparent",
                        border: "none",
                        cursor: busy ? "default" : "pointer",
                        padding: 0,
                      }}
                    >
                      Remove account
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmingRemove(null)}
                      disabled={busy}
                      style={{
                        fontSize: 11,
                        color: color.textDim,
                        background: "transparent",
                        border: "none",
                        cursor: "pointer",
                        padding: 0,
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{ display: "flex", gap: space.md }}>
                  <button
                    type="button"
                    onClick={() => {
                      setRenaming(acc.id);
                      setRenameValue(acc.label);
                      setError(null);
                    }}
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: color.textDim,
                      background: "transparent",
                      border: "none",
                      cursor: "pointer",
                      padding: 0,
                    }}
                  >
                    Rename
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setConfirmingRemove(acc.id);
                      setError(null);
                    }}
                    disabled={busy || onlyOne}
                    title={
                      onlyOne
                        ? "You can't remove your only account."
                        : "Remove this account"
                    }
                    style={{
                      fontSize: 11,
                      fontWeight: 600,
                      color: onlyOne ? color.textFaint : color.danger,
                      background: "transparent",
                      border: "none",
                      cursor: onlyOne ? "default" : "pointer",
                      padding: 0,
                    }}
                  >
                    Remove
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>

      <Button fullWidth onClick={() => { setError(null); setView("choose-add"); }}>
        Add account
      </Button>
    </div>
  );
}
