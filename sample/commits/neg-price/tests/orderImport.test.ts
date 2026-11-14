import { test } from "node:test";
import assert from "node:assert/strict";
import { importOrder } from "../src/import/orderImport.ts";

test("import: a row with the wrong column count is rejected", () => {
  assert.throws(() => importOrder("A-1,105"), /expected 3 columns/);
});

test("REQ-21 import: a row with a negative percent imports at full price", () => {
  assert.equal(importOrder("A-2,105,-5").totalCents, 105);
});
