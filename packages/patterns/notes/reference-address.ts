import { Writable } from "commonfabric";
import { type MentionRefMap } from "./schemas.tsx";

/** The shape `getAsNormalizedFullLink()` returns, as much of it as is used. */
interface NormalizedLink {
  id?: string;
  path?: readonly PropertyKey[];
  space?: string;
  scope?: string;
}

/**
 * A resolved cell's address, in the form `cf-markdown` turns into a cell link.
 *
 * This mirrors `createLLMFriendlyLink` (`packages/runner/src/link-types.ts`),
 * which a pattern cannot import. Reproducing it rather than using the id alone
 * is what keeps a destination that is a nested cell, or one in another space,
 * addressable: an id on its own names the document root in the reader's own
 * space, which for those destinations is a different cell than the one meant.
 * Segments are escaped per RFC 6901, as `encodeJsonPointer` does.
 */
export const linkAddress = (
  link: NormalizedLink,
  contextSpace: string | undefined,
): string | undefined => {
  if (!link.id) return undefined;

  const id = link.scope && link.scope !== "space"
    ? `${link.id}@${link.scope}`
    : link.id;
  const segments = contextSpace && link.space && link.space !== contextSpace
    ? [`@${link.space}`, id, ...(link.path ?? [])]
    : [id, ...(link.path ?? [])];

  return `/${
    segments
      .map((segment) =>
        String(segment).replace(/~/g, "~0").replace(/\//g, "~1")
      )
      .join("/")
  }`;
};

/**
 * Every reference key the map resolves, paired with its destination's address.
 *
 * The scheme comes from the destination rather than being prepended. A
 * wiki-link's embedded id is bare and provably `of:`, because the embed format
 * rejects every other scheme, so the renderer can put `of:` back. A
 * reference's destination is a cell carrying whatever scheme it has, and
 * assuming `of:` for it would address a different entity than the one meant.
 *
 * `resolveAsCell` and `getAsNormalizedFullLink` are cell-runtime surface
 * rather than the pattern Writable type, hence the casts — the same one notes'
 * `appendLink` makes.
 */
export const referenceAddresses = (
  references: Writable<MentionRefMap> | undefined,
): Record<string, string> => {
  const addresses: Record<string, string> = {};
  // `.get()` here is also what subscribes the caller to the map, which is why
  // this runs in the computed's own body rather than inside the replacement
  // callback below it: a read from a nested callback resolves the address
  // correctly and registers no dependency, so the rendered content would be
  // right once and then never again.
  const map = references?.get?.();
  if (!map) return addresses;

  // The space the note itself lives in. A destination in the same space is
  // addressed without one, which is what every mention made today looks like.
  const contextSpace: string | undefined = (references as any)
    ?.getAsNormalizedFullLink?.()?.space;

  for (const key of Object.keys(map)) {
    // `destination` is typed unknown and so reads back as a reference
    // carrying nothing, but the ENTRY still materializes — `modifiedTitle` is
    // a boolean — and the address comes from the path to the destination, not
    // from its value.
    const destination = (references as any).key(key).key("destination");
    const link: NormalizedLink | undefined = destination?.resolveAsCell?.()
      ?.getAsNormalizedFullLink?.();
    const address = link ? linkAddress(link, contextSpace) : undefined;
    if (address) addresses[key] = address;
  }

  return addresses;
};
