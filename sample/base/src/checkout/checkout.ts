import { applyDiscount } from "../pricing/discount.ts";

export interface CartItem {
  priceCents: number;
  quantity: number;
}

export interface Cart {
  items: CartItem[];
  discountPercent: number;
}

export function cartSubtotal(cart: Cart): number {
  let subtotal = 0;
  for (const item of cart.items) {
    subtotal += item.priceCents * item.quantity;
  }
  return subtotal;
}

/** Total the customer pays at web checkout. */
export function checkoutTotal(cart: Cart): number {
  return applyDiscount(cartSubtotal(cart), cart.discountPercent);
}
