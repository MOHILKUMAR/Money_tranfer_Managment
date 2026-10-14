# Customer Money Manager

An offline Windows desktop application for managing customer accounts: money received from customers, money paid back to customers, daily usage / service charges, credit and debit adjustments, business expenses, analytics, CSV import/export, printable reports, and verified local backups.

All data is stored in a local SQLite database on your computer. The app makes **no network requests**, has **no telemetry** and needs **no cloud service**.

| | |
|---|---|
| Desktop shell | Electron 44 (sandboxed, context-isolated renderer) |
| UI | React 19 + TypeScript, Vite 8 (electron-vite), Tailwind CSS 4, shadcn-style components on Radix UI, Lucide icons, Recharts |
| Forms / validation | React Hook Form + Zod (the same Zod schemas validate every IPC request in the main process) |
| Database | SQLite via `better-sqlite3` 13 (N-API prebuilt binary — no compiler needed), main process only |
| Tests | Vitest + React Testing Library, Playwright for Electron (E2E) |
| Packaging | electron-builder → NSIS installer for Windows x64 |

## Quick start

Requirements: Windows 10/11 x64 and Node.js ≥ 22.12 (tested with Node 22.19). No Python or Visual Studio is required.

```bash
npm install
```

```bash
npm run dev
```

`npm run dev` opens the app with hot reload. Development data is kept separately in `%APPDATA%\Customer Money Manager (Development)` so it never touches production data.

To explore with synthetic data, start the clearly labelled demo environment (separate demo database, red “DEMO” banner):

```bash
npm run dev:demo
```

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Development mode with hot reload |
| `npm run dev:demo` | Development mode on the separate synthetic demo database |
| `npm run build` | Type-checks all projects and builds `out/` (main, preload, renderer) |
| `npm start` | Runs the built app (`electron-vite preview`) |
| `npm run typecheck` | `tsc` for main/preload/shared, renderer and E2E projects |
| `npm run lint` | ESLint (TypeScript, React hooks, no-eval rules) |
| `npm test` | All unit, integration and component tests (Vitest) |
| `npm run test:e2e` | Builds and drives the real Electron app with Playwright |
| `npm run test:e2e:packaged` | Runs the same E2E suite against the packaged `.exe` |
| `npm run test:all` | typecheck + lint + unit tests + E2E |
| `npm run db:check` | Integrity + ledger reconciliation check of the installed app's database (`-- --dev`, `-- --demo`, `-- --data <folder>`) |
| `npm run package:win` | Builds the Windows NSIS installer into `release/<version>/` |
| `npm run package:dir` | Unpacked Windows build (no installer) for quick testing |
| `npm run package:mac` / `package:linux` | macOS DMG / Linux AppImage (must be run on that OS; untested here) |
| `npm run icon` | Regenerates the placeholder icon in `build/` |
| `npm run screenshots -- <dataDir> <outDir> [--demo]` | Captures every screen of the built app |

## Building the Windows installer

```bash
npm run package:win
```

Output: `release/1.0.0/Customer-Money-Manager-Setup-1.0.0-x64.exe` (assisted installer: per-user install, choice of folder, desktop and Start-menu shortcuts). The unpacked app is in `release/1.0.0/win-unpacked/`.

* **The installer is not digitally signed.** No code-signing certificate is configured, so Windows SmartScreen will warn on first run (“More info → Run anyway”). To sign, set `CSC_LINK`/`CSC_KEY_PASSWORD` (or `win.certificateFile`) for electron-builder.
* The SQLite engine is the N-API prebuilt binary shipped inside `better-sqlite3`; it is ABI-stable across Node and Electron, so no `electron-rebuild` step is needed. Only the `win32-x64` binary is packaged and it is unpacked from the asar archive.
* Uninstalling keeps your data in `%APPDATA%\Customer Money Manager`.

## Where data is stored

| What | Location (Windows) |
|---|---|
| Database | `%APPDATA%\Customer Money Manager\data\customer-money-manager.sqlite` |
| Default backup folder | `%APPDATA%\Customer Money Manager\backups` (changeable in the app) |
| Safety backups (before restores / migrations) | same backups folder, `pre-restore-*` / `pre-migration-*` |
| Application log (redacted) | `%APPDATA%\Customer Money Manager\logs\app.log` |
| Demo database | `%APPDATA%\Customer Money Manager\demo\` |

The database is **not encrypted** by the app; see [docs/SECURITY.md](docs/SECURITY.md).

## Documentation

* [docs/USER_GUIDE.md](docs/USER_GUIDE.md) — how to use every screen
* [docs/BACKUP_RESTORE.md](docs/BACKUP_RESTORE.md) — backup, encrypted backup, restore and recovery
* [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — design decisions, financial model, schema, migrations, IPC
* [docs/SECURITY.md](docs/SECURITY.md) — security controls, review checklist and known limitations

## Project layout

```
src/
  shared/      Pure TypeScript shared by both processes: money math, balance rules,
               Zod schemas, CSV, dates, IPC channel list and API contract
  main/        Electron main process: lifecycle, security, app:// protocol, IPC router,
               SQLite (connection, migrations, manager) and all services
  preload/     Sandboxed preload: exposes one function per allowed channel as window.cmm
  renderer/    React UI (pages, forms, charts, shadcn-style components)
tests/main     Services, database, CSV, reports, security/IPC, 15-step workflow
tests/renderer Component tests (React Testing Library, jsdom)
e2e/           Playwright tests that drive the built / packaged Electron app
scripts/       db-check, icon generator, screenshots, packaged E2E runner
build/         Installer resources (placeholder icon)
```
