# Necklace Wallet — Threat Model

**Status:** Phase 0 product/security doc. Grounded in `docs/protocol-findings.md` (Phase 1, authoritative).
**Date:** 2026-05-29
**Scope:** Necklace is a non-custodial Chrome MV3 wallet for Pearl (PRL). The extension owns key import/generation, encrypts the key locally in `chrome.storage.local`, derives the address locally, builds and Schnorr-signs transactions locally, and POSTs **only** the signed raw transaction hex to a Railway broadcast API. No private keys, seeds, or passwords ever leave the device.

---

## 0. Security model summary

**Trust boundaries:**

| Component | Trust level | Holds secrets? |
|---|---|---|
| Extension (background/service worker + UI) | Trusted (the TCB) | Yes — encrypted key in `chrome.storage.local` |
| Railway API (`pearld` + read/broadcast + Postgres/NeonDB indexer) | **Untrusted for confidentiality and integrity** | No |
| Vercel site/docs | Untrusted; public, read-only content | No |
| Visited websites / dApps | **Hostile by default** | No |

**Core invariants (non-negotiable, from project constraints):**

- No server-side signing. The private key never leaves the extension.
- No private keys, seeds, or passwords are ever sent to Railway or Vercel.
- No remote executable JS/WASM in the extension; strict CSP; signing code is bundled and audited (TS port pinned to repo KATs).
- Minimal permissions: `storage` + exactly one API host. No `tabs`, no broad host permissions, no `<all_urls>`.
- The flat Necklace fee is an explicit, visible extra output shown before signing — never hidden.
- Never log secrets. No private keys, seeds, passwords, or decrypted material in any log, error message, or telemetry.
- No XMSS signing in-browser (see §6 — the dominant residual-risk driver).

**Assets being protected (in priority order):**

1. The secp256k1 private key / BIP-32 seed (theft = total loss of funds).
2. The user's intent integrity — that the tx they approve is the tx that gets signed (amount, destination, fee).
3. Availability of broadcast and balance/UTXO reads (degraded, not catastrophic).

The threats below are the six required scenarios. Each gives the **assumption**, the **mitigation**, and the **residual risk** that remains after mitigation.

---

## 1. Malicious website

A visited web page (or a malicious dApp) attempts to extract keys, trick the user into signing a transaction they did not intend, or drain funds through a connection request.

**Assumption.** Any page the user visits may be hostile. Page JS will try to reach the extension, read its storage, inject into its UI, or socially engineer an approval. The user may not read approval dialogs carefully.

**Mitigation.**
- **No content script with key access.** The extension does not expose the signing key or a "sign arbitrary bytes" API to page context. MV3 isolation keeps `chrome.storage.local` unreadable by page JS.
- **Minimal surface to the page.** If a dApp connect/provider API is offered at all, it is request/response with explicit user approval per action; it never returns key material and never signs without an in-extension confirmation screen.
- **Human-readable approval screen, rendered by the extension, not the page.** Every signature requires a confirmation UI rendered in extension-controlled chrome (popup/side panel), showing: destination address, amount in PRL, the explicit Necklace fee output (§ fee-policy.md), the network relay fee, and the resulting total. The page cannot style, overlay, or pre-confirm this dialog.
- **Address and amount are shown decoded** (bech32m address with HRP matching the active network; PRL with 8-decimal Grain precision) so a swapped destination is visible.
- **Strict CSP** (`script-src 'self'`; no `unsafe-inline`, no `unsafe-eval`, no remote origins) prevents a page from injecting executable code into the extension.
- **Origin binding.** Approval prompts display the requesting origin so the user can spot an unexpected requester.

**Residual risk.**
- **Social engineering / approval blindness.** A user can still be tricked into approving a transaction to an attacker's address if they do not read the confirmation. We mitigate clarity but cannot eliminate user error. Address-poisoning (look-alike prefixes/suffixes) remains possible.
- **UI redress around the browser chrome.** The extension cannot fully prevent a page from overlaying the surrounding browser viewport (it can only guarantee its own rendered surface). Clear, consistent confirmation UI is the only defense.
- **Phishing of the seed phrase outside the extension** (a fake "Necklace" web page asking for the seed) is out of the extension's control — addressed only by user education in docs.

---

## 2. Compromised API (Railway)

The Railway backend (`pearld` + broadcast/read API + indexer) is taken over, or a man-in-the-middle sits between the extension and the API.

**Assumption.** Railway is **untrusted**. A compromised API can: lie about balances/UTXOs, return false prevout values, withhold or delay broadcast, return forged tip/fee data, or attempt to inject a malicious payload in responses. It **cannot** obtain the private key (it is never sent) and **cannot** alter a signed transaction without invalidating it.

**Mitigation.**
- **Signing is local; the API only broadcasts.** A compromised API can never sign on the user's behalf or learn the key. The worst it can do with `POST /tx/broadcast` is drop or delay a fully-formed, already-signed tx.
- **The signed transaction is self-protecting.** BIP-341 commits to the destination, amounts, and (critically) the input prevout values inside the sighash. If the API returns a **false prevout value**, the resulting signature is computed over a wrong value and the tx is simply invalid / rejected by honest nodes — funds are not stolen, the send just fails. The fee the user actually pays is fixed by the outputs they approved, not by the API.
- **Client-side validation of API responses.** The extension validates response shapes (see `api-contract.md`), rejects malformed payloads, and treats all response bytes as data (never `eval`'d — enforced by CSP).
- **HTTPS-only, single pinned API host.** The one declared host permission is HTTPS. No plaintext, no fallback host.
- **Independent fee floor.** The extension does not blindly trust `GET /fees/recommended`; it enforces its own sane min/max bounds and the dust floor locally so a malicious API cannot push an absurd fee.
- **No secrets in requests.** Broadcast carries only `rawTxHex`. Balance/UTXO/tx reads carry only public addresses. A compromised API or MITM sees nothing secret.

**Residual risk.**
- **Denial of service / censorship.** A compromised API can refuse to broadcast or hide UTXOs, making the wallet unable to transact or showing a stale/false balance. This is an availability and correctness-of-display problem, not a key-theft problem. Mitigation is operational (monitoring, ability to point at an alternate node) — out of MVP scope but noted.
- **Misleading balance/history display.** A user could be shown a wrong balance or a fake incoming tx. They cannot lose funds from this alone, but they could be misled into believing a payment arrived. Confirmations and (eventually) cross-checking against `/tip` height reduce but do not remove this.
- **Privacy leakage.** The API necessarily learns which addresses the wallet queries and broadcasts from, linking them by IP/timing. This is inherent to using a remote indexer.

---

## 3. Stolen browser profile

An attacker obtains a copy of the Chrome profile (disk image, backup, synced profile, or live access to an unlocked machine), including `chrome.storage.local`.

**Assumption.** The attacker has the encrypted key blob from `chrome.storage.local` and can run it through the extension or offline. The encryption password is the only thing standing between them and the key.

**Mitigation.**
- **The key at rest is encrypted with a user-chosen password.** Storage holds ciphertext only; the plaintext key exists only transiently in memory while unlocked.
- **Strong KDF.** Password-based key derivation uses a memory-hard / high-cost KDF (e.g. scrypt/PBKDF2 at conservative parameters — exact choice TODO in implementation) with a per-wallet random salt, and authenticated encryption (AEAD) so tampering is detected.
- **Lock on idle / on browser close.** The decrypted key is held only while the wallet is unlocked; an auto-lock timeout clears it from memory.
- **Never log secrets.** Decrypted material is never written to logs, the DOM beyond the necessary in-memory use, or any persisted field.
- **No password sent anywhere.** The password is used only locally for decryption (reinforces §2: even a compromised API gains nothing).

**Residual risk.**
- **Weak password = brute force.** If the user picks a weak password, an offline attacker with the blob can grind the KDF. The KDF cost raises the bar but cannot save a trivially weak password. User education (strong password) is the only complete mitigation.
- **Live extraction of plaintext key.** If the attacker has access while the wallet is **unlocked**, or can install a keylogger / read process memory on the live machine, the password and/or the in-memory key can be captured. The extension cannot defend a fully compromised host OS.
- **Backup/sync exposure.** If the encrypted blob is in a cloud profile sync or backup, it expands the attacker's offline-attack opportunity window. The encryption is the only defense; password strength governs the outcome.

---

## 4. Malicious extension update

A future version of the extension (via a compromised publisher account, a malicious maintainer, or a supply-chain attack in a dependency) ships code that exfiltrates keys or silently alters transactions.

**Assumption.** A user auto-updates extensions. A malicious update would run with the same `storage` permission and the same single API host, and could attempt to read the encrypted blob and either exfiltrate it or wait for the user to unlock and capture the plaintext.

**Mitigation.**
- **Strict CSP + no remote code** means a malicious update must ship its payload *in the published package*, where it is reviewable. There is no runtime-fetched code path to hide behind. This makes auditing the published artifact meaningful.
- **Reproducible / verifiable builds (goal).** The build is deterministic from pinned sources so the published artifact can be checked against the source. Crypto primitives are audited libraries pinned to versions and to the repo's KATs; dependency versions are locked.
- **Minimal permissions** cap the blast radius: with only `storage` + one API host, a malicious update cannot reach arbitrary origins to exfiltrate to (it can only talk to the one declared host — and adding a new host permission triggers a re-prompt the user can notice).
- **No silent permission escalation.** Any manifest permission change forces a user re-consent on update, which is a visible signal.
- **Open source + published hashes** let the community detect a divergent published build.

**Residual risk.**
- **Trust in the publisher remains.** A user who auto-updates and does not verify the artifact is ultimately trusting whoever controls the publishing key. A determined malicious update could exfiltrate the encrypted blob to the single allowed host (which it also controls) or capture the password on unlock. Permission minimization narrows but does not close this.
- **Dependency supply chain.** A poisoned transitive dependency could slip in despite version pinning if the lockfile is updated without review. Pinning + audit + the no-remote-code CSP reduce, but do not eliminate, this.
- **Store review is not a security guarantee.** Passing Chrome Web Store review does not prove the code is benign.

---

## 5. Duplicate broadcast

The same signed transaction (or a conflicting double-spend) is broadcast more than once — by retries, by the user clicking "send" twice, by a malicious page replaying a captured raw tx, or by a flaky API.

**Assumption.** Network and UI errors cause retries; a captured `rawTxHex` could be re-submitted; the user might resubmit out of impatience.

**Mitigation.**
- **A signed tx is idempotent by txid.** Re-broadcasting the *same* fully-signed transaction does not double-spend: it has the same txid, spends the same inputs, and an honest node/mempool deduplicates it. The API contract (`api-contract.md`) defines `already-known` as a **non-error / success-equivalent** outcome so the UI can treat a duplicate as "already accepted" rather than a new send.
- **No fee surprise on retry.** Because the fee (network relay fee + the explicit Necklace fee output) is fixed inside the signed tx, retrying cannot multiply the fee — the same tx is the same tx.
- **Client-side send guard.** The UI disables the send action after the first submit for a given built tx and surfaces the returned `txid`, so a user does not build a *second, different* tx unintentionally.
- **Replay across networks is impossible by construction.** Addresses are HRP-bound and the BIP-341 sighash commits to network-specific details; a regtest/testnet tx is meaningless on mainnet and vice versa.

**Residual risk.**
- **Distinct double-spend by the user.** If the user deliberately builds a *new* tx spending the same UTXOs (e.g. a fee bump or a fresh send before the first confirms), they can create a real double-spend; only one will confirm. This is intended behavior, but a confused user could be surprised which one wins.
- **Replay of a captured raw tx by a third party** simply rebroadcasts the user's own already-signed tx — it confers no benefit to the attacker (same destination, same outputs) and is deduplicated. It is harmless but worth noting it cannot be prevented at the network layer.
- **Mempool/RBF semantics** depend on `pearld`'s relay policy; if replace-by-fee is enabled, fee-bump flows would need explicit handling (out of MVP scope).

---

## 6. XMSS OTS-state corruption / reuse

Pearl's optional post-quantum recovery path uses XMSS, a **stateful** hash-based one-time-signature scheme. Reusing a one-time-signature (OTS) index for two different messages leaks enough WOTS+ chain material to **forge arbitrary signatures and steal the funds** protected by that key.

**Assumption (the catastrophe).** Per Phase 1 findings: the scheme is XMSS-SHAKE256_5_256, `MAX_SIGNS = 32` signatures per keypair, and the OTS index (`msg_uid`, range 0..31) is supplied **by the caller on every sign** — the C library keeps **zero state**. A browser's `chrome.storage` can be cleared, **synced across devices**, restored from backup, or rolled back — any of which can reset or duplicate the OTS index and cause a reuse. Pearl ships **no** production OTS index counter or persistence anywhere (the only `xmss.Sign` in the repo is a unit test hardcoding `msg_uid = 0`); even the reference daemon does not manage this state.

**Mitigation.**
- **Necklace NEVER signs XMSS in the browser. This is the single most important security decision in the wallet.** The MVP signs only the secp256k1 BIP-340 Schnorr Taproot **key-path**, which is stateless EC crypto. The XMSS script-path is out of scope.
- **No XMSS state is stored in the extension.** There is no OTS index counter, no `msg_uid` persistence, nothing that could be corrupted, synced, or rolled back. The footgun is removed by never loading the gun.
- **XMSS signing is technically blocked too:** the reference signer is cgo/FFI-bound (`libxmss.a`, `-lstdc++`) and cannot target `GOOS=js GOARCH=wasm` (which requires `CGO_ENABLED=0`). So even an accidental attempt to ship the reference signer to the browser would fail to build — but we do not rely on that alone; we exclude XMSS by design and document the rationale.
- **Wallet generation stays safe.** Generating the secp256k1 wallet in-browser is safe and stateless. The address's optional XMSS *public* commitment is **deterministic** (HKDF expansion of the `m/222'` HD key → `xmss.Keygen`), so it can be recomputed later off-browser **without ever signing**. Generation does not require XMSS state.
- **If PQ recovery is ever needed**, it must be performed by a controlled, single-writer, state-tracking signer **outside** the extension — never by browser storage.

**Residual risk.**
- **The PQ recovery capability is deferred, not delivered.** If secp256k1 were broken by a quantum adversary, MVP users could not perform an in-extension XMSS script-path recovery. This is an accepted trade-off: the alternative (in-browser stateful XMSS) is strictly more dangerous *today* than the quantum risk it would hedge.
- **Future ecosystem state-management risk.** When Pearl eventually ships a production OTS-managing signer, any wallet integrating it (not this MVP) inherits the full reuse-catastrophe surface and must guarantee single-writer, append-only, non-rollback-able index state. This doc records that constraint so it is not forgotten.
- **User-imported keys that already have an XMSS commitment** remain spendable via the Schnorr key-path (which works on commitment-carrying addresses by tweaking the key with the tapscript root); no XMSS signing is needed for normal spends, so there is no residual reuse risk from importing such a key in the MVP.

---

## 7. Cross-cutting residual risks

- **Host compromise** (malware, keylogger, hostile OS) defeats any in-browser wallet once the wallet is unlocked. Out of scope to fully defend; noted as the ceiling on all guarantees.
- **User error** (weak password, approving the wrong address, falling for off-extension phishing) is the largest practical residual across §1, §3, and §4. Clear UI and documentation are the mitigations; they cannot be made zero.
- **Indexer trust for *display*** (§2) means "what the user sees" can be wrong even when "what the user can lose" is protected. Funds safety does not depend on the API; informational accuracy partly does.
