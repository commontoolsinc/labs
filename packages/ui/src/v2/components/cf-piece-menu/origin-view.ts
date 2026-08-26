/**
 * How a piece's recorded source facts read to a person.
 *
 * The origin kinds these describe are defined by
 * `docs/specs/piece-source-lifecycle.md`; the runtime classifies a piece's
 * recorded source into one of them and the panel names it.
 */

import type { PieceOriginView } from "@commonfabric/runtime-client";

export interface OriginDescription {
  /** Short label naming the kind of origin. */
  label: string;

  /** One sentence on what that origin can do. */
  detail: string;
}

/** How an origin reads to a person, including the detached case. */
export function describeOrigin(
  origin: PieceOriginView | undefined,
): OriginDescription {
  if (origin === undefined) {
    return {
      label: "Detached",
      detail: "This piece records no origin, so nothing supplies new code " +
        "for it. It is the only durable reference to the source it runs.",
    };
  }
  switch (origin.kind) {
    case "web":
      return {
        label: "External web URL",
        detail: "A program endpoint that can return new source later.",
      };
    case "fabric-piece":
      return {
        label: "Fabric piece",
        detail: "A stable piece in the fabric; the origin names whichever " +
          "pattern that piece currently runs.",
      };
    case "fabric-pattern":
      return {
        label: "Exact pattern",
        detail: "Content-addressed source: this origin always resolves to " +
          "the same code.",
      };
  }
}

/** A content identity abbreviated for display; the full value stays in a title. */
export function shortIdentity(identity: string): string {
  return identity.length > 14 ? `${identity.slice(0, 12)}…` : identity;
}

/** A recorded timestamp as a readable local time. */
export function formatTimestamp(ms: number): string {
  return new Date(ms).toLocaleString();
}
