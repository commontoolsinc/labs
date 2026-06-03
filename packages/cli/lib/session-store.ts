/**
 * Persistent store for pinned memory session tokens.
 *
 * When a user opts in to session pinning (via `--session <id>` / `CF_SESSION`),
 * the server rotates the `sessionToken` on every mount and rejects reuse of a
 * still-live `sessionId` that arrives without the matching token
 * (`revokedError`). To make pinning work across separate `cf` invocations we
 * persist the rotated token here, keyed by `${space}:${sessionId}`, and replay
 * it on the next command.
 *
 * The store is best-effort: a missing or corrupt file is treated as empty, and
 * write failures are swallowed (pinning degrades to "fresh session" rather than
 * crashing the command).
 */

function sessionsFilePath(): string | undefined {
  const home = Deno.env.get("HOME");
  if (!home) return undefined;
  return `${home}/.cache/common-fabric/cli-sessions.json`;
}

function keyFor(space: string, sessionId: string): string {
  return `${space}:${sessionId}`;
}

function readStore(): Record<string, string> {
  const path = sessionsFilePath();
  if (!path) return {};
  try {
    const text = Deno.readTextFileSync(path);
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") {
      return parsed as Record<string, string>;
    }
    return {};
  } catch {
    // Missing or corrupt file -> treat as empty.
    return {};
  }
}

function writeStore(store: Record<string, string>): void {
  const path = sessionsFilePath();
  if (!path) return;
  try {
    const dir = path.slice(0, path.lastIndexOf("/"));
    Deno.mkdirSync(dir, { recursive: true });
    Deno.writeTextFileSync(path, JSON.stringify(store, null, 2));
  } catch {
    // Best-effort: ignore write failures.
  }
}

/** Returns the persisted rotated session token, if any. */
export function getSessionToken(
  space: string,
  sessionId: string,
): string | undefined {
  const store = readStore();
  return store[keyFor(space, sessionId)];
}

/**
 * Persists (or, with `undefined`, clears) the rotated session token for a
 * pinned session.
 */
export function setSessionToken(
  space: string,
  sessionId: string,
  token: string | undefined,
): void {
  const store = readStore();
  const key = keyFor(space, sessionId);
  if (token === undefined) {
    if (!(key in store)) return;
    delete store[key];
  } else {
    if (store[key] === token) return;
    store[key] = token;
  }
  writeStore(store);
}
