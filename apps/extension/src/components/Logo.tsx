/**
 * Logo — the Necklace mark: a transparent-background ring of pearls. Bundled
 * locally as `public/necklace-logo.png` and served from the extension origin
 * (CSP img-src 'self'); no remote image is ever loaded. Transparent, so it sits
 * cleanly on either Monokai theme with no card/background.
 */

export interface LogoProps {
  /** Rendered square size in px. */
  size?: number;
  /** Optional corner rounding (none by default — the mark is transparent). */
  radius?: number;
}

export function Logo({ size = 48, radius }: LogoProps): React.JSX.Element {
  return (
    <img
      src="/necklace-logo.png"
      width={size}
      height={size}
      alt="Necklace"
      draggable={false}
      style={{
        display: "block",
        ...(radius ? { borderRadius: radius } : {}),
        userSelect: "none",
      }}
    />
  );
}
