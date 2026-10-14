# Architecture and implementation decisions

## Starting point

The repository was an empty clone (`origin` → `MOHILKUMAR/Money_tranfer_Managment`, no commits), so the project was initialised from scratch on the requested stack. Nothing pre-existing had to be preserved.

## Process model

```
┌───────────────────────── Renderer (sandboxed, contextIsolation) ─────────────────────────┐
│ React UI → lib/api.call('ledger:recordReceipt', payload) → window.cmm.ledger.recordReceipt │
└───────────────────────────────────────────┬───────────────────────────────────────────────┘
                                            │ ipcRenderer.invoke (one function per channel)
┌───────────────────────── Main process ────┴───────────────────────────────────────────────┐
│ ipc/router: known channel? trusted sender URL? Zod-valid payload? → handler               │
│ ipc/routes: channel → service call; file paths only from native dialogs                   │
│ services/*: customers, ledger, usage, expenses, analytics, reports, csv-import, backup    │
│ db/manager: one better-sqlite3 connection, migrations, safety backups, restore            │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

* SQLite, the filesystem and dialogs are used **only** in the main process.
* The renderer receives typed DTOs (`src/shared/types.ts`); the full request/response contract is `src/shared/api.ts` and is checked at compile time against the channel list.
* Every response is an envelope `{ ok: true, data } | { ok: false, error: { code, message } }`. The UI shows a success toast only after the main process returns `ok: true`, i.e. after the SQLite transaction has committed.

## Financial model

### Balance convention `credit-positive-v1`

Defined once in `src/shared/finance.ts` (`BALANCE_SIGN`):

```
Closing balance = Opening balance + Money received − Money paid to customer
                − Usage charges + Credit adjustments − Debit adjustments
> 0 credit held for the customer · = 0 settled · < 0 customer owes the business
```

The SQL used by every query (`balanceEffectSql()`) is **generated from the same sign table**, and the integrity check cross-checks SQL balances against the TypeScript rule. The convention id is stored in settings; a future alternative convention must be added as a new, tested rule with its own id rather than changing the meaning of existing balances.

### Ledger design

* One authoritative ledger table, `transactions`, with types `OPENING_BALANCE`, `RECEIPT`, `PAYOUT`, `USAGE`, `CREDIT_ADJUSTMENT`, `DEBIT_ADJUSTMENT`. Customer balances are always **derived** from it (no stored balance column, so nothing can drift).
* `amount_minor` is stored in the natural direction of the type (positive). Opening balances may be negative (amount due).
* **Corrections are reversals**: a reversal is a new row of the same type with the negated amount and `reverses_txn_id` pointing to the original. Per-type totals therefore net out naturally on the reversal's date. By default the reversal is dated on the original's date so date-based reports show the corrected figure; the user can choose another date.
* Database triggers make posted rows immutable (no `UPDATE` of financial columns, no `DELETE`) and verify that a reversal mirrors an unreversed original. Only `description` and `notes` are editable, with an audit entry.
* Business expenses live in their own table (`business_expenses`) with the same reversal approach and never affect customer balances.

### Money

* Integer minor units everywhere (paise for INR). Parsing is string-based; inputs with more decimals than the currency allows are **rejected, not rounded**.
* Quantity × rate uses quantities in milli-units and `BigInt` multiplication, rounded **half away from zero** to the nearest minor unit (`multiplyQuantityRate`).
* `sumMinor` throws instead of losing precision; per-entry maximum is 10,000,000,000.00 major units.
* The currency (code, locale, minor digits) is stored in settings and on every ledger/expense row; it is locked once any transaction exists.

### Daily usage

`daily_usage_entries` holds the detail (category, method, quantity, unit, rate, fees, discount, reason). Each entry is posted to the ledger **exactly once**: a partial unique index allows one non-reversal `USAGE` row per entry, and a trigger requires the posting to match the entry's customer, date and charge. A correction reverses the posting and (optionally) inserts a replacement entry linked by `replaces_entry_id`. Entry status (`POSTED`/`REVERSED`) is derived from the ledger, not stored.

### Payout rules

* A payout above the customer's available credit is either blocked (`BLOCK` policy) or requires an explicit override flag plus reason (`REQUIRE_OVERRIDE`, default). The override reason is stored on the row and in the audit log.
* A payout may be linked to an original receipt; the service refuses refunds that would exceed the receipt (net of reversed payouts), and a receipt with linked payouts cannot be reversed until the payouts are.

### Atomicity and duplicate submission

* Every write runs in `db.transaction(...).immediate()` (single writer, `BEGIN IMMEDIATE`). Validation, sequence allocation, insert and audit happen inside it; any failure rolls back everything (tested).
* Each form generates an idempotency key (UUID) per logical submission. Unique indexes on `idempotency_key` / `batch_key` mean a repeated request returns the original result (`duplicateRequest: true`) instead of creating a duplicate. Buttons are also disabled while a request is pending.
* Readable references come from a `sequences` table (`CUST-000001`, `RCP-000001`, `PAY-…`, `USG-…`, `OPN-…`, `CRA-…`, `DRA-…`, `REV-…`, `EXP-…`).

## Schema (migration 001)

`app_settings`, `sequences`, `payment_methods`, `transaction_categories`, `usage_categories`, `usage_units`, `expense_categories`, `customers`, `daily_usage_entries`, `transactions`, `business_expenses`, `audit_logs` (append-only via triggers), `csv_import_history` (append-only), `schema_migrations`.

Mapping to the requested tables: `financial_adjustments` is represented by the `CREDIT_ADJUSTMENT`/`DEBIT_ADJUSTMENT` ledger types (a separate table would be a second source of truth); the opening balance is a ledger row, not a customer column. Dates are ISO `YYYY-MM-DD` business dates (`CHECK … GLOB`), timestamps are ISO-8601 UTC.

Connection settings: `foreign_keys=ON`, `journal_mode=WAL`, `synchronous=FULL` (committed transactions survive crashes and power loss), `trusted_schema=OFF`, `application_id = 0x434D4D31` ("CMM1").

## Migrations (including in the packaged app)

`src/main/db/migrations.ts` holds an ordered, append-only list. On every start `DatabaseManager.open()`:

1. Refuses files that are not Customer Money Manager databases (`application_id`) and databases with a **newer** schema than the app (downgrade protection).
2. If migrations are pending on an existing database, writes a safety snapshot `backups/pre-migration-vX-to-vY-*.sqlite` (`VACUUM INTO`).
3. Applies each migration in its own transaction together with its `schema_migrations` row and `PRAGMA user_version`; a failure rolls back that migration, the app shows an error dialog and exits without starting on a half-migrated database.
4. Runs `PRAGMA quick_check`.

Migrations never drop tables or financial history. To ship a schema change: add `migrations/00N_name.ts`, append it to `MIGRATIONS`, add tests (see `tests/main/database.test.ts`), and release a new installer version — users' databases are upgraded on the first start of the new version.

## Analytics and reports

All figures are SQL aggregates over persisted rows filtered by **transaction date** (stated on every dashboard and report). Net recorded cash flow = receipts − customer payouts − business expenses; usage charges, opening balances and adjustments are not cash. Report builders (`services/reports.ts`) produce one typed table per report that is rendered to CSV (exact decimals, ISO dates, UTF-8 with BOM, formula-injection guard) or to script-free HTML for printing.

## Security model

See [SECURITY.md](SECURITY.md).
