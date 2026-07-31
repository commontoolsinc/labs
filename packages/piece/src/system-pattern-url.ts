import type { MemorySpace } from "@commonfabric/runner";
import type { Runtime } from "@commonfabric/runner";
import {
  resolveSystemPatternSource,
  systemPatternSource,
} from "@commonfabric/runner";

// System space-root patterns, served as raw TSX by the toolshed patterns route
// and addressed by `system:` ref (see the runner's pattern-source.ts for why
// the scheme, rather than the route path it expands to, is what a piece
// stores). Shared by PiecesController (boot-path reconciliation) and
// PieceManager (the default-root heal-on-load-failure retry) — a home of its
// own so the manager does not import the controller that wraps it.
export const HOME_PATTERN_SOURCE = systemPatternSource("system/home.tsx");
export const DEFAULT_APP_PATTERN_SOURCE = systemPatternSource(
  "system/default-app.tsx",
);

/**
 * The official system space-root pattern ref for a space type — the home DID
 * gets home.tsx, every other space gets the default app. This derivation only
 * selects the identity to check; it never proves that a sourceless root tracks
 * that ref. Exact equality with the official content identity supplies
 * that proof at the check site.
 */
export function deriveSystemPatternSource(
  space: MemorySpace,
  runtime: Runtime,
): string {
  return space === runtime.userIdentityDID
    ? HOME_PATTERN_SOURCE
    : DEFAULT_APP_PATTERN_SOURCE;
}

/**
 * Resolve a stored pattern source to the URL to fetch it from, against `base`.
 * A `system:` ref expands to its patterns route; anything else (a custom
 * `defaultAppUrl`) is resolved as the URL it already is. The caller chooses the
 * base, because which host serves a space is its decision to make.
 */
export function patternSourceUrl(source: string, base: string | URL): URL {
  return new URL(resolveSystemPatternSource(source) ?? source, base);
}
