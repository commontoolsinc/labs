/// <cts-enable />
import { lift, NAME, pattern, UI, Writable } from "commontools";

export type MentionableCharm = {
  [NAME]?: string;
  isHidden?: boolean;
  isMentionable?: boolean;
  mentioned: MentionableCharm[];
  backlinks: MentionableCharm[];
  mentionable?: MentionableCharm[] | { get?: () => MentionableCharm[] };
};

export type WriteableBacklinks = {
  mentioned: WriteableBacklinks[];
  backlinks: Writable<WriteableBacklinks[]>;
};

type Input = {
  allCharms: MentionableCharm[];
};

type Output = {
  mentionable: MentionableCharm[];
};

const computeIndex = lift<
  { allCharms: WriteableBacklinks[] },
  void
>(
  ({ allCharms }) => {
    const cs = allCharms ?? [];

    for (const c of cs) {
      c.backlinks?.set([]);
    }

    for (const c of cs) {
      const mentions = c.mentioned ?? [];
      for (const m of mentions) {
        m?.backlinks?.push(c);
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
  computeIndex({
    allCharms,
  });

  // Compute mentionable list from allCharms reactively
  const mentionable = computeMentionable({ allCharms });

  return {
    [NAME]: "BacklinksIndex",
    [UI]: undefined,
    mentionable,
  };
});

export default BacklinksIndex;
