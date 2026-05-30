# Necklace Wallet — Fee Policy

**Status:** Phase 0 product/security doc. Grounded in `docs/protocol-findings.md` (Phase 1, authoritative).
**Date:** 2026-05-29
**Scope:** How Necklace charges its wallet fee, how it interacts with the Pearl network relay fee, and the non-negotiable transparency rules around both.

---

## 1. Two distinct fees — keep them separate

A Necklace send involves **two unrelated amounts** that the user must see clearly:

1. **Network relay fee (paid to the chain, not to Necklace).** This is the ordinary miner/relay fee, the difference between total input value and total output value. Pearl expresses relay fee as **Grain per 1000 bytes** (`DefaultRelayFeePerKb = 1000 Grain/kB`); the actual fee for a tx is `relayFeePerKb * txSerializeSize / 1000`, floored to `relayFeePerKb` if it would round to zero. Necklace receives **none** of this — it goes to the network.

2. **Necklace flat wallet fee (paid to Necklace).** A **flat PRL amount**, added as a **separate, visible transaction output** paying a Necklace-controlled address. This is the *only* way Necklace monetizes a send. It is an ordinary P2TR output; nothing special happens protocol-side.

These are never blended into a single displayed number. The user always sees: amount to recipient, Necklace fee (flat), network relay fee, and the resulting total deducted from their balance.

---

## 2. The flat-fee model (the core decision)

> **Necklace charges a FLAT PRL amount, added as an explicit extra transaction output to a Necklace-controlled address, always shown to the user before signing, never hidden.**

Rules (all non-negotiable):

- **Flat, not percentage.** The fee is a fixed PRL amount per send, independent of the amount being transferred. (Exact amount: see §5 TODO.)
- **A real, separate output.** The fee is a `wire.TxOut` in the transaction paying the pinned Necklace fee address. It is visible on-chain and in any block explorer. It is *not* skimmed from change, *not* hidden in the relay fee, and *not* a separate off-chain charge.
- **Above the dust floor.** The fee output must exceed the Pearl dust threshold (~546 Grain at the default relay fee for a P2TR output; computed from the real output/input vsize). The flat fee amount chosen in §5 must always clear dust. If a configured fee were ever below dust, the build must fail closed rather than emit a dust output.
- **Always shown before signing.** The confirmation screen (rendered by the extension, per `threat-model.md` §1) itemizes the Necklace fee as its own line with the destination fee address, *before* the user approves. There is no flow in which a signature is produced without the fee having been displayed.
- **Pinned in the build.** The fee address (and the fee amount) are compile-time constants baked into the published extension artifact. They are **not** fetched from the API at runtime (a compromised API must not be able to redirect the fee or inflate it — see `threat-model.md` §2). Changing the fee or address requires a new, reviewable extension release.
- **Per-network fee address.** Because addresses are HRP-bound (mainnet `prl`, testnet `tprl`, regtest `rprl`), the pinned fee address differs per network. The build pins one fee address per supported network and selects by the active network. (Values: see §5 TODO.)
- **Never hidden, never silent.** No build configuration, feature flag, or "advanced mode" may suppress the fee line. Removing or obscuring the fee is a security/policy violation, not a feature.

---

## 3. How the fee appears in a transaction

For a normal send of `X` PRL to recipient `R`, the built transaction's outputs are:

| Output | Recipient | Value | Visible to user as |
|---|---|---|---|
| 1 | `R` (user's chosen destination) | `X` | "To: R — X PRL" |
| 2 | Necklace pinned fee address (this network) | `FLAT_FEE` (§5) | "Necklace fee — FLAT_FEE PRL" |
| 3 | change address (user's own, P2TR) | remainder | "Change (returns to you)" |

The **network relay fee** is then `sum(inputs) − sum(outputs 1..3)`, shown as its own line ("Network fee — N PRL"). All outputs are P2TR (witness v1, bech32m) per MVP scope.

Total debited from the user = `X + FLAT_FEE + networkRelayFee`. This total is the headline number on the confirmation screen, with the three components itemized beneath it.

> Because the Necklace fee is committed inside the signed transaction (BIP-341 sighash covers all outputs and input values), it cannot be altered after signing and cannot be multiplied by a duplicate broadcast (see `threat-model.md` §5).

---

## 4. Interaction with relay fee and coin selection

- Coin selection must fund **recipient + Necklace fee + estimated network relay fee**, then send the remainder to change (dropping change to fee if change would be dust, standard btcd behavior).
- The network relay fee estimate uses the wallet's own bounded logic and/or `GET /fees/recommended`, but the extension enforces local min/max bounds and the dust floor so a malicious API cannot push an absurd network fee (see `threat-model.md` §2). The **Necklace flat fee is independent of this** — it is the pinned constant, not derived from any fee estimate.
- If the wallet cannot afford `X + FLAT_FEE + networkRelayFee`, the build fails with a clear "insufficient funds" message that names all three components — it never silently drops the Necklace fee to make the send fit, and never silently reduces the user's intended `X`.

---

## 5. TODO placeholders (must be filled before any release)

> These are intentionally unset. **Do not ship with placeholder values.**

- **`FLAT_FEE` (the flat Necklace fee amount, in PRL / Grain):** `TODO — set exact flat amount`. Constraints: must be > dust (~546 Grain), expressed to 8-decimal Grain precision, and the same chosen value reflected consistently in UI and build constants.
- **Necklace fee address — mainnet (`prl…`):** `TODO — pin mainnet bech32m P2TR fee address`.
- **Necklace fee address — testnet (`tprl…`):** `TODO — pin testnet bech32m P2TR fee address`.
- **Necklace fee address — regtest (`rprl…`):** `TODO — pin regtest bech32m P2TR fee address`.
- **(Optional) testnet2 / simnet / signet fee addresses:** `TODO if those networks are supported`.

Each pinned address must be a valid witness-v1 (P2TR) bech32m address whose HRP matches the network it is pinned for.

---

## 6. Policy invariants (summary checklist)

- [ ] Necklace fee is a flat PRL amount, not a percentage.
- [ ] Fee is a separate, on-chain, visible transaction output.
- [ ] Fee output value is always above the dust floor.
- [ ] Fee address + amount are compile-time constants, never fetched at runtime.
- [ ] Fee line is shown on the confirmation screen before signing, every time, with no way to suppress it.
- [ ] Network relay fee is displayed separately from the Necklace fee.
- [ ] Per-network fee addresses with HRP matching the active network.
- [ ] Build fails closed if the configured fee would be dust or if funds are insufficient (never silently drops the fee or reduces the send amount).
