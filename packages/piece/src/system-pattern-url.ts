import type { MemorySpace } from "@commonfabric/runner";
import type { Runtime } from "@commonfabric/runner";

// System space-root patterns, served as raw TSX by the toolshed patterns route.
// Shared by PiecesController (boot-path reconciliation) and PieceManager (the
// default-root heal-on-load-failure retry) — a home of its own so the manager
// does not import the controller that wraps it.
export const HOME_PATTERN_URL = "/api/patterns/system/home.tsx";
export const DEFAULT_APP_PATTERN_URL = "/api/patterns/system/default-app.tsx";

/**
 * The official system space-root pattern URL for a space type — the home DID
 * gets home.tsx, every other space gets the default app. This derivation only
 * selects the identity to check; it never proves that a sourceless root tracks
 * that URL. Exact equality with the official content identity supplies
 * that proof at the check site.
 */
export function deriveSystemPatternUrl(
  space: MemorySpace,
  runtime: Runtime,
): string {
  return space === runtime.userIdentityDID
    ? HOME_PATTERN_URL
    : DEFAULT_APP_PATTERN_URL;
}
