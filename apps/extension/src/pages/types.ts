/**
 * Screen routing for the popup. A small discriminated union drives which page
 * renders; PopupApp owns the current route and passes a `navigate` callback
 * down. No router library is needed for a fixed-size popup with a handful of
 * screens.
 */

import type { SignedTx } from "@necklace/shared";
import type { TxPreview } from "../tx/index.js";

export type Route =
  | { name: "home" }
  | { name: "receive" }
  /** Compose a payment; optionally prefill the recipient (e.g. from Contacts). */
  | { name: "send"; prefillAddress?: string }
  /** Saved address book (contacts). */
  | { name: "contacts" }
  /** Confirmation carries the locally-built preview to display before signing. */
  | { name: "confirm"; preview: TxPreview }
  /** Success screen after a broadcast. */
  | { name: "sent"; txid: string; alreadyKnown: boolean }
  | { name: "activity" }
  /** Drill-down detail for one transaction (opened from Activity). */
  | { name: "txdetail"; txid: string }
  /** Read-only explorer: look up any address's PRL balance. */
  | { name: "lookup" }
  /** Account switcher / manager (list, add, switch, rename, remove). */
  | { name: "accounts" }
  | { name: "settings" };

export type Navigate = (route: Route) => void;

/** Re-exported for screens that show a signed-tx result. */
export type { SignedTx };
