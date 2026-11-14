import { test } from "node:test";
import assert from "node:assert/strict";
import { importOrder } from "../src/import/orderImport.ts";

test("import: a row with the wrong column count is rejected", () => {
  assert.throws(() => importOrder("A-1,105"), /expected 3 columns/);
});

test("REQ-17 import: 105 cents at 10% totals 94 cents", () => {
  assert.equal(importOrder("A-1,105,10").totalCents, 94);
});

test("REQ-17 import: zero discount keeps the total at 105 cents", () => {
  assert.equal(importOrder("A-2,105,0").totalCents, 105);
});
