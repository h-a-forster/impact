# REQ-21 A negative promo percent means no discount

Operations sometimes enter -5 in the promo field to mean "no promotion".
Today applyDiscount() throws on it: the customer sees an error page at
checkout, and Order Import rejects the row.

- A negative percent counts as no discount: a 200-cent cart at -5% totals
  200 cents, and an imported 105-cent row at -5% totals 105 cents.
- Behaviour to preserve: percents from 0 to 100 give the same totals as before.

Affected workflows: Checkout, Order Import.
