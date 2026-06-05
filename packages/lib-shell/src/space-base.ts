import type { DID } from "@commonfabric/identity";

const SPACE_BASE_SELECTOR = 'base[data-commonfabric-space-base="true"]';

export type SpaceBaseHrefOptions = {
  document?: Document;
  hrefForSpace: (space: DID, embedded: boolean) => string;
};

export function createSpaceBaseHrefController(
  options: SpaceBaseHrefOptions,
): (space?: DID, embedded?: boolean) => void {
  const documentRef = options.document ?? globalThis.document;

  return (space?: DID, embedded = false): void => {
    const existing = documentRef.head.querySelector<HTMLBaseElement>(
      SPACE_BASE_SELECTOR,
    );
    if (!space) {
      existing?.remove();
      return;
    }

    const base = existing ?? documentRef.createElement("base");
    base.setAttribute("data-commonfabric-space-base", "true");
    base.href = options.hrefForSpace(space, embedded);
    if (!existing) {
      documentRef.head.prepend(base);
    }
  };
}
