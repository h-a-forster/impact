import { test } from "node:test";
import assert from "node:assert/strict";
import { checkoutTotal } from "../src/checkout/checkout.ts";

test("checkout: 200 cents at 10% totals 180 cents", () => {
  const cart = { items: [{ priceCents: 100, quantity: 2 }], discountPercent: 10 };
  assert.equal(checkoutTotal(cart), 180);
});

test("REQ-21 checkout: a negative promo percent counts as no discount", () => {
  const cart = { items: [{ priceCents: 100, quantity: 2 }], discountPercent: -5 };
  assert.equal(checkoutTotal(cart), 200);
});

test("REQ-21 checkout: a bad promo percent no longer fails checkout", () => {
  const cart = { items: [{ priceCents: 100, quantity: 2 }], discountPercent: 150 };
  assert.doesNotThrow(() => checkoutTotal(cart));
});

test("REQ-21 checkout: percents from 0 to 100 keep their totals", () => {
  const total = (discountPercent: number) => checkoutTotal({ items: [{ priceCents: 100, quantity: 2 }], discountPercent });
  assert.deepEqual([0, 10, 100].map(total), [200, 180, 0]);
});
