/// <cts-enable />
import { equals, lift, NAME, pattern, UI, Writable } from "commontools";

/**
 * Type for pieces used in the mentionable/backlinks system.
 *
 * Note: While `mentioned` and `backlinks` are typed as required for structural
 * compatibility, at runtime most pieces don't actually have these fields.
 * Only patterns like notes and calendar events define them. The computeIndex
 * function safely handles pieces that lack these fields.
 */
export type MentionablePiece = {
  [NAME]?: string;
  isHidden?: boolean;
  isMentionable?: boolean;
  mentioned?: MentionablePiece[];
  backlinks?: MentionablePiece[];
  mentionable?: MentionablePiece[] | { get?: () => MentionablePiece[] };
};

export type WritableBacklinks = {
  mentioned?: WritableBacklinks[];
  backlinks?: Writable<WritableBacklinks[]>;
};

type Input = {
  allPieces: MentionablePiece[];
};

type Output = {
  mentionable: MentionablePiece[];
};

const computeIndex = lift<
  { allPieces: WritableBacklinks[] | undefined },
  void
>(
  ({ allPieces }) => {
    const cs = allPieces ?? [];

    // Reset backlinks for pieces that support it.
    // Many pieces don't have backlinks (e.g., auth pieces, google patterns),
    // so we safely skip them with optional chaining.
    // Also skip undefined/null entries that may exist in the array.
    for (const c of cs) {
      if (!c) continue;
      c.backlinks?.set?.([]);
    }

    // Populate backlinks from mentioned references.
    // Again, use optional chaining since not all pieces support backlinks.
    for (const c of cs) {
      if (!c) continue;
      const mentions = c.mentioned ?? [];
      for (const m of mentions) {
        m?.backlinks?.push?.(c);
      }
    }
  },
);

/**
 * BacklinksIndex builds a map of backlinks across all pieces and exposes a
 * unified mentionable list for consumers like editors.
 *
 * Behavior:
 * - Backlinks are computed by scanning each piece's `mentioned` list and
 *   mapping mention target -> list of source pieces.
 * - Mentionable list is a union of:
 *   - every piece in `allPieces`
 *   - any items a piece exports via a `mentionable` property
 *     (either an array of pieces or a Cell of such an array)
 *
 * The backlinks map is keyed by a piece's `content` value (falling back to
 * its `[NAME]`). This mirrors how existing note patterns identify notes when
 * computing backlinks locally.
 */
const computeMentionable = lift<
  { allPieces: MentionablePiece[] },
  MentionablePiece[]
>(({ allPieces: pieceList }) => {
  const cs = pieceList ?? [];
  const out: MentionablePiece[] = [];
  for (const c of cs) {
    // Skip undefined/null entries that may exist in the array
    if (!c) continue;
    // Skip pieces explicitly marked as not mentionable (like note-md viewer pieces)
    // Note: We check isMentionable === false, not isHidden, because notes in
    // notebooks are hidden but should still be mentionable
    if (c.isMentionable === false) continue;
    out.push(c);
    const exported = c.mentionable;
    if (Array.isArray(exported)) {
      for (const m of exported) if (m && m.isMentionable !== false) out.push(m);
    } else if (exported && typeof (exported as any).get === "function") {
      const arr = (exported as { get: () => MentionablePiece[] }).get() ??
        [];
      for (const m of arr) if (m && m.isMentionable !== false) out.push(m);
    }
  }
  // Deduplicate using equals()
  return out.filter(
    (item, index) => out.findIndex((other) => equals(item, other)) === index,
  );
});

const BacklinksIndex = pattern<Input, Output>(({ allPieces }) => {
  computeIndex({ allPieces } as { allPieces: WritableBacklinks[] });

  // Compute mentionable list from allPieces reactively
  const mentionable = computeMentionable({ allPieces });

  return {
    [NAME]: "BacklinksIndex",
    [UI]: undefined,
    mentionable,
  };
});

export default BacklinksIndex;
