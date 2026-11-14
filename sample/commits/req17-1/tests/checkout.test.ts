import { test } from "node:test";
import assert from "node:assert/strict";
import { checkoutTotal } from "../src/checkout/checkout.ts";

test("checkout: 200 cents at 10% totals 180 cents", () => {
  const cart = { items: [{ priceCents: 100, quantity: 2 }], discountPercent: 10 };
  assert.equal(checkoutTotal(cart), 180);
});

test("REQ-17 checkout: 105 cents at 10% totals 94 cents", () => {
  const cart = { items: [{ priceCents: 105, quantity: 1 }], discountPercent: 10 };
  assert.equal(checkoutTotal(cart), 94);
});

test("REQ-17 checkout: zero discount keeps the total at 105 cents", () => {
  const cart = { items: [{ priceCents: 105, quantity: 1 }], discountPercent: 0 };
  assert.equal(checkoutTotal(cart), 105);
});
