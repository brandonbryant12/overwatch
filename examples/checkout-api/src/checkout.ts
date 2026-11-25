export interface CartItem {
  readonly sku: string;
  readonly qty: number;
  readonly unitCents: number;
  readonly promoTier: string;
}

export interface PromoDatabase {
  readonly queryCalls: number;
  findDiscountByTier(tier: string): Promise<number>;
  findDiscountsByTiers(tiers: ReadonlyArray<string>): Promise<Map<string, number>>;
}

export function createPromoDatabase(latencyPerQueryMs = 15): PromoDatabase {
  const table: Record<string, number> = {
    standard: 0,
    vip: 0.1,
    bundle: 0.15,
    clearance: 0.25,
  };
  let calls = 0;

  return {
    get queryCalls() {
      return calls;
    },
    async findDiscountByTier(tier: string): Promise<number> {
      calls += 1;
      await new Promise((r) => setTimeout(r, latencyPerQueryMs));
      return table[tier] ?? 0;
    },
    async findDiscountsByTiers(tiers: ReadonlyArray<string>): Promise<Map<string, number>> {
      calls += 1;
      await new Promise((r) => setTimeout(r, latencyPerQueryMs));
      const out = new Map<string, number>();
      for (const t of new Set(tiers)) {
        out.set(t, table[t] ?? 0);
      }
      return out;
    },
  };
}

/**
 * Sample application endpoint with an intentional build #482 N+1 regression:
 * calls `db.findDiscountByTier(item.promoTier)` sequentially inside the cart item loop
 * instead of batching via `db.findDiscountsByTiers(...)`.
 */
export async function confirmCheckout(
  items: ReadonlyArray<CartItem>,
  db: PromoDatabase,
): Promise<{ readonly totalCents: number; readonly queryCalls: number }> {
  let totalCents = 0;
  for (const item of items) {
    const discount = await db.findDiscountByTier(item.promoTier);
    totalCents += Math.round(item.unitCents * item.qty * (1 - discount));
  }
  return { totalCents, queryCalls: db.queryCalls };
}
