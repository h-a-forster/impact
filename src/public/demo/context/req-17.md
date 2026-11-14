# context.md

Made up for the session. In the real feature, the coding agent saves this file with its pull request: a snapshot of what it knew and decided while it worked.

## Snapshot

- Agent: shop coding agent
- Pull request: req-17
- Commit: ae08cfb

## The task

REQ-17: discounts round to the nearest cent, with half a cent rounded up. Checkout and Order Import must both follow it.

## What must stay the same

At zero discount, a 105-cent order still totals 105 cents.

## What I did

In `applyDiscount()` I add 50 before dividing by 100, so half-cents round up. Whole-cent integer maths only.

## Why this way

Checkout and Order Import both call `applyDiscount()`, so one line changes both.

## What I tested

A Checkout test: 105 cents at 10% totals 94 cents. All tests pass.

## What I did not test

Order Import. No test runs a REQ-17 case through `importOrder()`.
