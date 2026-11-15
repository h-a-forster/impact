import { applyDiscount } from "../pricing/discount.ts";

export interface ImportedOrder {
  id: string;
  totalCents: number;
}

/** Parse one CSV row: `id,subtotalCents,discountPercent`. */
export function parseOrderRow(row: string): { id: string; subtotalCents: number; discountPercent: number } {
  const parts = row.split(",").map((part) => part.trim());
  if (parts.length !== 3) {
    throw new Error("expected 3 columns: id,subtotalCents,discountPercent");
  }
  const [id, subtotal, percent] = parts;
  const subtotalCents = Number(subtotal);
  const discountPercent = Number(percent);
  if (!id || !Number.isInteger(subtotalCents) || !Number.isInteger(discountPercent)) {
    throw new Error("invalid order row: " + row);
  }
  if (subtotalCents < 0) {
    throw new Error("negative subtotal in order row: " + row);
  }
  return { id, subtotalCents, discountPercent };
}

/** Bulk order import. Prices each row with the shared discount maths. */
export function importOrder(row: string): ImportedOrder {
  const order = parseOrderRow(row);
  return {
    id: order.id,
    totalCents: applyDiscount(order.subtotalCents, order.discountPercent),
  };
}
