import type { FabricInstance } from "@commonfabric/data-model/fabric-value";

/**
 * Builds the refusal a `FabricInstance` gets from a walk that cannot yet
 * descend one. Such a value is a container reached by its codec contents
 * rather than by property name, and it has no enumerable own properties, so a
 * walk that rebuilt it from its entries would yield a bare `{}` and lose
 * whatever it holds -- including any cell nested inside it.
 *
 * The sibling `FabricPrimitive` needs no such treatment: it is a leaf, so a
 * walk that stops at it has already done the right thing.
 *
 * "Flag-gated tripwires" in `docs/development/EXPERIMENTAL_OPTIONS.md` governs
 * these refusals, including the obligation on each caller to say whether
 * nothing reaches it by construction or merely de facto.
 *
 * @param value The instance being refused.
 * @param situation A phrase completing "Cannot yet handle X (a
 *   `FabricInstance`) ...", naming what the walk was doing -- for example
 *   `"when converting cells to links"`.
 * @returns The error to throw.
 */
export function refuseFabricInstance(
  value: FabricInstance,
  situation: string,
): Error {
  return new Error(
    `Cannot yet handle \`${value.constructor.name}\` (a \`FabricInstance\`) ` +
      `${situation}.`,
  );
}
