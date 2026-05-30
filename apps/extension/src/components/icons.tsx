/**
 * Inline SVG icons (stroke = currentColor) used in place of emoji glyphs, so
 * the UI renders consistently across platforms and carries no emoji. All are
 * bundled, inert SVG — no remote assets, no script.
 */

export interface IconProps {
  /** Square size in px. */
  size?: number;
  /** Stroke colour; defaults to `currentColor` so it inherits text colour. */
  color?: string;
  /** Accessible label; when omitted the icon is decorative (aria-hidden). */
  title?: string;
}

function svgProps(size: number, color: string, title?: string) {
  return {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    // Stroke via currentColor + CSS `color` so CSS-variable theme tokens
    // (e.g. var(--nk-success)) resolve — an SVG `stroke` attribute would not.
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    style: { color },
    role: title ? "img" : undefined,
    "aria-hidden": title ? undefined : true,
    "aria-label": title,
  };
}

export function IconSearch({ size = 16, color = "currentColor", title }: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(size, color, title)}>
      <circle cx="11" cy="11" r="7" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  );
}

export function IconSettings({ size = 16, color = "currentColor", title }: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(size, color, title)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V15z" />
    </svg>
  );
}

export function IconBack({ size = 18, color = "currentColor", title }: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(size, color, title)}>
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="12 19 5 12 12 5" />
    </svg>
  );
}

export function IconRefresh({ size = 14, color = "currentColor", title }: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(size, color, title)}>
      <path d="M21 12a9 9 0 1 1-2.64-6.36" />
      <polyline points="21 3 21 9 15 9" />
    </svg>
  );
}

export function IconCheck({ size = 44, color = "currentColor", title }: IconProps): React.JSX.Element {
  return (
    <svg {...svgProps(size, color, title)}>
      <circle cx="12" cy="12" r="10" />
      <polyline points="8 12 11 15 16 9" />
    </svg>
  );
}

/** The X (formerly Twitter) logo. Filled (uses CSS `fill` so theme vars resolve). */
export function IconX({ size = 14, color = "currentColor", title }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ fill: color }}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
    </svg>
  );
}

/** The GitHub mark. Filled (uses CSS `fill` so theme vars resolve). */
export function IconGitHub({ size = 15, color = "currentColor", title }: IconProps): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      style={{ fill: color }}
      role={title ? "img" : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
    >
      <path d="M12 .5C5.37.5 0 5.78 0 12.292c0 5.211 3.438 9.63 8.205 11.188.6.111.82-.254.82-.567 0-.28-.01-1.022-.015-2.005-3.338.711-4.042-1.582-4.042-1.582-.546-1.361-1.335-1.725-1.335-1.725-1.087-.731.084-.716.084-.716 1.205.082 1.838 1.215 1.838 1.215 1.07 1.803 2.809 1.282 3.495.981.108-.763.417-1.282.76-1.577-2.665-.295-5.466-1.309-5.466-5.827 0-1.287.465-2.339 1.235-3.164-.135-.297-.54-1.497.105-3.121 0 0 1.005-.316 3.3 1.209a11.5 11.5 0 0 1 3-.398c1.02.006 2.04.136 3 .398 2.28-1.525 3.285-1.209 3.285-1.209.645 1.624.24 2.824.12 3.121.765.825 1.23 1.877 1.23 3.164 0 4.53-2.805 5.527-5.475 5.817.42.354.81 1.077.81 2.182 0 1.578-.015 2.846-.015 3.229 0 .309.21.678.825.561C20.565 21.917 24 17.495 24 12.292 24 5.78 18.627.5 12 .5z" />
    </svg>
  );
}

/**
 * Liquid brand mark (liquid.trade). Two official tiles swapped by theme via the
 * `.nk-liquid-*` rules in index.html: the light tile shows on the default
 * Monokai dark theme, the dark tile on Monokai light.
 */
export function LiquidLogo({ size = 14 }: { size?: number }): React.JSX.Element {
  return (
    <>
      <span className="nk-liquid-dark-theme" aria-hidden="true">
        <svg width={size} height={size} viewBox="0 0 1000 1000" style={{ display: "block" }}>
          <rect width="1000" height="1000" rx="200" ry="200" fill="#ededff" />
          <path
            d="M707.229,438.351l-160.114-241.308c-22.367-33.708-71.865-33.708-94.232,0l-160.115,241.308c-15.885,23.488-27.883,49.822-35.069,78.075-5.028,19.768-7.699,40.477-7.699,61.811,0,138.071,111.929,250,250,250s250-111.93,250-250c0-51.824-15.769-99.963-42.771-139.885h0Z"
            fill="#131318"
          />
        </svg>
      </span>
      <span className="nk-liquid-light-theme" aria-hidden="true">
        <svg width={size} height={size} viewBox="0 0 1000 1000" style={{ display: "block" }}>
          <rect width="1000" height="1000" rx="200" ry="200" fill="#131318" />
          <path
            d="M698.94,440.817l-153.709-231.655c-21.472-32.359-68.991-32.359-90.463,0l-153.71,231.655c-15.25,22.549-26.768,47.829-33.666,74.952-4.826,18.977-7.391,38.857-7.391,59.339,0,132.548,107.452,240,240,240s240-107.453,240-240c0-49.751-15.139-95.965-41.06-134.29h0Z"
            fill="#ededff"
          />
        </svg>
      </span>
    </>
  );
}
