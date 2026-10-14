# Security controls, review checklist and known limitations

## Controls implemented

| Area | Control | Where | Verified by |
|---|---|---|---|
| Renderer isolation | `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, `webviewTag: false`, `app.enableSandbox()` for all renderers | `src/main/security.ts`, `src/main/index.ts` | `tests/main/security.test.ts`; E2E probe: `require`, `process`, `module`, `Buffer` are undefined in the page |
| Preload surface | One frozen function per allowed channel under `window.cmm`; no generic invoke, no `fs`, no Node APIs | `src/preload/index.ts` | unit test (source + built bundle only requires `electron`); E2E checks the exposed namespaces |
| IPC validation | Unknown channels rejected; sender URL must be the app's own page; every payload parsed with a strict Zod schema (unknown keys rejected); unexpected errors return a generic message and are logged | `src/main/ipc/router.ts`, `src/shared/schemas.ts` | `security.test.ts` (wrong types, extra keys, injection-shaped payloads, untrusted sender) + E2E |
| Filesystem | Renderer never supplies paths; exports, imports, backups and restores use native dialogs in the main process; the database path is fixed | `src/main/ipc/routes.ts` | test: payload with `path` rejected |
| SQL | Parameterised statements only; table names for lookups come from a fixed whitelist; `LIKE` wildcards escaped | services | test: SQL-injection text stored and searched as data |
| Navigation / windows | `will-navigate`/`will-redirect` limited to the app; `setWindowOpenHandler` denies all; `<webview>` blocked; permission requests denied; downloads blocked | `security.ts` | unit tests + E2E (`window.open`, `location.href` to external site) |
| Network | Every request from every window is cancelled unless it targets `app://` (or the local Vite server in development) — no data can be transmitted; no telemetry | `installSessionGuards` | unit tests + E2E (`fetch('https://example.com')` blocked) |
| Content loading | Packaged app served from a privileged `app://` scheme with path-traversal protection, `nosniff`, and a strict CSP (`script-src 'self'`, no `unsafe-eval`, `connect-src 'self'`) | `src/main/protocol.ts`, `src/shared/csp.ts` | traversal tests, CSP test |
| Reports | Generated HTML is fully escaped, served with `default-src 'none'`, shown in a window with JavaScript disabled | `services/reports.ts`, `index.ts` | test with `<script>`/`<img onerror>` customer data |
| CSV | Untrusted input: size/row limits, strict parsing, full validation before any write; text cells starting with `= + - @ \t \r` (and `| %`) are prefixed with `'` on export; numeric/money columns stay numeric | `shared/csv.ts`, `services/csv-import.ts` | `csv.test.ts`, `security.test.ts` |
| Data integrity | FK enforcement, CHECK constraints, immutability and reversal triggers, append-only audit log and import history, `synchronous=FULL` WAL | migration 001 | `ledger.test.ts`, `database.test.ts` |
| Logging | Operation names and error messages only; emails, phone numbers, amounts and secrets redacted; log rotation | `src/main/logger.ts` | `security.test.ts` |
| Backups | Optional AES-256-GCM encryption (scrypt KDF, auth tag, magic header as AAD); passphrase never stored; tamper detection | `services/backup.ts` | `database.test.ts` |
| Single instance | Second launches focus the existing window (one writer per database) | `index.ts` | — |

## Review checklist (status)

- [x] Renderer cannot access Node.js APIs directly — automated (unit + E2E, dev build **and** packaged exe)
- [x] Renderer cannot open arbitrary files through IPC — automated
- [x] IPC inputs validated — automated
- [x] Malicious CSV content cannot execute code — automated (formula guard, HTML escaping, no-script report window)
- [x] External navigation cannot gain privileged access — automated
- [x] Local database path is fixed and not renderer-controlled — automated
- [x] Database queries parameterised — automated + code review
- [x] App does not transmit local data — network guard automated; no networking code in the app
- [ ] Code signing — **not configured**; installer is unsigned (SmartScreen warning)
- [ ] Database encryption at rest — **not implemented** (see limitations)
- [ ] Independent penetration test / third-party review — not performed
- [ ] `npm audit`: 8 moderate advisories in build-time tooling (`sprintf-js` via electron-builder → `@electron/get`); not shipped in the app. Re-check before each release.

## Known limitations

1. **The live database is not encrypted.** SQLCipher-style encryption is not available in the stock `better-sqlite3` build. Protection relies on the Windows user profile ACLs of `%APPDATA%` and on BitLocker/device encryption. Encrypted *backups* are available.
2. **Single-user mode.** There are no in-app logins or roles. The “operator name” is a label, not an authenticated identity, so anyone with access to the Windows account can use the app and the audit log cannot prove who acted. Use separate Windows accounts for separate people. Corrections, overrides and restores require reasons/confirmations but not a second approver.
3. **Unsigned installer** (see above). Auto-update is not configured.
4. **Single currency per database.** The currency is locked after the first transaction; multi-currency accounts are not supported.
5. **No invoicing / period closing.** Usage entries can always be corrected by reversal; there is no “finalised invoice” state that would freeze a period.
6. **Reversal dating.** Reversals default to the original transaction's date (so period reports show corrected figures); choosing a later date is possible but makes historical reports change only from that date.
7. **CSV import** loads up to 50,000 rows / 20 MB per file into memory. Reversal pairs in exported files are skipped on import (they net to zero), so an imported ledger contains only the surviving entries, not the correction history.
8. **Encrypted backups** are processed in memory (practical limit ~1 GB).
9. **Printing** uses the system print dialog; “Save as PDF” is via the Windows PDF printer.
10. **macOS/Linux** packaging is configured but was not built or tested; Windows x64 is the tested target.
11. **Charts** use a validated categorical palette; the brand charcoal is reserved for UI chrome because it does not meet categorical-colour contrast checks.
12. The 8 moderate `npm audit` advisories are in development/packaging dependencies only.

## Reporting a problem

Logs are at `%APPDATA%\Customer Money Manager\logs\app.log` (redacted). Do not attach database files or backups to public issue trackers — they contain customer data.
