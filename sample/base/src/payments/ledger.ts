export interface LedgerEntry {
  orderId: string;
  amountCents: number;
  note: string;
}

/** Payments ledger. Team-designated critical path. */
export function postCharge(orderId: string, amountCents: number): LedgerEntry {
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new RangeError("amountCents must be a non-negative integer");
  }
  return { orderId, amountCents, note: "charge posted" };
}
