/**
 * A one-line summary of a thrown value, for the first line of a failure
 * message whose thrower carries the value itself as the new error's cause.
 *
 * An `Error` is summarized by its message. A page exception does not arrive as
 * an `Error`: the browser protocol reports it as a detail record, and the
 * `exception.description` inside that record holds what the page would have
 * printed — the error's name, its message, and its stack. Its first line is
 * the name and the message, which is the summary wanted here.
 *
 * Anything else points at the cause, which Deno prints below the message.
 * Stringifying such a value here would put "[object Object]" in its place.
 */
export function describeThrown(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null) {
    const description = (error as { exception?: { description?: unknown } })
      .exception?.description;
    if (typeof description === "string" && description.length > 0) {
      return description.split("\n")[0];
    }
  }
  return "see the value reported as the cause below";
}
