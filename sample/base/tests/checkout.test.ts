import { test } from "node:test";
import assert from "node:assert/strict";
import { checkoutTotal } from "../src/checkout/checkout.ts";

test("checkout: 200 cents at 10% totals 180 cents", () => {
  const cart = { items: [{ priceCents: 100, quantity: 2 }], discountPercent: 10 };
  assert.equal(checkoutTotal(cart), 180);
});
