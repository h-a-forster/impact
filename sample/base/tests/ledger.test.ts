import { test } from "node:test";
import assert from "node:assert/strict";
import { postCharge } from "../src/payments/ledger.ts";

test("ledger: a charge is posted with its amount", () => {
  assert.equal(postCharge("A-1", 94).amountCents, 94);
});
