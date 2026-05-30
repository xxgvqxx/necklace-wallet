# Security Policy

Necklace is **non-custodial**: your recovery phrase and keys are generated and
encrypted on your device and are never sent anywhere. As with any wallet, please
verify builds yourself (`pnpm install && pnpm build`) before trusting it with
real funds.

## Reporting a vulnerability

If you find a security issue, please report it **privately** — do not open a
public issue or PR that discloses it.

- DM **[@gvq_xx](https://x.com/gvq_xx)** on X, or
- Use GitHub's **private vulnerability reporting** on this repo
  (the **Security** tab → **Report a vulnerability**).

Please include enough detail to reproduce: affected version/commit, steps, and
impact. I'll acknowledge as soon as I can and coordinate a fix and disclosure.

## Scope

In scope: the extension (`apps/extension`) and the crypto/vault packages
(`packages/wallet-core`, `packages/shared`) in this repository.

Out of scope: third-party services the wallet talks to (the public Pearl
Blockbook node and SafeTrade), and the Pearl network/protocol itself.

## Supported versions

This project is pre-1.0; only the latest `main` (and latest release) receives
security fixes.
