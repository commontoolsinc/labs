import type { NormalizedFullLink } from "./link-types.ts";

/** Exact normalized cell address that was absent from the current snapshot. */
export type UnavailableCellAddress = Readonly<
  Pick<NormalizedFullLink, "space" | "id" | "scope" | "path">
>;

/** Internal retry sentinel for an asynchronously arriving cell document. */
export class CellDataUnavailableError extends Error {
  readonly address: UnavailableCellAddress;

  constructor(link: NormalizedFullLink) {
    // Preserve the established diagnostic while giving the executor an exact,
    // typed dependency to match against ordered accepted-commit revisions.
    super("No data at cell");
    this.address = Object.freeze({
      space: link.space,
      id: link.id,
      scope: link.scope,
      path: Object.freeze([...link.path]),
    });
  }
}
