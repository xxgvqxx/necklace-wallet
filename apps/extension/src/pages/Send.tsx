/**
 * Send — compose a payment. The user enters a recipient address and amount;
 * the screen validates LOCALLY, fetches the wallet's UTXOs and an advisory fee
 * rate from the indexer, and builds the transaction PREVIEW locally (recipient
 * + the visible flat Necklace fee + network fee + change).
 *
 * No password is requested here and NOTHING is signed. On "Review" we navigate
 * to ConfirmTransaction, which shows every output before the user approves and
 * is the only place the password is collected (threat-model §1, fee-policy §2).
 */

import { useEffect, useState } from "react";
import type { VaultState } from "../api/index.js";
import { ApiError, getApiClient, humanizeApiError } from "../api/index.js";
import { prlToGrain, grainToPrl } from "@necklace/shared";
import {
  AddressField,
  AmountInput,
  Button,
  ErrorState,
  Header,
} from "../components/index.js";
import { color, font, radius, space } from "../components/theme.js";
import { addContact, listContacts, type Contact } from "../contacts/contacts-store.js";
import {
  buildTxPreview,
  FeePolicyError,
  InsufficientFundsError,
  isFeeConfigured,
  toSpendableUtxos,
  validateAddress,
  validateAmount,
  MAX_RELAY_FEE_PER_KB,
} from "../tx/index.js";
import type { Navigate } from "./types.js";

export interface SendProps {
  state: VaultState;
  navigate: Navigate;
  /** Optional recipient to prefill (e.g. chosen from Contacts). */
  prefillAddress?: string;
}

export function Send({ state, navigate, prefillAddress }: SendProps): React.JSX.Element {
  const [address, setAddress] = useState(prefillAddress ?? "");
  const [amount, setAmount] = useState("");
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [addingContact, setAddingContact] = useState(false);
  const [contactName, setContactName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ kind: "backend-down" | "insufficient-funds" | "generic" | "invalid-address"; message: string } | null>(null);

  const addrResult = validateAddress(address, state.network);
  const amtResult = validateAmount(amount);
  const feeReady = isFeeConfigured(state.network);
  const canReview =
    addrResult.valid && amtResult.valid && feeReady && !busy && !state.watchOnly;

  useEffect(() => {
    void listContacts().then(setContacts);
  }, []);

  const normalizedAddr = address.trim().toLowerCase();
  const knownContact = addrResult.valid
    ? contacts.find((c) => c.address.trim().toLowerCase() === normalizedAddr)
    : undefined;

  async function saveContact(): Promise<void> {
    const name = contactName.trim();
    if (name.length === 0 || !addrResult.valid) return;
    await addContact(name, address.trim());
    setContacts(await listContacts());
    setAddingContact(false);
    setContactName("");
  }

  async function handleReview(): Promise<void> {
    if (!canReview || !state.address) return;
    setBusy(true);
    setError(null);
    try {
      const client = getApiClient();
      // Fetch the wallet's UTXOs (mandatory: each prevout value feeds the
      // BIP-341 sighash) and an advisory relay-fee rate.
      const [utxosRes, feesRes] = await Promise.all([
        client.utxos(state.address.address, { minConf: 1 }),
        client.fees().catch(() => null), // advisory; fall back to default on failure
      ]);

      const utxos = toSpendableUtxos(utxosRes.utxos, { minConf: 1 });
      if (utxos.length === 0) {
        setError({
          kind: "insufficient-funds",
          message: "No spendable UTXOs found for this wallet yet.",
        });
        return;
      }

      // Clamp the advisory rate; the builder also clamps to [MIN, MAX].
      const relayFeePerKb = feesRes
        ? feesRes.feePerKb > MAX_RELAY_FEE_PER_KB
          ? MAX_RELAY_FEE_PER_KB
          : feesRes.feePerKb
        : undefined;

      const preview = buildTxPreview({
        network: state.network,
        utxos,
        recipientAddress: address.trim(),
        recipientValue: prlToGrain(amount.trim()),
        changeAddress: state.address.address,
        relayFeePerKb,
      });

      navigate({ name: "confirm", preview });
    } catch (err) {
      if (err instanceof InsufficientFundsError) {
        setError({
          kind: "insufficient-funds",
          message:
            `You need ${grainToPrl(err.required)} PRL ` +
            `(amount ${grainToPrl(err.recipientValue)} + Necklace fee ` +
            `${grainToPrl(err.necklaceFee)} + network fee ` +
            `${grainToPrl(err.networkFee)}) but have ${grainToPrl(err.available)} PRL.`,
        });
      } else if (err instanceof FeePolicyError) {
        setError({ kind: "generic", message: err.message });
      } else if (err instanceof ApiError) {
        setError({
          kind: err.kind === "NODE_DOWN" ? "backend-down" : "generic",
          message: humanizeApiError(err),
        });
      } else {
        setError({
          kind: "generic",
          message: err instanceof Error ? err.message : "Couldn't build the transaction.",
        });
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
      <Header
        title="Send PRL"
        onBack={() => navigate({ name: "home" })}
        right={
          <button
            type="button"
            onClick={() => navigate({ name: "contacts" })}
            style={{
              fontSize: 12,
              fontWeight: 600,
              color: color.accent,
              background: "transparent",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            Contacts
          </button>
        }
      />

      {!feeReady && (
        <ErrorState
          title="Sending unavailable"
          message={`The Necklace fee isn't configured for ${state.network}. Sending is disabled until it is pinned.`}
        />
      )}

      <AddressField
        value={address}
        network={state.network}
        onChange={(v) => {
          setAddress(v);
          setAddingContact(false);
        }}
        suppressError={address.trim().length === 0}
      />

      {addrResult.valid &&
        (knownContact ? (
          <div style={{ fontSize: 11, color: color.textDim }}>
            Saved contact:{" "}
            <span style={{ color: color.text, fontWeight: 600 }}>
              {knownContact.name}
            </span>
          </div>
        ) : addingContact ? (
          <div style={{ display: "flex", gap: space.sm, alignItems: "center" }}>
            <input
              value={contactName}
              autoFocus
              spellCheck={false}
              placeholder="Contact name"
              onChange={(e) => setContactName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void saveContact();
                if (e.key === "Escape") setAddingContact(false);
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
              onClick={() => void saveContact()}
              disabled={contactName.trim().length === 0}
              style={{
                fontSize: 12,
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
              onClick={() => setAddingContact(false)}
              style={{
                fontSize: 12,
                color: color.textDim,
                background: "transparent",
                border: "none",
                cursor: "pointer",
              }}
            >
              Cancel
            </button>
          </div>
        ) : (
          <div
            style={{
              display: "flex",
              gap: space.sm,
              alignItems: "center",
              fontSize: 12,
              color: color.textDim,
            }}
          >
            <span>Add to contacts?</span>
            <button
              type="button"
              onClick={() => {
                setContactName("");
                setAddingContact(true);
              }}
              style={{
                fontSize: 12,
                fontWeight: 600,
                color: color.accent,
                background: color.surfaceAlt,
                border: `1px solid ${color.border}`,
                borderRadius: radius.sm,
                padding: `2px ${space.sm}px`,
                cursor: "pointer",
              }}
            >
              Add
            </button>
          </div>
        ))}

      <AmountInput
        value={amount}
        onChange={setAmount}
        suppressError={amount.trim().length === 0}
      />

      {error && (
        <ErrorState
          kind={error.kind}
          message={error.message}
          onRetry={error.kind === "backend-down" ? () => void handleReview() : undefined}
        />
      )}

      <Button fullWidth busy={busy} disabled={!canReview} onClick={handleReview}>
        Review transaction
      </Button>

      <p style={{ fontSize: 11, color: color.textFaint, lineHeight: 1.5, margin: 0 }}>
        You'll see every output — including the flat Necklace fee and the network
        fee — and enter your password on the next screen before anything is signed.
      </p>
    </div>
  );
}
