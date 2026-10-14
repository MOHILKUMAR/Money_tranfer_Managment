import type { Migration } from '../migrations'

const DATE_CHECK = (col: string) => `CHECK (${col} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]')`

const lookupTable = (name: string, extra = '') => `
CREATE TABLE ${name} (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(trim(name)) BETWEEN 1 AND 60),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  ${extra}
  created_at TEXT NOT NULL
);`

export const migration001: Migration = {
  version: 1,
  name: 'initial_schema',
  up(db) {
    db.exec(`
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sequences (
  name TEXT PRIMARY KEY,
  next_value INTEGER NOT NULL CHECK (next_value > 0)
);

${lookupTable('payment_methods')}
${lookupTable(
  'transaction_categories',
  "applies_to TEXT NOT NULL DEFAULT 'ANY' CHECK (applies_to IN ('RECEIPT','PAYOUT','ADJUSTMENT','ANY')),"
)}
${lookupTable('usage_categories')}
${lookupTable('usage_units')}
${lookupTable('expense_categories')}

CREATE TABLE customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_code TEXT NOT NULL COLLATE NOCASE UNIQUE,
  name TEXT NOT NULL CHECK (length(trim(name)) BETWEEN 1 AND 200),
  phone TEXT,
  phone_normalized TEXT,
  email TEXT,
  address TEXT,
  registration_date TEXT NOT NULL ${DATE_CHECK('registration_date')},
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','INACTIVE')),
  notes TEXT,
  idempotency_key TEXT UNIQUE,
  source TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','IMPORT','DEMO')),
  import_id INTEGER REFERENCES csv_import_history(id),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX idx_customers_name ON customers(name COLLATE NOCASE);
CREATE INDEX idx_customers_phone ON customers(phone_normalized);
CREATE INDEX idx_customers_status ON customers(status);

CREATE TABLE csv_import_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  import_kind TEXT NOT NULL CHECK (import_kind IN ('CUSTOMERS','TRANSACTIONS','USAGE')),
  file_name TEXT NOT NULL,
  file_sha256 TEXT NOT NULL,
  total_rows INTEGER NOT NULL CHECK (total_rows >= 0),
  imported_rows INTEGER NOT NULL CHECK (imported_rows >= 0),
  skipped_duplicate_rows INTEGER NOT NULL CHECK (skipped_duplicate_rows >= 0),
  failed_rows INTEGER NOT NULL CHECK (failed_rows >= 0),
  status TEXT NOT NULL CHECK (status IN ('COMPLETED','FAILED')),
  summary_json TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE daily_usage_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  usage_date TEXT NOT NULL ${DATE_CHECK('usage_date')},
  category_id INTEGER NOT NULL REFERENCES usage_categories(id) ON DELETE RESTRICT,
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  method TEXT NOT NULL CHECK (method IN ('QUANTITY','FIXED')),
  quantity_milli INTEGER CHECK (quantity_milli IS NULL OR quantity_milli > 0),
  unit_id INTEGER REFERENCES usage_units(id) ON DELETE RESTRICT,
  rate_minor INTEGER CHECK (rate_minor IS NULL OR rate_minor >= 0),
  base_amount_minor INTEGER NOT NULL CHECK (base_amount_minor >= 0),
  fees_minor INTEGER NOT NULL DEFAULT 0 CHECK (fees_minor >= 0),
  discount_minor INTEGER NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  discount_reason TEXT,
  charge_minor INTEGER NOT NULL CHECK (charge_minor > 0),
  fixed_reason TEXT,
  notes TEXT,
  batch_key TEXT NOT NULL,
  line_no INTEGER NOT NULL CHECK (line_no >= 0),
  replaces_entry_id INTEGER REFERENCES daily_usage_entries(id) ON DELETE RESTRICT,
  source TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','IMPORT','CORRECTION','DEMO')),
  import_id INTEGER REFERENCES csv_import_history(id),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (batch_key, line_no),
  CHECK (charge_minor = base_amount_minor + fees_minor - discount_minor),
  CHECK (method = 'FIXED' OR (quantity_milli IS NOT NULL AND rate_minor IS NOT NULL)),
  CHECK (discount_minor = 0 OR discount_reason IS NOT NULL)
);
CREATE INDEX idx_usage_customer_date ON daily_usage_entries(customer_id, usage_date);
CREATE INDEX idx_usage_date ON daily_usage_entries(usage_date);
CREATE UNIQUE INDEX ux_usage_replaces ON daily_usage_entries(replaces_entry_id) WHERE replaces_entry_id IS NOT NULL;

CREATE TABLE transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  external_ref TEXT UNIQUE,
  idempotency_key TEXT UNIQUE,
  customer_id INTEGER NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  type TEXT NOT NULL CHECK (type IN ('OPENING_BALANCE','RECEIPT','PAYOUT','USAGE','CREDIT_ADJUSTMENT','DEBIT_ADJUSTMENT')),
  txn_date TEXT NOT NULL ${DATE_CHECK('txn_date')},
  amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  payment_method_id INTEGER REFERENCES payment_methods(id) ON DELETE RESTRICT,
  category_id INTEGER REFERENCES transaction_categories(id) ON DELETE RESTRICT,
  usage_entry_id INTEGER REFERENCES daily_usage_entries(id) ON DELETE RESTRICT,
  description TEXT NOT NULL,
  payment_reference TEXT,
  related_txn_id INTEGER REFERENCES transactions(id) ON DELETE RESTRICT,
  reverses_txn_id INTEGER UNIQUE REFERENCES transactions(id) ON DELETE RESTRICT,
  reason TEXT,
  override_reason TEXT,
  notes TEXT,
  source TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','IMPORT','CORRECTION','DEMO')),
  import_id INTEGER REFERENCES csv_import_history(id),
  created_by TEXT,
  created_at TEXT NOT NULL,
  CHECK (reverses_txn_id IS NOT NULL OR amount_minor > 0 OR type = 'OPENING_BALANCE'),
  CHECK ((type = 'USAGE') = (usage_entry_id IS NOT NULL)),
  CHECK (type NOT IN ('RECEIPT','PAYOUT') OR payment_method_id IS NOT NULL),
  CHECK (reverses_txn_id IS NULL OR reason IS NOT NULL)
);
CREATE INDEX idx_txn_customer_date ON transactions(customer_id, txn_date, id);
CREATE INDEX idx_txn_date_type ON transactions(txn_date, type);
CREATE INDEX idx_txn_related ON transactions(related_txn_id) WHERE related_txn_id IS NOT NULL;
CREATE UNIQUE INDEX ux_txn_usage_posting ON transactions(usage_entry_id)
  WHERE usage_entry_id IS NOT NULL AND reverses_txn_id IS NULL;

CREATE TABLE business_expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL UNIQUE,
  idempotency_key TEXT UNIQUE,
  expense_date TEXT NOT NULL ${DATE_CHECK('expense_date')},
  category_id INTEGER NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  description TEXT NOT NULL CHECK (length(trim(description)) > 0),
  amount_minor INTEGER NOT NULL CHECK (amount_minor <> 0),
  currency TEXT NOT NULL CHECK (length(currency) = 3),
  payment_method_id INTEGER NOT NULL REFERENCES payment_methods(id) ON DELETE RESTRICT,
  payment_reference TEXT,
  supplier TEXT,
  notes TEXT,
  reverses_expense_id INTEGER UNIQUE REFERENCES business_expenses(id) ON DELETE RESTRICT,
  reason TEXT,
  source TEXT NOT NULL DEFAULT 'MANUAL' CHECK (source IN ('MANUAL','IMPORT','DEMO')),
  created_by TEXT,
  created_at TEXT NOT NULL,
  CHECK ((reverses_expense_id IS NULL AND amount_minor > 0) OR (reverses_expense_id IS NOT NULL AND amount_minor < 0 AND reason IS NOT NULL))
);
CREATE INDEX idx_expenses_date ON business_expenses(expense_date);
CREATE INDEX idx_expenses_category ON business_expenses(category_id, expense_date);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at TEXT NOT NULL,
  actor TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  summary TEXT,
  before_json TEXT,
  after_json TEXT,
  reason TEXT
);
CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);

-- Ledger immutability: corrections are made with reversal entries, never by
-- editing or deleting posted financial records.
CREATE TRIGGER trg_transactions_no_delete BEFORE DELETE ON transactions
BEGIN SELECT RAISE(ABORT, 'Ledger transactions cannot be deleted; post a reversal instead'); END;

CREATE TRIGGER trg_transactions_immutable
BEFORE UPDATE OF reference, external_ref, idempotency_key, customer_id, type, txn_date, amount_minor,
  currency, payment_method_id, category_id, usage_entry_id, related_txn_id, reverses_txn_id,
  override_reason, source, import_id, created_at, created_by ON transactions
BEGIN SELECT RAISE(ABORT, 'Posted ledger entries cannot be changed; post a reversal instead'); END;

CREATE TRIGGER trg_transactions_reversal_check BEFORE INSERT ON transactions
WHEN NEW.reverses_txn_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Invalid reversal: it must mirror an unreversed original entry')
  WHERE NOT EXISTS (
    SELECT 1 FROM transactions o
    WHERE o.id = NEW.reverses_txn_id
      AND o.reverses_txn_id IS NULL
      AND o.customer_id = NEW.customer_id
      AND o.type = NEW.type
      AND o.amount_minor = -NEW.amount_minor
      AND o.currency = NEW.currency
      AND o.usage_entry_id IS NEW.usage_entry_id
  );
END;

CREATE TRIGGER trg_transactions_usage_check BEFORE INSERT ON transactions
WHEN NEW.type = 'USAGE' AND NEW.reverses_txn_id IS NULL
BEGIN
  SELECT RAISE(ABORT, 'Usage posting must match its usage entry')
  WHERE NOT EXISTS (
    SELECT 1 FROM daily_usage_entries u
    WHERE u.id = NEW.usage_entry_id
      AND u.customer_id = NEW.customer_id
      AND u.charge_minor = NEW.amount_minor
      AND u.usage_date = NEW.txn_date
  );
END;

CREATE TRIGGER trg_usage_no_delete BEFORE DELETE ON daily_usage_entries
BEGIN SELECT RAISE(ABORT, 'Usage entries cannot be deleted; use a correction instead'); END;

CREATE TRIGGER trg_usage_immutable
BEFORE UPDATE OF customer_id, usage_date, category_id, method, quantity_milli, unit_id, rate_minor,
  base_amount_minor, fees_minor, discount_minor, charge_minor, batch_key, line_no, replaces_entry_id,
  source, import_id, created_at, created_by ON daily_usage_entries
BEGIN SELECT RAISE(ABORT, 'Posted usage charges cannot be changed; use a correction instead'); END;

CREATE TRIGGER trg_expenses_no_delete BEFORE DELETE ON business_expenses
BEGIN SELECT RAISE(ABORT, 'Expenses cannot be deleted; post a reversal instead'); END;

CREATE TRIGGER trg_expenses_immutable
BEFORE UPDATE OF reference, idempotency_key, expense_date, category_id, amount_minor, currency,
  payment_method_id, reverses_expense_id, source, created_at, created_by ON business_expenses
BEGIN SELECT RAISE(ABORT, 'Posted expenses cannot be changed; post a reversal instead'); END;

CREATE TRIGGER trg_expenses_reversal_check BEFORE INSERT ON business_expenses
WHEN NEW.reverses_expense_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'Invalid expense reversal')
  WHERE NOT EXISTS (
    SELECT 1 FROM business_expenses o
    WHERE o.id = NEW.reverses_expense_id
      AND o.reverses_expense_id IS NULL
      AND o.amount_minor = -NEW.amount_minor
      AND o.category_id = NEW.category_id
      AND o.currency = NEW.currency
  );
END;

CREATE TRIGGER trg_audit_no_update BEFORE UPDATE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'Audit log entries are append-only'); END;
CREATE TRIGGER trg_audit_no_delete BEFORE DELETE ON audit_logs
BEGIN SELECT RAISE(ABORT, 'Audit log entries are append-only'); END;

CREATE TRIGGER trg_import_history_no_delete BEFORE DELETE ON csv_import_history
BEGIN SELECT RAISE(ABORT, 'Import history is append-only'); END;
`)

    const now = new Date().toISOString()
    const seedLookup = (table: string, names: string[]) => {
      const stmt = db.prepare(`INSERT INTO ${table} (name, sort_order, created_at) VALUES (?, ?, ?)`)
      names.forEach((name, index) => stmt.run(name, index, now))
    }
    seedLookup('payment_methods', ['Cash', 'Bank transfer', 'UPI', 'Card terminal', 'Cheque', 'Other'])
    seedLookup('usage_categories', ['Service', 'Resource usage', 'Consumables', 'Other usage'])
    seedLookup('usage_units', ['units', 'hours', 'days', 'pieces', 'kg', 'litres'])
    seedLookup('expense_categories', [
      'Rent',
      'Utilities',
      'Supplies',
      'Transport',
      'Salaries',
      'Maintenance',
      'Other operating expenses'
    ])
    const categoryStmt = db.prepare(
      'INSERT INTO transaction_categories (name, applies_to, sort_order, created_at) VALUES (?, ?, ?, ?)'
    )
    ;[
      ['Advance deposit', 'RECEIPT'],
      ['Payment against dues', 'RECEIPT'],
      ['Top-up', 'RECEIPT'],
      ['Refund', 'PAYOUT'],
      ['Return of unused advance', 'PAYOUT'],
      ['Other payout', 'PAYOUT'],
      ['Goodwill credit', 'ADJUSTMENT'],
      ['Billing correction', 'ADJUSTMENT'],
      ['Late fee', 'ADJUSTMENT']
    ].forEach(([name, appliesTo], index) => categoryStmt.run(name, appliesTo, index, now))

    const seqStmt = db.prepare('INSERT INTO sequences (name, next_value) VALUES (?, 1)')
    for (const name of ['CUST', 'OPN', 'RCP', 'PAY', 'USG', 'CRA', 'DRA', 'REV', 'EXP']) seqStmt.run(name)
  }
}
