/**
 * Shared pricing maths. All amounts are whole cents.
 * Used by Checkout and Order Import.
 */
export function applyDiscount(subtotalCents: number, percent: number): number {
  if (percent < 0 || percent > 100) {
    throw new RangeError("percent must be between 0 and 100");
  }
  // REQ-17: round the discount to the nearest cent, half-cents up.
  const discountCents = Math.floor((subtotalCents * percent + 50) / 100);
  return subtotalCents - discountCents;
}
