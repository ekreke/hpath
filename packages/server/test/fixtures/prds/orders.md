# Orders and Payments PRD - demo-bank

Sample PRD bundled with the agent test fixtures (SPEC T9, analyze-agent).
Each `Section:` line below is an independently verifiable behavior; drafted
cases reference their section via `source_prd_ref` as `<filename>#<anchor>`.

Section: Order list [anchor:order-list]
The dashboard shows the recent orders of the user in a table with the
columns id, amount and status. Every rendered row must match exactly one
record from GET /api/orders; the UI must never invent or drop orders.

Section: Order cancellation [anchor:cancel]
From the order detail view the user can cancel a pending order. After
cancellation POST /api/orders/cancel and the order detail view must both
report status cancelled.

Section: Balance display [anchor:balance]
The dashboard balance card renders GET /api/balance with exactly two
decimal places and a currency code, default USD.
