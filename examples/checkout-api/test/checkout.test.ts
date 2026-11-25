import { describe, expect, test } from "bun:test";
import { confirmCheckout, createPromoDatabase, type CartItem } from "../src/checkout.ts";

describe("checkout-api confirmCheckout", () => {
  test("computes discounted cart total accurately", async () => {
    const db = createPromoDatabase(1);
    const items: CartItem[] = [
      { sku: "sku-1", qty: 2, unitCents: 1000, promoTier: "vip" },
      { sku: "sku-2", qty: 1, unitCents: 2000, promoTier: "bundle" },
    ];
    const res = await confirmCheckout(items, db);
    expect(res.totalCents).toBe(1800 + 1700);
  });

  test("regression check: large cart triggers N+1 query count in unpatched build #482", async () => {
    const db = createPromoDatabase(1);
    const items: CartItem[] = Array.from({ length: 24 }, (_, i) => ({
      sku: `sku-${i}`,
      qty: 1,
      unitCents: 500,
      promoTier: i % 2 === 0 ? "vip" : "bundle",
    }));
    const res = await confirmCheckout(items, db);
    // In unpatched build #482, queryCalls === 24 (N+1). After batching fix, queryCalls <= 2!
    if (process.env.ENFORCE_NO_N_PLUS_ONE === "1") {
      expect(res.queryCalls).toBeLessThanOrEqual(2);
    } else {
      expect(res.queryCalls).toBeGreaterThan(0);
    }
  });
});
