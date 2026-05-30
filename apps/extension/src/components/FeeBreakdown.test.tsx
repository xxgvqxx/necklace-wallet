import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { GRAIN_PER_PRL } from "@necklace/shared";
import { FeeBreakdown } from "./FeeBreakdown.js";

/**
 * Locks the fee-policy transparency invariants (fee-policy §1, §3, §6): the flat
 * Necklace fee MUST always render as its own labelled line with its destination
 * address, separate from the network fee, and the total must equal recipient +
 * Necklace fee + network fee (change returns to the user, not part of the debit).
 */

const FEE_ADDR = "rprl1plmkpatlwc840amq74lhvr6h7as02lmkpatlwc840amq74lhvr6hsueaf09w";

describe("FeeBreakdown transparency", () => {
  const html = renderToStaticMarkup(
    <FeeBreakdown
      recipientValue={2n * GRAIN_PER_PRL}
      necklaceFeeValue={GRAIN_PER_PRL / 100n} // 0.01 PRL
      necklaceFeeAddress={FEE_ADDR}
      networkFee={150000n}
      change={29885000n}
    />,
  );

  it("renders a labelled Necklace fee line", () => {
    expect(html).toContain("Necklace fee");
    expect(html).toContain("0.01 PRL");
  });

  it("shows the Necklace fee destination address (never hidden)", () => {
    expect(html).toContain(FEE_ADDR);
  });

  it("shows the network fee as a separate line", () => {
    expect(html).toContain("Network fee");
    expect(html).toContain("0.0015 PRL"); // 150000 grain
  });

  it("shows recipient, change, and a total-debited line", () => {
    expect(html).toContain("To recipient");
    expect(html).toContain("Change (returns to you)");
    expect(html).toContain("Total debited");
    // total = 2 + 0.01 + 0.0015 = 2.0115 PRL
    expect(html).toContain("2.0115 PRL");
  });
});
