/**
 * Contacts — the saved address book. Lists contacts (name + address); tapping
 * one uses it as the Send recipient, and each can be removed. Contacts are added
 * from the Send screen after entering a valid address. Non-secret, read from
 * chrome.storage.local.
 */

import { useCallback, useEffect, useState } from "react";
import { Header } from "../components/index.js";
import { color, font, radius, space } from "../components/theme.js";
import { type Contact, listContacts, removeContact } from "../contacts/contacts-store.js";
import type { Navigate } from "./types.js";

function truncateAddress(addr: string): string {
  return addr.length > 18 ? `${addr.slice(0, 10)}…${addr.slice(-6)}` : addr;
}

export function Contacts({ navigate }: { navigate: Navigate }): React.JSX.Element {
  const [contacts, setContacts] = useState<Contact[] | null>(null);

  const load = useCallback(async () => {
    setContacts(await listContacts());
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
      <Header title="Contacts" onBack={() => navigate({ name: "send" })} />

      {contacts === null ? null : contacts.length === 0 ? (
        <p
          style={{
            fontSize: 12,
            color: color.textDim,
            textAlign: "center",
            lineHeight: 1.5,
            padding: space.lg,
          }}
        >
          No contacts yet. On the Send screen, enter an address and tap Add to
          save it here.
        </p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
          {contacts.map((c) => (
            <div
              key={c.address}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: space.sm,
                background: color.surface,
                border: `1px solid ${color.border}`,
                borderRadius: radius.md,
                padding: space.md,
              }}
            >
              <button
                type="button"
                onClick={() => navigate({ name: "send", prefillAddress: c.address })}
                style={{
                  flex: 1,
                  minWidth: 0,
                  textAlign: "left",
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
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
                  {c.name}
                </span>
                <span
                  style={{
                    fontSize: 11,
                    color: color.textDim,
                    fontFamily: font.mono,
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {truncateAddress(c.address)}
                </span>
              </button>
              <button
                type="button"
                onClick={async () => {
                  await removeContact(c.address);
                  await load();
                }}
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: color.danger,
                  background: "transparent",
                  border: "none",
                  cursor: "pointer",
                  padding: 0,
                  flexShrink: 0,
                }}
              >
                Remove
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
