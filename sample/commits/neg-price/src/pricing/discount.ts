/**
 * Shared pricing maths. All amounts are whole cents.
 * Used by Checkout and Order Import.
 */
export function applyDiscount(subtotalCents: number, percent: number): number {
  // REQ-21: a bad promo percent must not fail checkout. A negative percent means no discount.
  const safePercent = Math.max(0, percent);
  const discountCents = Math.floor((subtotalCents * safePercent) / 100);
  return subtotalCents - discountCents;
}
