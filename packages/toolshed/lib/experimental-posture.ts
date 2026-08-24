// The experimental-flag posture this server resolved for its own Runtime,
// published on `/api/meta` so a client that is not built alongside it can
// adopt the deployment's flags instead of being configured to match by hand
// (docs/development/EXPERIMENTAL_OPTIONS.md, "Clients that are not built
// alongside their server").
//
// Held here rather than read off the Runtime at request time because the meta
// route is part of the app and the Runtime is constructed by the process that
// serves it: reaching for the instance would make the route import the
// server's entry point. The startup path publishes what the Runtime ACTUALLY
// resolved, so what a client reads is the effective posture — built-in
// defaults and preset resolution included — never a second reading of the
// environment that could disagree with the first.

import type { ExperimentalOptions } from "@commonfabric/runner";

let posture: Record<string, boolean> | null = null;

/**
 * Record a constructed Runtime's resolved flags. Flags the runtime left
 * unresolved are omitted rather than published as `false`: a client reads an
 * absent flag as "this server said nothing", and keeps its own default.
 *
 * Pass `null` to publish nothing, which is also the state before any Runtime
 * exists — a client then sees `experimental: null` and keeps its defaults.
 */
export function publishExperimentalPosture(
  experimental: ExperimentalOptions | null,
): void {
  if (experimental === null) {
    posture = null;
    return;
  }
  posture = Object.fromEntries(
    Object.entries(experimental)
      .filter((entry): entry is [string, boolean] =>
        typeof entry[1] === "boolean"
      )
      .sort(([left], [right]) => left < right ? -1 : 1),
  );
}

/** What `/api/meta` reports; `null` until a Runtime has been constructed. */
export function experimentalPosture(): Record<string, boolean> | null {
  return posture;
}
