# Payment Domain PRD — demo-bank

Sample product requirements document bundled with the server seed (SPEC T3).
Sections below are referenced by seeded cases via `source_prd_ref`.

## Balance display (`#balance-display`)

After a successful login the dashboard must show the account balance on a
dedicated balance card.

- The card renders the balance with exactly two decimal places and a currency
  code (default `USD`).
- The web frontend, the HTTP endpoint `GET /api/balance` and the gRPC service
  `BalanceService/GetBalance` must always report the same value.
- Any drift between the three sides is a defect.

## Transfer (`#transfer`)

From the dashboard the user can transfer an amount to another account.

- On success the UI shows a confirmation toast with the transferred amount and
  the new balance.
- `POST /api/transfer` and the UI must agree on the resulting balance; the
  balance endpoints (`GET /api/balance`, `BalanceService/GetBalance`) must
  report the updated value everywhere.
- Invalid input (negative amount, insufficient funds) shows a validation
  error and leaves the balance unchanged.
