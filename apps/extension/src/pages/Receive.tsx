/**
 * Receive — shows the wallet's address as a scannable QR code plus the text
 * address with a copy button. The address is public; nothing secret is shown.
 * The QR is generated locally (bundled encoder, no remote code).
 */

import type { VaultState } from "../api/index.js";
import { AddressDisplay, Header, QrCode } from "../components/index.js";
import { color, space } from "../components/theme.js";
import type { Navigate } from "./types.js";

export interface ReceiveProps {
  state: VaultState;
  navigate: Navigate;
}

export function Receive({ state, navigate }: ReceiveProps): React.JSX.Element {
  const address = state.address?.address;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: space.lg }}>
      <Header title="Receive PRL" onBack={() => navigate({ name: "home" })} />

      {address ? (
        <>
          <div
            style={{
              display: "flex",
              justifyContent: "center",
              padding: space.md,
              background: "#ffffff",
              borderRadius: 12,
              alignSelf: "center",
            }}
          >
            <QrCode value={address} size={208} title="Your Pearl address" />
          </div>

          <AddressDisplay address={address} label="Your address" />

          <p
            style={{
              fontSize: 11,
              color: color.textFaint,
              lineHeight: 1.5,
              margin: 0,
              textAlign: "center",
            }}
          >
            Share this address or QR to receive PRL on {state.network}. Only send
            Pearl (PRL) to this address.
          </p>
        </>
      ) : (
        <p style={{ fontSize: 12, color: color.textDim }}>
          No address available. Unlock or set up your wallet first.
        </p>
      )}
    </div>
  );
}
