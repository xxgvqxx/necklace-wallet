# Pearl (PRL) Protocol Findings — Wallet Signing Architecture Proof

**Agent:** Pearl Protocol Proof Agent
**Date:** 2026-05-29
**Status:** GATE DECISION. This document determines the signing architecture for the Necklace Chrome MV3 wallet.
**Source:** `github.com/pearl-research-labs/pearl@master`, read via `raw.githubusercontent.com` and `gh api`. Every claim below cites the file it came from.

---

## 0. TL;DR — BROWSER SIGNING DECISION (front and center)

**The MVP signs entirely in TypeScript (a careful TS port with fixture parity). The post-quantum XMSS path is NOT required to send or receive PRL and MUST NOT be implemented in the browser for the MVP.**

Why this is safe and correct:

1. **Pearl is a Taproot-only chain.** Addresses are pay-to-taproot (witness v1) bech32m. Receiving and spending PRL works through the **Schnorr key-path spend** (BIP-340 / BIP-341), which is plain `secp256k1` elliptic-curve crypto. There is **no cgo on the Schnorr signing path**. (`node/btcutil/address.go`, `wallet/wallet/signer.go`, `wallet/wallet/txauthor/author.go`.)

2. **XMSS is an optional, additive script-path commitment, not the spend mechanism for ordinary sends.** Pearl commits an XMSS public key into a Taproot *script* leaf (`<xmss_pubkey> OP_CHECKXMSSSIG`) so that, *if* secp256k1 is ever broken by a quantum computer, funds can still be recovered via the script path. Normal spends use the Schnorr key-path. (`wallet/waddrmgr/xmss_keys.go`, `wallet/waddrmgr/scoped_manager.go` `deriveTapscriptRoot`, `wallet/wallet/xmss_test.go`.)

3. **The XMSS signer is cgo/FFI-bound and cannot target `js/wasm`.** `xmss/xmss.go` is `import "C"` with `#cgo LDFLAGS: ${SRCDIR}/libxmss.a -lstdc++` linking a C/C++ static library (SHAKE256-based WOTS+/XMSS). **cgo does not compile to `js/wasm`** — `GOOS=js GOARCH=wasm` requires `CGO_ENABLED=0`. So a Go→WASM build of the signing path is impossible while it depends on `libxmss.a`. (`xmss/xmss.go`, `xmss/xmss.h`, `xmss/src/xmss.cpp`, `xmss/Makefile`, root `Taskfile.yml` which sets `CGO_ENABLED: 1` and builds with `-tags xmss`.)

4. **XMSS is STATEFUL and the reference library is brutally unforgiving.** It is a hash-based one-time-signature tree with only **32 signatures total per key** (`MAX_SIGNS = 32`), and the OTS index (`msg_uid`) is passed in **by the caller on every sign** — the library does not track it. Reusing an index for two different messages **leaks the ability to forge**. There is **no OTS index counter, no persistence, and no production signing flow anywhere in the Pearl repo** — the only XMSS `Sign` call in the entire codebase is in a unit test with a hardcoded `msg_uid = 0`. (`xmss/xmss.h`, `xmss/src/xmss.cpp`, `wallet/wallet/xmss_test.go`; code-search for `NextXMSS`/`xmssIndex`/`SignatureIndex`/`xmss.Sign` finds nothing outside the test.)

Therefore:
- **`browserSigningApproach = ts-port`** — port the Schnorr/Taproot key-path signing + bech32m + WIF + tx serialization to TypeScript and pin it to the repo's own known-answer vectors. This is small, well-trodden crypto (`@noble/secp256k1` + `@noble/hashes` give BIP-340 Schnorr and SHA-256/tagged hashes out of the box).
- **Do NOT port XMSS to the browser for the MVP.** No remote code, no cgo-in-wasm hacks, and — most importantly — no stateful OTS index management in a browser where storage can be cleared, synced across devices, or rolled back. In-browser XMSS would be a catastrophic key-leak footgun (see §6, §8).
- **`generateWalletInBrowserSafe = true`** — but only for the **secp256k1 / Schnorr key material**. Generating a 32-byte secp256k1 seed/private key in-browser via `crypto.getRandomValues` and deriving the BIP-86 Taproot address is completely safe and stateless. The wallet can derive the *same* XMSS public key deterministically later (it is an HKDF expansion of the HD key), so the address's optional XMSS commitment is recoverable without ever signing XMSS in the browser.

---

## 1. Address format

**bech32m, witness-based only. No base58 addresses.** (`node/btcutil/address.go`)

- Encoding: **bech32m** (BIP-350). `encodeSegWitAddress` rejects witness versions < 1 and uses `bech32.EncodeM`. `decodeSegWitAddress` rejects version 0 and requires `bech32version == bech32.VersionM`. Legacy P2WPKH/P2WSH (v0 bech32) addresses are explicitly rejected.
- Supported witness versions:
  - **v1 = Taproot (P2TR)** — `AddressTaproot`, internal version byte `0x01`. This is the everyday address type the wallet uses.
  - **v2 = P2MR (pay-to-merkle-root, BIP-360)** — `AddressMerkleRoot`, internal version byte `0x02`. Additive; not needed for MVP send/receive.
- Witness program is always **32 bytes** (`newAddress` enforces `len(witnessProg) != 32` → error). For Taproot it is the tweaked output key.
- HRP is the network's `Bech32HRPSegwit` (see §8 table).

**Real known-answer vectors** (from `node/btcutil/address_test.go`, witness program is identical, only HRP differs):

| Network | HRP | Example address |
|---|---|---|
| mainnet | `prl` | `prl1paardr2nczq0rx5rqpfwnvpzm497zvux64y0f7wjgcs7xuuuh2nnqksluzv` |
| testnet | `tprl` | `tprl1paardr2nczq0rx5rqpfwnvpzm497zvux64y0f7wjgcs7xuuuh2nnqalmzae` |

Both encode witness v1 + the 32-byte program `ef46d1aa78101e3350600a5d36045ba97c2670daa91e9f3a48c43c6e739754e6`. The bech32m checksum differs because the HRP is part of the checksum.

---

## 2. Private key import formats accepted

- **WIF (base58, btcutil-standard)** — the canonical import format. `wallet/wallet/import.go` `ImportPrivateKey(scope, wif *btcutil.WIF, ...)`. WIF layout (`node/btcutil/wif.go` `DecodeWIF`):
  - 1 byte network ID (`PrivateKeyID`): `0x80` mainnet, `0xef` testnet/regtest/signet, `0x64` simnet.
  - 32-byte big-endian secp256k1 private key.
  - optional `0x01` compressed-pubkey magic.
  - 4-byte double-SHA256 checksum.
  - Compressed and uncompressed both decode. Bitcoin-format WIFs round-trip (the `PrivateKeyID` bytes are unchanged from Bitcoin), so a mainnet WIF still starts with `5`/`K`/`L`, testnet with `9`/`c`.
- **xpub / account extended public keys (watch-only)** — `ImportAccount`/`ImportPublicKey`, BIP-0086 only (`keyScopeFromPubKey` rejects anything that is not `TaprootPubKey`; only `HDVersion...BIP0086` versions accepted). Private extended keys are explicitly rejected (`validateExtendedPubKey`: "private keys cannot be imported").
- **No XMSS-specific key file or seed import.** XMSS material is never imported; it is always *derived* from the HD key (`waddrmgr/xmss_keys.go`, see §6). There is no code path that ingests an external XMSS secret key.
- The Necklace MVP should accept **WIF** (primary) and **raw 32-byte hex** (convenience; convert to WIF/privkey client-side). A BIP-39 mnemonic → BIP-32 → BIP-86 seed flow is also viable since Oyster is a BIP-32/BIP-44 HD wallet (`wallet/README.md`).

Real WIF KATs (`node/btcutil/wif_test.go`):
- mainnet uncompressed: privkey `0c28fca386c7a227600b2fe50b7cae11ec86d3bf1fbe471be89827e19d72aa1d` → `5HueCGU8rMjxEXxiPuD5BDku4MkFqeZyd4dZ1jvhTVqvbTLvyTJ`.
- testnet compressed: privkey `dda35a1488fb97b6eb3fe6e9ef2a25814e396fb5dc295fe994b96789b21a0398` → `cV1Y7ARUr9Yx7BR55nTdnR7ZXNJphZtCCMBTEZBJe1hXt2kB684q`.

---

## 3. Fee units, decimals, relay fee, dust

(`node/btcutil/amount.go`, `node/btcutil/const.go`, `wallet/wallet/txrules/rules.go`, `node/mempool/policy.go`)

- **Smallest unit = "Grain".** `1 PRL = 1e8 Grain` (`GrainPerPearl = 1e8`). So **8 decimal places**, exactly like Bitcoin satoshis. `Amount` is an `int64` count of Grain.
- Unit ladder: `MPRL`(1e6 PRL), `kPRL`, `PRL`, `mPRL`(1e-3), `μPRL`(1e-6), `Grain`(1e-8).
- **Max amount:** `MaxGrain = 21e9 * 1e8` Grain (21 billion PRL cap, vs Bitcoin's 21 million — note the larger supply).
- **Relay fee:** expressed as **Grain per 1000 bytes (Grain/kB)**. `DefaultRelayFeePerKb = 1e3` (1000 Grain/kB). Fee for a tx = `relayFeePerKb * txSerializeSize / 1000`, floored to `relayFeePerKb` if it would round to 0 (`txrules.FeeForSerializeSize`).
- **Dust threshold:** an output is dust if the cost to spend it exceeds 1/3 of the min relay fee (`mempool.IsDust` / `GetDustThreshold`). With the default 1000 Grain/kB relay fee this is the familiar **~546 Grain** floor for a P2PKH-equivalent; for the actual P2TR outputs the threshold is computed from the real output+input vsize.
- **Necklace flat wallet fee** (user decision): add it as an explicit, visible extra `wire.TxOut` paying a Necklace-controlled PRL address, sized above dust, shown to the user before signing. It is an ordinary output; nothing special is needed protocol-side.

---

## 4. Transaction serialization

**Standard btcd/Bitcoin `wire` serialization with SegWit witness encoding. Not modified for XMSS.** (`node/wire/msgtx.go`, `wallet/wallet/txauthor/author.go`, `wallet/wallet/txsizes/size.go`)

- `wire.TxVersion = 1` is the default; the wallet builds txs with `Version: wire.TxVersion`. (`xmss_test.go` builds v2 txs manually, but `NewUnsignedTransaction` uses `wire.TxVersion`.)
- Witness marker/flag: `TxFlagMarker = 0x00` then a flag byte — identical to BTC SegWit serialization (`0x00 0x01` marker+flag).
- Inputs: 32-byte prev txid + 4-byte index + script-len + scriptSig + 4-byte sequence. For Taproot key-path the scriptSig is empty and the **witness is a single 64/65-byte Schnorr signature** (`txauthor.spendTaprootKey`: `txIn.Witness = wire.TxWitness{sig}`).
- Outputs: 8-byte value (Grain) + varint script-len + pkScript. P2TR pkScript = `OP_1 OP_DATA_32 <32-byte key>` (34 bytes) (`txsizes.P2TRPkScriptSize = 34`).
- Sighash: **BIP-341 taproot sighash** (`txscript.NewTxSigHashes`, `RawTxInTaprootSignature`, `SigHashDefault`). The input value is committed in the sighash (BIP-341), so the wallet/extension must know each input's value.
- **XMSS does not change serialization.** When an XMSS *script-path* spend is used, the signature is simply carried in the witness stack as 5 chunks of 468 bytes + the leaf script + the control block (`xmss_test.go`, `opcodeCheckXmssSig`) — this is ordinary tapscript witness encoding, not a wire-format change. The MVP does not produce these.

**Implication for the TS port:** it must reproduce btcd `wire` tx serialization (varints, little-endian, witness marker/flag) and BIP-341 sighash exactly. Both are standard and have reference test vectors; `@scure/btc-signer` / `@noble/curves` cover them.

---

## 5. SIGNING — how `signer.go` signs (the most important question)

(`wallet/wallet/signer.go`, `wallet/wallet/txauthor/author.go`, `wallet/wallet/xmss_test.go`, `node/txscript/opcode.go`)

### 5a. Production wallet signing = Schnorr (key-path), NOT XMSS

`signer.go` `ComputeInputScript` and `txauthor.spendTaprootKey` both:
1. require the prevout to be P2TR (`txscript.IsPayToTaproot`),
2. fetch the secp256k1 private key for the address,
3. tweak it with the tapscript root if the address carries one (`walletAddr.TapscriptRoot()` / `secrets.GetTapscriptRoot`),
4. produce a **BIP-340 Schnorr signature** via `txscript.RawTxInTaprootSignature(..., tapscriptRoot, SigHashDefault, privKey)`,
5. set `Witness = wire.TxWitness{sig}`.

This is **ECDSA-family elliptic-curve crypto (secp256k1 Schnorr)** — exactly Bitcoin Taproot key-path. **No cgo, no XMSS, no state.** `TestKeyPathSpendingStillWorks` in `xmss_test.go` confirms key-path Schnorr spends still work on addresses that carry an XMSS commitment (the key is tweaked by the tapscript root).

### 5b. XMSS is a separate, additive Taproot SCRIPT-PATH

Addresses generated by the wallet (`scoped_manager.go` `deriveTapscriptRoot`/`maybeDeriveTapscriptRoot`) commit a script leaf `<xmss_pubkey> OP_CHECKXMSSSIG` into the Taproot output key. The XMSS pubkey is derived deterministically from the HD tree (§6). Spending via that leaf (`xmss_test.go` `TestXMSSScriptPathSigning`):
- compute the tapscript sighash,
- `sig := xmss.Sign(0, sk, msg)` — **`0` is the OTS index `msg_uid`, hardcoded in the test**,
- witness = `{sig[0:468], sig[468:936], sig[936:1404], sig[1404:1872], sig[1872:2340], xmssScript, controlBlock}`.

The full node verifies this with `opcodeCheckXmssSig` (`node/txscript/opcode.go`, opcode `0xde = 222`), which pops the 5 chunks + pubkey, re-concatenates the 2340-byte signature, recomputes the tapscript sighash, and calls `xmss.Verify`. Verification is **stateless** on the node side (it does not check index reuse — that protection lives only in the signer not reusing indices).

### 5c. Is XMSS STATEFUL? YES — dangerously so.

From `xmss/xmss.h` and `xmss/src/xmss.cpp`:
- Config is **XMSS-SHAKE256_5_256**: `full_height = 5` → **`MAX_SIGNS = 32`** total signatures per keypair. After 32 signatures the key is exhausted.
- `xmss_sign(unsigned int msg_uid, sk, msg, out_sig)` requires `0 <= msg_uid < 32` and the caller supplies `msg_uid`. The stored `SK` (`SK_LEN = 128`) **does not contain the index** — `xmss.cpp` reconstructs `full_sk` by prepending `ull_to_bytes(msg_uid)` on every call. **The library keeps zero state; the caller owns the index entirely.**
- Header comment, verbatim: *"May sign only once with each msg_uid… Publishing two signatures with the same msg_uid enables attackers to sign unintended messages in the name of the private_seed owner."* This is the classic WOTS one-time-signature catastrophe: signing two different messages under the same OTS index leaks enough of the Winternitz chains to **forge arbitrary signatures**, i.e. **steal the funds protected by that key**.

### 5d. Where is OTS index state stored? NOWHERE (in this repo).

Exhaustive code search (`NextXMSS`, `xmssIndex`, `XMSSIndex`, `SignatureIndex`, `sigIndex`, `nextSigIndex`, `usedIndex`, and direct `xmss.Sign` usage) finds **no production index counter, no DB bucket, no persistence**. `xmss.Sign` is called in exactly one place: the unit test, with `msg_uid = 0`. `xmss.Keygen` is called only in `waddrmgr/xmss_keys.go` (deterministic keygen for the address commitment). **Pearl `pearl-wallet-v1.0.0` has no shipped, stateful XMSS signing flow.** The PQ path is, today, an on-chain *capability* (the opcode + the address commitment) without a production OTS-managing signer. This is the single strongest argument against attempting XMSS signing in a browser extension: even the reference daemon does not yet manage the state.

---

## 6. Browser signing verdict (detailed)

**Chosen: `ts-port` for the MVP (Schnorr/Taproot key-path only). XMSS deferred.**

Evidence about the cgo/FFI boundary:
- `xmss/xmss.go` begins `//go:build xmss` and contains `import "C"`, `#cgo CFLAGS: -I${SRCDIR}`, `#cgo LDFLAGS: ${SRCDIR}/libxmss.a -lstdc++`. The Go layer is a thin FFI shim over a C/C++ static library (`xmss/src/xmss.cpp` + the `external/*.c` SHAKE256/WOTS/XMSS reference implementation).
- The root `Taskfile.yml` builds everything with `CGO_ENABLED: 1` and `-tags xmss,zkpow`, and depends on `build:libxmss` (`make` producing `libxmss.a`). The non-cgo `xmss_stub.go` (`//go:build !xmss`) returns `errNoCgo` for every operation — i.e. **without cgo, XMSS does nothing**.
- **`GOOS=js GOARCH=wasm` mandates `CGO_ENABLED=0`.** The Go toolchain cannot link a C static library into a `js/wasm` binary. So:
  - **Go→WASM:** impossible for the XMSS path (cgo). *Possible in principle for the Schnorr path only* (it's pure-Go btcec/txscript), but pulling the whole btcd-derived tree into WASM is heavy and brings no fixture advantage over a TS port.
  - **TinyGo:** TinyGo's `wasm` target also does not support cgo/`libxmss.a`; same blocker for XMSS.
  - **Rust→WASM port:** feasible *if* PQ were in scope (the underlying C is portable, and the `zk-pow` side of Pearl is already Rust), but it is a from-scratch reimplementation of a stateful PQ scheme — high risk, and pointless for MVP because XMSS is not needed to send/receive.
  - **TS port:** the MVP only needs secp256k1 Schnorr (BIP-340), BIP-341 sighash, bech32m, WIF (base58check), and btcd `wire` serialization — all standard, all covered by audited JS libs (`@noble/curves` secp256k1 schnorr, `@noble/hashes` sha256/tagged-hash, `@scure/base` bech32m/base58check, `@scure/btc-signer` taproot). Pin every primitive to the repo's own KATs (the address/WIF vectors above, plus locally generated tx vectors) before trusting it.
- **No remote code:** a TS port is bundled into the extension and ships under a strict CSP; nothing is fetched/eval'd at runtime. A WASM blob is also static, but TS is simpler to audit and review against the constraint "no hand-rolled crypto without official fixture parity" (we use audited libs + KATs, not hand-rolled).

**Verdict justification in one line:** the only crypto on the critical send/receive path is secp256k1 Schnorr over Taproot (no cgo, standard, fixture-checkable in TS); the only thing that *needs* cgo (XMSS) is both off the critical path and too dangerous to run statefully in a browser, so we port the safe part to TS and defer the dangerous part.

---

## 7. `generateWalletInBrowserSafe`

**TRUE — with a hard scope limit.**

- Safe: generate 32 bytes of entropy with `crypto.getRandomValues`, treat as the BIP-32 seed / secp256k1 master key, derive the BIP-86 key scope `m/86'/<coin>'/0'/0/0` (Purpose 86, Coin per network — see §6/§8), compute the Taproot output key and bech32m address. This is stateless EC crypto. Encrypt the key in `chrome.storage.local`; never transmit it.
- Also safe: the address's optional XMSS commitment is **deterministic** — `waddrmgr.DeriveXMSSSeeds` derives a *separate* key at `m/222'/<coin>'/account'/branch/index` (KeyScopePQ, Purpose 222 = `0xDE` to match the opcode), serializes that EC private key, and runs `HKDF-SHA256(ikm, info="XMSS-SEED-EXPANSION")` → 64-byte priv seed + 32-byte pub seed → `xmss.Keygen`. Because it is pure derivation from the HD seed, the same XMSS public key (and thus the same address commitment) can be recomputed **later, off-browser, or by the daemon** without the browser ever holding XMSS signing state. **Generating the wallet does not require signing XMSS, so generation is safe even though XMSS signing is not.**
- NOT safe and therefore NOT done in-browser: **XMSS signing / OTS index management.** A browser's `chrome.storage` can be cleared, profile-synced across machines, or restored from backup — any of which can roll the OTS index back and cause catastrophic reuse (§5c). The MVP never signs XMSS; if PQ recovery is ever needed it must be done by a controlled, single-writer, state-tracking signer outside the extension. For the MVP we generate the **Schnorr** wallet in-browser and (optionally, deterministically) compute the XMSS *public* commitment for the address, but we **never** sign with it.

---

## 8. Networks / dev mode + exact params

(`node/chaincfg/params.go`)

| Network | `Name` | HRP (`Bech32HRPSegwit`) | `PrivateKeyID` (WIF) | `DefaultPort` | `HDCoinType` | RelayNonStdTxs | Notes |
|---|---|---|---|---|---|---|---|
| mainnet | `mainnet` | `prl` | `0x80` | 44108 | 808276 (`HDCoinTypePearl`, 0xC5554) | false | |
| **testnet** | `testnet` | `tprl` | `0xef` | 44110 | 1 (`HDCoinTypeTestnet`) | true | seeded testnet |
| testnet2 | `testnet2` | `tprl` | `0xef` | 44112 | 1 | true | fresh genesis |
| **regtest** | `regtest` | `rprl` | `0xef` | 18444 | 1 | true | `PoWNoRetargeting`, `ReduceMinDifficulty`, `GenerateSupported` |
| simnet | `simnet` | `rprl` | `0x64` | 18555 | 1 | true | private; no DNS seeds; `PoWNoRetargeting` |
| signet | `signet` | `tprl` | `0xef` | 38333 | 1 | false | not currently operated by Pearl |

- **Dev-network decision (Phase 1) = testnet/regtest.** _(Superseded: the shipped extension is mainnet-only; this section is retained for the network params, which remain accurate.)_ Concretely:
  - Use `chaincfg.RegressionNetParams` (`Name "regtest"`, HRP `rprl`, WIF byte `0xef`, port 18444) for a local single-node dev chain — it has `PoWNoRetargeting=true`, `ReduceMinDifficulty=true`, `GenerateSupported=true` so blocks can be mined on demand, and `RelayNonStdTxs=true`. This is the analogue of `pearld --regtest` (btcd-style `--regtest` flag; equivalently `pearld -u rpcuser -P rpcpass` against the regtest params on the backend node).
  - Use `chaincfg.TestNetParams` (`Name "testnet"`, HRP `tprl`, port 44110) for the shared/public dev testnet.
- HD coin type: mainnet uses **808276** (ASCII "PRL"); **all test networks use SLIP-44 coin type 1**. The extension must select coin type by network when building the BIP-86 path.
- HD version bytes (BIP-84/SegWit style, repurposed for Taproot): mainnet `zprv/zpub` (`04b2430c`/`04b24746`); testnet/regtest `vprv/vpub` (`045f18bc`/`045f1cf6`); simnet `sprv/spub`; signet `tprv/tpub`. The extension should expect `v...`-prefixed xpubs on testnet/regtest.

---

## 9. Cross-cutting consequences for Necklace

1. **Sign in TS, broadcast raw.** Build + Schnorr-sign the tx locally; POST only the signed raw tx hex to the broadcast API. Matches the non-custodial constraint.
2. **Address type:** generate/spend **P2TR (witness v1, bech32m)** only for MVP. P2MR (v2) and XMSS script-path are out of scope.
3. **Fees:** relay fee is Grain/kB (default 1000); the Necklace flat fee is an explicit visible extra P2TR output above the ~546-Grain dust floor.
4. **Input values are mandatory** for BIP-341 sighash — the extension must fetch prevout values (from the indexer) for every input it signs.
5. **WIF import** uses standard base58check with Pearl's `PrivateKeyID` bytes; reuse `@scure/base` base58check + the byte tables in §8.
6. **Defer XMSS with a written rationale** (this doc) — do not generate or sign XMSS state in-browser. Wallet generation is still allowed because it only needs secp256k1 + deterministic public derivation.

---

## Appendix — files read (with what each proved)

- `go.mod` — btcd-derived deps (`decred secp256k1`, `tyler-smith/go-bip39`), Go 1.26; confirms EC + BIP-39 base.
- `Taskfile.yml` — `CGO_ENABLED:1`, `-tags xmss,zkpow`, `build:libxmss` via `make`; proves cgo on the XMSS build.
- `wallet/README.md` — Oyster is a BIP-32/BIP-44 HD wallet; encrypted keys only.
- `wallet/wallet/import.go` — WIF private-key import; BIP-86-only xpub/pubkey import; rejects private xkeys.
- `wallet/wallet/createtx.go` — coin selection, change as P2TR, `RawTxInTaprootSignature` validation, `wire`/`txscript` usage.
- `wallet/wallet/signer.go` — `ComputeInputScript` = Schnorr Taproot key-path only; tapscript-root tweak.
- `wallet/wallet/utxos.go` — UTXO model, `wire.TxOut{Value, PkScript}`, BIP-32 derivation info.
- `wallet/wallet/psbt.go` — PSBT funding/finalize; SegWit v1 only; SighashDefault.
- `wallet/wallet/xmss_test.go` — the ONLY XMSS Sign call (`msg_uid=0`); 2340-byte sig in 5×468 chunks; key-path Schnorr still works.
- `wallet/wallet/txauthor/author.go` — `NewUnsignedTransaction`, `wire.TxVersion`, P2TR/P2MR only, `spendTaprootKey` Schnorr witness.
- `wallet/wallet/txrules/rules.go` — `DefaultRelayFeePerKb=1e3`, dust, `MaxGrain`, `FeeForSerializeSize`.
- `wallet/wallet/txsizes/size.go` — P2TR sizes (34-byte pkScript), Schnorr witness weight, vsize estimation.
- `node/btcutil/wif.go` — WIF base58check format, network byte switch.
- `node/btcutil/address.go` — bech32m, witness v1 (P2TR)/v2 (P2MR), 32-byte program, legacy rejected.
- `node/btcutil/amount.go`, `const.go` — Grain = 1e-8 PRL, 8 decimals, units, `MaxGrain = 21e9 PRL`.
- `node/btcutil/address_test.go`, `wif_test.go` — real KAT vectors used in fixtures.
- `node/chaincfg/params.go` — all network params (HRP, WIF byte, port, coin type, HD version).
- `node/wire/msgtx.go` — `TxVersion=1`, SegWit marker/flag, standard wire serialization.
- `node/txscript/opcode.go` — `OP_CHECKXMSSSIG = 0xde`, stateless verify, tapscript-only.
- `node/mempool/policy.go` — `IsDust`/`GetDustThreshold` (~546 Grain at default relay fee).
- `xmss/xmss.go`, `xmss_stub.go`, `xmss.h`, `src/xmss.cpp`, `external/params.h`, `Makefile` — cgo FFI; XMSS-SHAKE256_5_256; `MAX_SIGNS=32`; caller-supplied `msg_uid`; reuse-leak warning; stateless library.
- `wallet/waddrmgr/xmss_keys.go` — deterministic XMSS seed derivation via HKDF from `m/222'`; `xmss.Keygen` only.
- `wallet/waddrmgr/scoped_manager.go` — `KeyScopeBIP0086` (Purpose 86) and `KeyScopePQ` (Purpose 222); tapscript-root commitment of XMSS pubkey.
