# context.md

Made up for the session. In the real feature, the coding agent saves this file with its pull request: a snapshot of what it knew and decided while it worked.

## Snapshot

- Agent: shop coding agent
- Pull request: req-22
- Commit: e549d90

## The task

REQ-22: Order Import rejects a row with a negative subtotal, with a clear error. Checkout is not part of it.

## What must stay the same

A valid row still imports at its discounted total. A zero subtotal is still allowed.

## What I did

In `parseOrderRow()` I added one check after the existing number checks: a subtotal below zero throws "negative subtotal in order row".

## Why this way

`importOrder()` reads every row through `parseOrderRow()`, and that function already rejects bad rows. The new rule sits next to the old ones, and nothing else calls it.

## What I tested

Three Order Import tests that name REQ-22: the row `A-3,-500,0` is rejected, a 105-cent row still totals 105 cents, and a zero subtotal is allowed. All tests pass.

## What I did not test

Nothing in scope. Checkout does not read order rows, so it does not change.
