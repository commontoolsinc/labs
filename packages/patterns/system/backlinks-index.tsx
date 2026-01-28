/// <cts-enable />
import { lift, NAME, pattern, UI, Writable } from "commontools";

/**
 * Type for charms used in the mentionable/backlinks system.
 *
 * Note: While `mentioned` and `backlinks` are typed as required for structural
 * compatibility, at runtime most charms don't actually have these fields.
 * Only patterns like notes and calendar events define them. The computeIndex
 * function safely handles charms that lack these fields.
 */
export type MentionableCharm = {
  [NAME]?: string;
  isHidden?: boolean;
  isMentionable?: boolean;
  mentioned?: MentionableCharm[];
  backlinks?: MentionableCharm[];
  mentionable?: MentionableCharm[] | { get?: () => MentionableCharm[] };
};

export type WritableBacklinks = {
  mentioned?: WritableBacklinks[];
  backlinks?: Writable<WritableBacklinks[]>;
};

type Input = {
  allCharms: MentionableCharm[];
};

type Output = {
  mentionable: MentionableCharm[];
};

const computeIndex = lift<
  { allCharms: WritableBacklinks[] | undefined },
  void
>(
  ({ allCharms }) => {
    const cs = allCharms ?? [];

    // Reset backlinks for charms that support it.
    // Many charms don't have backlinks (e.g., auth charms, google patterns),
    // so we safely skip them with optional chaining.
    // Also skip undefined/null entries that may exist in the array.
    for (const c of cs) {
      if (!c) continue;
      c.backlinks?.set?.([]);
    }

    // Populate backlinks from mentioned references.
    // Again, use optional chaining since not all charms support backlinks.
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
 * BacklinksIndex builds a map of backlinks across all charms and exposes a
 * unified mentionable list for consumers like editors.
 *
 * Behavior:
 * - Backlinks are computed by scanning each charm's `mentioned` list and
 *   mapping mention target -> list of source charms.
 * - Mentionable list is a union of:
 *   - every charm in `allCharms`
 *   - any items a charm exports via a `mentionable` property
 *     (either an array of charms or a Cell of such an array)
 *
 * The backlinks map is keyed by a charm's `content` value (falling back to
 * its `[NAME]`). This mirrors how existing note patterns identify notes when
 * computing backlinks locally.
 */
const computeMentionable = lift<
  { allCharms: MentionableCharm[] },
  MentionableCharm[]
>(({ allCharms: charmList }) => {
  const cs = charmList ?? [];
  const out: MentionableCharm[] = [];
  for (const c of cs) {
    // Skip undefined/null entries that may exist in the array
    if (!c) continue;
    // Skip charms explicitly marked as not mentionable (like note-md viewer charms)
    // Note: We check isMentionable === false, not isHidden, because notes in
    // notebooks are hidden but should still be mentionable
    if (c.isMentionable === false) continue;
    out.push(c);
    const exported = c.mentionable;
    if (Array.isArray(exported)) {
      for (const m of exported) if (m && m.isMentionable !== false) out.push(m);
    } else if (exported && typeof (exported as any).get === "function") {
      const arr = (exported as { get: () => MentionableCharm[] }).get() ??
        [];
      for (const m of arr) if (m && m.isMentionable !== false) out.push(m);
    }
  }
  return out;
});

const BacklinksIndex = pattern<Input, Output>(({ allCharms }) => {
  computeIndex({ allCharms } as { allCharms: WritableBacklinks[] });

  // Compute mentionable list from allCharms reactively
  const mentionable = computeMentionable({ allCharms });

  return {
    [NAME]: "BacklinksIndex",
    [UI]: undefined,
    mentionable,
  };
});

export default BacklinksIndex;
