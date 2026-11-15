# REQ-22 Order Import rejects a negative subtotal

Partner files sometimes carry a negative subtotal by mistake. Today Order
Import accepts such a row: `A-3,-500,0` imports as an order of -500 cents,
which reads as money owed to the customer.

- A row with a negative subtotal is rejected with a clear error, the same way
  a row with a missing column is.
- Behaviour to preserve: a valid row still imports at its discounted total
  (105 cents at 0% totals 105 cents), and a zero subtotal is still allowed.

Affected workflows: Order Import.
