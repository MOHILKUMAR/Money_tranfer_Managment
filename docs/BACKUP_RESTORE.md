# Backup and restore

## Making a backup

**Backup / Restore → Create a backup**

* **Back up to folder** writes `customer-money-manager-YYYYMMDD-HHMMSS.sqlite` into the backup folder (default `%APPDATA%\Customer Money Manager\backups`; use **Change folder…** to pick e.g. a USB drive).
* **Save backup as…** lets you choose the file name and location.
* Tick **Encrypt this backup** to write an encrypted `.cmmbak` file (AES-256-GCM, key derived from your passphrase with scrypt). The passphrase is never stored; without it the backup cannot be restored.
* Optional: **Automatically back up when the app starts** (at most once every ~20 hours, keeps the newest 14 automatic backups).

How it works: the app takes a consistent snapshot with SQLite's online backup API while it is open, re-opens the copy, runs `PRAGMA integrity_check` and schema checks, and only then reports success. A failed backup never leaves a partial file.

**Recommendation:** keep at least one recent backup on a separate device (external disk or USB drive). No paid cloud storage is required, and the app never uploads anything.

## Restoring

**Backup / Restore → Choose backup to restore…**

1. Select a `.sqlite` or `.cmmbak` file (enter the passphrase for encrypted backups).
2. The file is validated in a private temporary copy: SQLite header, integrity check, foreign keys, application id, required tables and schema version (backups from a newer app version are refused). Your live data is not touched. The dialog shows what the backup contains.
3. Type `RESTORE` to confirm.
4. A safety backup of the current data is written (`pre-restore-*.sqlite` in the backups folder).
5. The live database is **replaced as a whole** (records are never merged), re-opened, migrated if the backup is from an older version, and checked again (SQLite integrity plus ledger reconciliation).
6. If any step fails, the safety backup is put back automatically and you are told the restore failed.

To undo a restore, restore the `pre-restore-*.sqlite` file.

## Checking the database

* In the app: **Backup / Restore → Database integrity → Run check** (SQLite integrity, foreign keys, every usage entry posted exactly once, reversals mirror their originals, no receipt refunded beyond its amount, SQL balances equal the documented balance rule).
* From a terminal (developer build): `npm run db:check` (production data), `npm run db:check -- --dev`, or `npm run db:check -- --data "<folder>"`.

## Manual copies

The database is a single SQLite file. If you copy it manually, close the app first (it uses WAL mode, so a copy taken while open may miss recent changes); using the in-app backup avoids this.
