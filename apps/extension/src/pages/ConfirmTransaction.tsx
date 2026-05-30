/**
 * ConfirmTransaction — the final review-and-approve screen. This is the security
 * gate: NO signature is produced until the user has seen EVERY output here
 * (threat-model §1, fee-policy §2, §3).
 *
 * It renders, from the locally-built preview:
 *   - every destination output explicitly: recipient, the visible flat Necklace
 *     fee (with its destination address), and change back to the user;
 *   - the itemised FeeBreakdown (recipient / Necklace fee / network fee / total);
 *   - a password field — the password is collected ONLY here, at sign time, and
 *     is passed straight to the background vault and cleared immediately.
 *
 * On approve: vault signs the exact previewed draft -> we POST only the signed
 * rawHex to the broadcast API -> navigate to the Sent screen. The key never
 * leaves the worker; the password never touches the network.
 */

import { useState } from "react";
import { grainToPrl } from "@necklace/shared";
import { VaultError } from "../api/index.js";
import { humanizeApiError, ApiError } from "../api/index.js";
import {
  Button,
  ErrorState,
  FeeBreakdown,
  Header,
  PasswordField,
} from "../components/index.js";
import { color, font, radius, space } from "../components/theme.js";
import { confirmAndSend, type TxPreview } from "../tx/index.js";
import type { Navigate } from "./types.js";

export interface ConfirmTransactionProps {
  preview: TxPreview;
  navigate: Navigate;
}

function OutputRow({
  role,
  address,
  value,
}: {
  role: string;
  address: string;
  value: bigint;
}): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 2,
        padding: `${space.xs}px 0`,
        borderBottom: `1px solid ${color.border}`,
      }}
    >
      <div style={{ display: "flex", justifyContent: "space-between" }}>
        <span style={{ fontSize: 12, color: color.textDim }}>{role}</span>
        <span style={{ fontSize: 13, fontWeight: 600, fontFamily: font.mono }}>
          {grainToPrl(value)} PRL
        </span>
      </div>
      <span
        style={{
          fontSize: 10,
          color: color.textFaint,
          fontFamily: font.mono,
          wordBreak: "break-all",
        }}
      >
        {address}
      </span>
    </div>
  );
}

export function ConfirmTransaction({
  preview,
  navigate,
}: ConfirmTransactionProps): React.JSX.Element {
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<{ kind: "wrong-password" | "tx-rejected" | "backend-down" | "generic"; message: string } | null>(null);

  const { draft, recipient, necklaceFee, networkFee, change, changeDropped } = preview;

  async function handleApprove(): Promise<void> {
    if (password.length === 0 || busy) return;
    setBusy(true);
    setError(null);
    const outcome = await confirmAndSend(preview, password);
    setPassword(""); // clear the secret regardless of result
    setBusy(false);

    if (outcome.ok) {
      navigate({
        name: "sent",
        txid: outcome.result.txid,
        alreadyKnown: outcome.result.alreadyKnown,
      });
      return;
    }

    // Map the failure to a clear, inert message.
    const err = outcome.error;
    if (outcome.stage === "sign") {
      if (err instanceof VaultError && err.code === "WRONG_PASSWORD") {
        setError({ kind: "wrong-password", message: "That password is incorrect." });
      } else if (err instanceof VaultError && err.code === "WATCH_ONLY") {
        setError({ kind: "generic", message: "This is a watch-only wallet and cannot sign." });
      } else {
        setError({
          kind: "generic",
          message: err instanceof Error ? err.message : "Signing failed.",
        });
      }
    } else {
      // broadcast stage
      if (err instanceof ApiError && err.kind === "TX_REJECTED") {
        setError({ kind: "tx-rejected", message: humanizeApiError(err) });
      } else if (err instanceof ApiError && err.kind === "NODE_DOWN") {
        setError({ kind: "backend-down", message: humanizeApiError(err) });
      } else {
        setError({
          kind: "generic",
          message: err instanceof Error ? humanizeApiError(err) : "Broadcast failed.",
        });
      }
    }
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.md }}>
      <Header title="Confirm" onBack={() => navigate({ name: "send" })} />

      {/* Every output, shown explicitly, before signing. */}
      <div
        style={{
          background: color.surface,
          border: `1px solid ${color.border}`,
          borderRadius: radius.md,
          padding: `0 ${space.md}px`,
        }}
      >
        <OutputRow role="To recipient" address={recipient.address} value={recipient.value} />
        <OutputRow
          role="Necklace fee"
          address={necklaceFee.address}
          value={necklaceFee.value}
        />
        {draft.change && (
          <OutputRow
            role="Change (to you)"
            address={draft.change.address}
            value={draft.change.value}
          />
        )}
      </div>

      {/* Itemised, transparent fee breakdown. */}
      <FeeBreakdown
        recipientValue={recipient.value}
        necklaceFeeValue={necklaceFee.value}
        necklaceFeeAddress={necklaceFee.address}
        networkFee={networkFee}
        change={change}
        changeDropped={changeDropped}
      />

      <span style={{ fontSize: 11, color: color.textFaint }}>
        {draft.inputs.length} input{draft.inputs.length === 1 ? "" : "s"} •{" "}
        {outputsSummary(draft)} • network: {preview.network}
      </span>

      {/* Password — collected only here, at sign time. */}
      <PasswordField
        value={password}
        onChange={setPassword}
        label="Password (to sign)"
        placeholder="Enter your password to sign"
        autoFocus
        onEnter={handleApprove}
      />

      {error && (
        <ErrorState
          kind={error.kind}
          message={error.message}
          onRetry={error.kind === "backend-down" ? () => void handleApprove() : undefined}
        />
      )}

      <Button fullWidth busy={busy} disabled={password.length === 0} onClick={handleApprove}>
        Approve and send
      </Button>
    </div>
  );
}

/** Short outputs summary string. */
function outputsSummary(draft: TxPreview["draft"]): string {
  const outs = draft.recipients.length + 1 + (draft.change ? 1 : 0); // +1 fee
  return `${outs} outputs`;
}
