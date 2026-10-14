/**
 * Content-Security-Policy for the renderer. The production policy allows only
 * bundled resources: no remote scripts, no eval, no remote connections.
 * `style-src 'unsafe-inline'` is required because charting and Radix
 * primitives set inline style attributes; scripts stay strictly 'self'.
 */
export function buildContentSecurityPolicy(mode: 'development' | 'production'): string {
  const dev = mode === 'development'
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': dev ? ["'self'", "'unsafe-inline'"] : ["'self'"],
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': ["'self'", 'data:'],
    'font-src': ["'self'", 'data:'],
    'connect-src': dev ? ["'self'", 'ws://localhost:*', 'http://localhost:*'] : ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-src': ["'none'"],
    'worker-src': ["'self'"]
  }
  return Object.entries(directives)
    .map(([key, values]) => `${key} ${values.join(' ')}`)
    .join('; ')
}

/** Policy for generated report pages: no scripts at all. */
export const REPORT_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'"
