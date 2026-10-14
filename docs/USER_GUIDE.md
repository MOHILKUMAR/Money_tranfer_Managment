# User guide

## First launch

The dashboard shows a welcome panel with the database location. Before recording money:

1. **Settings → General**: check the currency (₹ INR by default — it locks once transactions exist), date format, business name (printed on reports) and your operator name (recorded as “entered by”).
2. **Settings → Methods & categories**: add or deactivate payment methods, receipt/payout/adjustment categories, usage categories, units and expense categories. Deactivated options remain on old records.
3. Register your first customer (**New → Register customer**, or `Alt+N`).

## How balances work

```
Balance = Opening + Received − Paid to customer − Usage charges + Credit adj. − Debit adj.
```

A positive balance is **credit** the customer has with you, zero is **settled**, negative is an **amount due**. Example: a customer gives ₹10,000, uses ₹2,000 of services and you refund ₹1,500 → ₹6,500 credit.

## Customers

* **Customers** lists every account with received, paid, usage, balance (with a Credit / Amount due / Settled label) and last transaction. Search by name, code or phone; filter by status or balance; sort by clicking column headers.
* Registering: only the name is required. The customer code is generated (`CUST-000001`). An optional opening balance (credit or amount due) is recorded as its own ledger entry with a date and explanation.
* If the name or phone matches an existing customer you are warned and shown the matches; records are never merged — confirm “different customer” to continue.
* **Customer page**: balance summary, actions (record receipt, pay customer, add usage, adjust), statement period, the account ledger with running balance, daily usage history (with corrections), charts, statement CSV export and print. Inactive customers keep their history; new usage is blocked until reactivated.

## Money received / Money paid

* Fill the form, click **Review**, check the confirmation (it shows the balance after), then **Save**. The success message appears only after the database has saved the entry.
* Receipts and payouts are local records of what you report; the app does not verify them with any bank or payment provider.
* Payouts require a reason. If a payout is larger than the customer's available credit, the app warns you and — depending on **Settings → Financial rules** — either blocks it or requires you to tick an authorisation box and give an override reason.
* Link a refund to the original receipt to prevent refunding the same receipt twice.

## Daily usage

* Pick the customer and date, then add as many lines as needed (**Add line**, duplicate a line with the copy icon). Each line is either **Quantity × rate** (with optional unit) or a **Fixed amount** with a reason. Fees and discounts are optional; a discount needs an authorisation note. The charge per line and the total update as you type.
* **Correct** a posted entry from any usage table: the original charge is reversed and, optionally, a corrected charge is posted. The audit log records the reason.
* The page shows today's usage, period totals, average daily usage (period total ÷ calendar days), usage by category, highest-usage customers and daily/weekly/monthly charts.

## Business expenses

Record rent, utilities, supplies, salaries etc. Expenses never change customer balances. Open an expense to reverse it (with a reason). The page shows today / this week / this month totals, category and payment-method breakdowns and a 12-month trend.

## Transactions / Ledger

Every customer ledger entry, filterable by date range, customer, type, payment method, category and text. Click a row for full details, linked payouts, usage detail and audit trail, and to **reverse** the entry or edit its description/notes. Amounts, dates and customers can never be edited — post a reversal instead.

## Dashboard and Analytics

Cards show registered/active customers, today's and this month's receipts, payouts, usage, expenses and net recorded cash flow, plus total customer credit held and total due. Hover the ⓘ icons for definitions. Choose a period (Today, Yesterday, Last 7 / 30 days, This month, Previous month, Custom) to update the charts. Every chart has a table view (grid icon).

## CSV and reports

**CSV Import / Export → Reports & export**: choose a report, set filters, then **Export CSV**, **Print** (opens a print-ready window; choose “Microsoft Print to PDF” to save a PDF), **Save HTML**, or **Preview**. Reports state their generation time and date basis.

**Import CSV**: choose the type (customers, historical transactions, daily usage) and the date format, pick the file, check the column mapping, then **Validate & preview**. Nothing is saved until you click **Import**. Rows are marked valid, duplicate, possible duplicate, skipped or error; errors are never imported (you can choose to skip them), financial imports need an explicit confirmation, and existing records are never overwritten. The “All transactions” and “Daily usage report” exports can be imported back. Import history is kept.

## Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl+K` | Search customers |
| `Alt+R` | Record money received |
| `Alt+P` | Record money paid to customer |
| `Alt+U` | Add daily usage |
| `Alt+E` | Record business expense |
| `Alt+N` | Register customer |
| `↑ ↓ Enter` | Choose from search results |

## Backups

See [BACKUP_RESTORE.md](BACKUP_RESTORE.md). The top bar shows when the last backup was made and turns red if there has never been one or it is a week old.
