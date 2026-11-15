# context.md

Made up for the session. In the real feature, the coding agent saves this file with its pull request: a snapshot of what it knew and decided while it worked.

## Snapshot

- Agent: shop coding agent
- Pull request: req-21
- Commit: 977be6e

## The task

REQ-21: operations type -5 in the promo field to mean "no promotion". That must count as no discount instead of an error, in Checkout and in Order Import.

## What must stay the same

Percents from 0 to 100 give the same totals as before.

## What I did

In `applyDiscount()` I replaced the range check that threw with `Math.max(0, percent)`, so a negative percent means no discount.

## Why this way

Checkout and Order Import both call `applyDiscount()`, so one change fixes both. I wanted a bad promo value never to fail checkout again.

## What I tested

Checkout: -5% totals 200 cents, 0, 10 and 100% keep their totals, and 150% no longer throws. Order Import: a 105-cent row at -5% totals 105 cents. All tests pass.

## What I did not test

What 150% gives. I only checked that it does not throw. Without the old check, a percent above 100 now gives a total below zero.
