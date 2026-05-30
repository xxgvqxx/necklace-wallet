/**
 * Public surface of the extension's `tx/` layer: local validation, local
 * preview building (with the visible flat Necklace fee), and send orchestration.
 * No signing and no key handling happen here — the vault worker signs.
 */

export {
  validateAddress,
  isValidAddress,
  validateAmount,
} from "./validation.js";
export type {
  AddressValidation,
  AddressValidationError,
  AmountValidation,
  AmountValidationError,
} from "./validation.js";

export { decodeSegwitAddress } from "./bech32m.js";
export type { DecodedSegwit } from "./bech32m.js";

export {
  buildTxPreview,
  InsufficientFundsError,
  DEFAULT_RELAY_FEE_PER_KB,
  MIN_RELAY_FEE_PER_KB,
  MAX_RELAY_FEE_PER_KB,
} from "./preview.js";
export type { TxPreview, BuildPreviewParams } from "./preview.js";

export {
  FLAT_FEE_GRAIN,
  FEE_ADDRESS_BY_NETWORK,
  FeePolicyError,
  requireNecklaceFee,
  isFeeConfigured,
} from "./fee.js";

export { estimateVsize, relayFeeForVsize } from "./vsize.js";
export { toSpendableUtxos, isP2trScript } from "./utxo.js";

export { confirmAndSend, signDraft, rebroadcast } from "./send.js";
export type { SendResult, SendOutcome } from "./send.js";
