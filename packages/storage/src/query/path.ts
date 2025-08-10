// RFC6901 escape helpers
export function esc(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}
export function unesc(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

// Convert JSON Pointer string → tokens (preserve empty tokens). "" => []
export function toTokens(ptr: string): string[] {
  if (ptr === "") return [];
  if (ptr[0] !== "/") throw new Error("Invalid JSON Pointer");
  return ptr.slice(1).split("/").map(unesc);
}

// Convert tokens → JSON Pointer string. [] => ""
export function fromTokens(tokens: string[]): string {
  if (tokens.length === 0) return "";
  return "/" + tokens.map(esc).join("/");
}

// Path key for Maps/Sets
export function keyPath(tokens: string[]): string {
  return JSON.stringify(tokens);
}

// Build child path (immutable)
export function child(tokens: string[], seg: string): string[] {
  const out = tokens.slice();
  out.push(seg);
  return out;
}

// Ancestor check by tokens
export function isAncestorPath(parent: string[], childPath: string[]): boolean {
  if (parent.length > childPath.length) return false;
  for (let i = 0; i < parent.length; i++) {
    if (parent[i] !== childPath[i]) return false;
  }
  return true; // equal => same node; shorter => ancestor
}
