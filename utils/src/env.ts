export function isDeno(): boolean {
  return ("Deno" in globalThis);
}

export function isBrowser(): boolean {
  return !isDeno() && ("document" in globalThis);
}
