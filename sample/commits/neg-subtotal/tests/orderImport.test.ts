import { test } from "node:test";
import assert from "node:assert/strict";
import { importOrder } from "../src/import/orderImport.ts";

test("import: a row with the wrong column count is rejected", () => {
  assert.throws(() => importOrder("A-1,105"), /expected 3 columns/);
});

test("REQ-22 import: a row with a negative subtotal is rejected", () => {
  assert.throws(() => importOrder("A-3,-500,0"), /negative subtotal/);
});

test("REQ-22 import: a valid row still imports at its total", () => {
  assert.equal(importOrder("A-4,105,0").totalCents, 105);
});

test("REQ-22 import: a zero subtotal is still allowed", () => {
  assert.equal(importOrder("A-5,0,10").totalCents, 0);
});
