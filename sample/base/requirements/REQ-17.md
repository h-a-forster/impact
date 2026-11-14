# REQ-17 Round discounts to the nearest cent

Checkout and Order Import round discounts to the nearest cent, with
half-cents rounded up.

- With a 105-cent order and a 10% discount, the discount is 11 cents and the
  total is 94 cents.
- Behaviour to preserve: at zero discount the total stays 105 cents.

Affected workflows: Checkout, Order Import.
