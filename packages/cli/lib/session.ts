/**
 * Mint a session id: the caller identity that an invocation id is chosen
 * within.
 *
 * `cf piece call --invocation <id>` lets a caller name a dispatch so that a
 * retry settles on the original outcome instead of executing the verb again.
 * The id is the caller's own word — `add-comment-1` — and nothing stops a
 * second caller from picking that same word for its own call on the same verb.
 * The id alone therefore does not say whose invocation it is. A session is
 * what tells the two callers apart.
 *
 * The id is a bare unguessable string. There is no format to parse and no key
 * material to store — a session signs nothing and authenticates nobody, so
 * giving it a keyfile shape would only invite storing and handling it as if it
 * did. Mint one per agent run, carry it in `CF_SESSION` (or `--session`), and
 * let every call of that run share it: one run is exactly the span over which
 * repeating an id should mean repeating a call.
 *
 * The session travels with the call today; the address a handling's receipt
 * lands at is derived from the invocation id alone and does not join it yet.
 */
export function newSessionId(): string {
  return crypto.randomUUID();
}
