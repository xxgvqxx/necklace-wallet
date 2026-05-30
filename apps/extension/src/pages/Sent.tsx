/**
 * Sent — broadcast success screen. Shows the txid (which the extension computed
 * locally and the node confirmed) and treats an already-known tx as success
 * (idempotent retry). No further action is required.
 */

import { AddressDisplay, Button } from "../components/index.js";
import { IconCheck } from "../components/icons.js";
import { color, font, space } from "../components/theme.js";
import type { Navigate } from "./types.js";

export interface SentProps {
  txid: string;
  alreadyKnown: boolean;
  navigate: Navigate;
}

export function Sent({ txid, alreadyKnown, navigate }: SentProps): React.JSX.Element {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: space.lg,
        flex: 1,
        justifyContent: "center",
        textAlign: "center",
      }}
    >
      <div style={{ display: "flex", justifyContent: "center" }}>
        <IconCheck size={44} color={color.success} />
      </div>
      <h1 style={{ fontSize: 18, margin: 0, fontFamily: font.family }}>
        {alreadyKnown ? "Already on the network" : "Transaction sent"}
      </h1>
      <p style={{ fontSize: 12, color: color.textDim, margin: 0, lineHeight: 1.5 }}>
        {alreadyKnown
          ? "This transaction was already broadcast — nothing was sent twice."
          : "Your transaction has been broadcast to the Pearl network."}
      </p>

      <AddressDisplay address={txid} label="Transaction ID" />

      <Button fullWidth onClick={() => navigate({ name: "home" })}>
        Done
      </Button>
    </div>
  );
}
