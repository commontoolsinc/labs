/**
 * Ambient switch for reader-precedence link-schema combination
 * (`combineSchemaForLink` in traverse.ts): ON by default; an explicit
 * `false` restores the strict pseudo-intersection at link crossings.
 *
 * Plain last-write-wins module state, like the other experimental flags'
 * ambient configs: each Runtime construction sets it from its resolved
 * option, and dispose resets the default. A test process can therefore
 * construct successive runtimes with different flag states; a real server
 * constructs one posture and never changes it mid-flight.
 */

let readerSchemaPrecedenceEnabled = true;

export function setReaderSchemaPrecedenceConfig(value?: boolean): void {
  readerSchemaPrecedenceEnabled = value ?? true;
}

export function getReaderSchemaPrecedenceConfig(): boolean {
  return readerSchemaPrecedenceEnabled;
}

export function resetReaderSchemaPrecedenceConfig(): void {
  readerSchemaPrecedenceEnabled = true;
}
