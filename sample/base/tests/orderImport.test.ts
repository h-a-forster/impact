import { test } from "node:test";
import assert from "node:assert/strict";
import { importOrder } from "../src/import/orderImport.ts";

test("import: a row with the wrong column count is rejected", () => {
  assert.throws(() => importOrder("A-1,105"), /expected 3 columns/);
});
