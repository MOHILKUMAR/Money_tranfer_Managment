/**
 * Minimal local file logger with redaction. Logs record operation names and
 * error messages only — never request payloads, balances or customer details.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 1024 * 1024
const KEEP_FILES = 3

/** Removes values that could identify customers or reveal secrets. */
export function redact(text: string): string {
  return text
    .replace(/(passphrase|password|token|secret|api[_-]?key)(["']?\s*[:=]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1$2[redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[email]')
    .replace(/\+?\d[\d\s()-]{7,}\d/g, '[number]')
    .replace(/[₹$€£]\s?[\d,]+(\.\d+)?/g, '[amount]')
}

export class FileLogger {
  private readonly file: string

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    this.file = join(dir, 'app.log')
  }

  info(message: string): void {
    this.write('INFO', message)
  }

  warn(message: string): void {
    this.write('WARN', message)
  }

  error(message: string, error?: unknown): void {
    const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : error ? String(error) : ''
    this.write('ERROR', detail ? `${message} | ${detail}` : message)
  }

  get path(): string {
    return this.file
  }

  private write(level: string, message: string): void {
    try {
      this.rotate()
      appendFileSync(this.file, `${new Date().toISOString()} ${level} ${redact(message)}\n`, { mode: 0o600 })
    } catch {
      // Logging must never crash the application.
    }
  }

  private rotate(): void {
    if (!existsSync(this.file) || statSync(this.file).size < MAX_BYTES) return
    rmSync(`${this.file}.${KEEP_FILES}`, { force: true })
    for (let i = KEEP_FILES - 1; i >= 1; i -= 1) {
      if (existsSync(`${this.file}.${i}`)) renameSync(`${this.file}.${i}`, `${this.file}.${i + 1}`)
    }
    renameSync(this.file, `${this.file}.1`)
  }
}
