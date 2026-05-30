/**
 * Welcome — first-run screen shown when no vault exists. Offers the two MVP
 * onboarding paths: import an existing key, or generate a new wallet.
 *
 * In-browser generation is offered because Phase 1 confirmed it is SAFE for this
 * wallet: the only signing on the send/receive path is secp256k1 BIP-340
 * Schnorr (Taproot key-path), which is stateless. The catastrophic-footgun
 * stateful XMSS OTS path is NOT signed in-browser and is deferred, so generating
 * a BIP-39/BIP-32 seed locally carries no rollback risk.
 */

import { Button } from "../components/index.js";
import { Logo } from "../components/Logo.js";
import { color, font, space } from "../components/theme.js";

export interface WelcomeProps {
  onImport: () => void;
  onCreate: () => void;
}

export function Welcome({ onImport, onCreate }: WelcomeProps): React.JSX.Element {
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
          <Logo size={72} />
        </div>
        <h1 style={{ fontSize: 20, margin: `${space.sm}px 0 0`, fontFamily: font.family }}>
          Welcome to Necklace
        </h1>
        <p
          style={{
            fontSize: 13,
            color: color.textDim,
            marginTop: space.sm,
            lineHeight: 1.5,
          }}
        >
          A non-custodial wallet for Pearl (PRL). Your keys are encrypted and
          stored only on this device — they never leave the extension.
        </p>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: space.sm }}>
        <Button fullWidth onClick={onCreate}>
          Create a new wallet
        </Button>
        <Button variant="secondary" fullWidth onClick={onImport}>
          Import an existing wallet
        </Button>
      </div>
    </div>
  );
}
