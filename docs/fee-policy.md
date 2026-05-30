# Necklace Wallet — Fee Policy

**Status:** Implemented. Policy doc grounded in `docs/protocol-findings.md`; the concrete fee amount and addresses are pinned in `apps/extension/src/tx/fee.ts` (see §5).
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

- **Flat, not percentage.** The fee is a fixed PRL amount per send, independent of the amount being transferred. (Exact amount: **1 PRL** — see §5.)
- **A real, separate output.** The fee is a `wire.TxOut` in the transaction paying the pinned Necklace fee address. It is visible on-chain and in any block explorer. It is *not* skimmed from change, *not* hidden in the relay fee, and *not* a separate off-chain charge.
- **Above the dust floor.** The fee output must exceed the Pearl dust threshold (~546 Grain at the default relay fee for a P2TR output; computed from the real output/input vsize). The flat fee amount chosen in §5 must always clear dust. If a configured fee were ever below dust, the build must fail closed rather than emit a dust output.
- **Always shown before signing.** The confirmation screen (rendered by the extension, per `threat-model.md` §1) itemizes the Necklace fee as its own line with the destination fee address, *before* the user approves. There is no flow in which a signature is produced without the fee having been displayed.
- **Pinned in the build.** The fee address (and the fee amount) are compile-time constants baked into the published extension artifact. They are **not** fetched from the API at runtime (a compromised API must not be able to redirect the fee or inflate it — see `threat-model.md` §2). Changing the fee or address requires a new, reviewable extension release.
- **Per-network fee address.** Because addresses are HRP-bound (mainnet `prl`, testnet `tprl`, regtest `rprl`), the pinned fee address differs per network. The build pins one fee address per supported network and selects by the active network. (Values: see §5.)
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

## 5. Pinned fee values (compile-time constants)

These are pinned in `apps/extension/src/tx/fee.ts` and baked into the published build. Changing any of them requires a new, reviewable release (§2).

- **`FLAT_FEE` (the flat Necklace fee):** **1 PRL** = `100,000,000` Grain (`FLAT_FEE_GRAIN = GRAIN_PER_PRL`). Well above the ~546 Grain dust floor.
- **Necklace fee address — mainnet (`prl…`):** `prl1pl0c9aqvmvhm4ml8nrc7s0cezrgx3el67nwxeywpjcwl6a696hp6s5p8jhf` — pinned, verified witness-v1 P2TR.
- **Necklace fee address — testnet (`tprl…`):** not pinned (`null`) — sending on testnet **fails closed** until an address is pinned.
- **Necklace fee address — regtest (`rprl…`):** `rprl1pw53jtgez0wf69n06fchp0ctk48620zdscnrj8heh86wykp9mv20qdcu0t8` — a valid, deterministically-derived **dev/test fixture only** (not a treasury address), kept so the regtest send path and the fee-output unit tests have a valid address. Dead at runtime in the mainnet-only build.
- **testnet2 / simnet / signet:** not pinned (`null`).

Necklace currently ships **mainnet-only** (`ACTIVE_NETWORK = mainnet`), so only the mainnet address is used at runtime; the others exist for the multi-network wallet-core tests. Every pinned address is a valid witness-v1 (P2TR) bech32m address whose HRP matches its network, and any network with no pinned address fails closed (`requireNecklaceFee` throws) rather than emitting a placeholder.

---

## 6. Policy invariants (summary checklist)

- [x] Necklace fee is a flat PRL amount, not a percentage.
- [x] Fee is a separate, on-chain, visible transaction output.
- [x] Fee output value is always above the dust floor.
- [x] Fee address + amount are compile-time constants, never fetched at runtime.
- [x] Fee line is shown on the confirmation screen before signing, every time, with no way to suppress it.
- [x] Network relay fee is displayed separately from the Necklace fee.
- [x] Per-network fee addresses with HRP matching the active network.
- [x] Build fails closed if the configured fee would be dust or if funds are insufficient (never silently drops the fee or reduces the send amount).
