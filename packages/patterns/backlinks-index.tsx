/// <cts-enable />
import {
  Cell,
  cell,
  Default,
  derive,
  lift,
  NAME,
  OpaqueRef,
  recipe,
  UI,
} from "commontools";

export type MentionableCharm = {
  [NAME]: string;
  content?: string;
  mentioned?: MentionableCharm[];
};

type Input = {
  allCharms: MentionableCharm[];
};

export type BacklinksMap = { [charmId: string]: MentionableCharm[] };

type Output = {
  backlinks: BacklinksMap;
  mentionable: MentionableCharm[];
};

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
const BacklinksIndex = recipe<Input, Output>(
  "BacklinksIndex",
  ({ allCharms }) => {
    const computeIndex = lift<
      { allCharms: MentionableCharm[] },
      BacklinksMap
    >(
      ({ allCharms }) => {
        const cs = allCharms ?? [];
        const index: BacklinksMap = {};

        for (const c of cs) {
          const mentions = c.mentioned ?? [];
          for (const m of mentions) {
            const key = m?.content || m?.[NAME];
            if (!key) continue;
            if (!index[key]) index[key] = [];
            index[key].push(c);
          }
        }

        return index;
      },
    );

    const backlinks: OpaqueRef<BacklinksMap> = computeIndex({ allCharms });

    // Compute mentionable list from allCharms via lift, then mirror that into
    // a real Cell for downstream consumers that expect a Cell.
    const computeMentionable = lift<
      { allCharms: any[] },
      MentionableCharm[]
    >(({ allCharms }) => {
      const cs = allCharms ?? [];
      const out: MentionableCharm[] = [];
      for (const c of cs) {
        out.push(c);
        const exported = (c as unknown as {
          mentionable?: MentionableCharm[] | { get?: () => MentionableCharm[] };
        }).mentionable;
        if (Array.isArray(exported)) {
          for (const m of exported) if (m) out.push(m);
        } else if (exported && typeof (exported as any).get === "function") {
          const arr = (exported as { get: () => MentionableCharm[] }).get() ??
            [];
          for (const m of arr) if (m) out.push(m);
        }
      }
      return out;
    });

    return {
      [NAME]: "BacklinksIndex",
      [UI]: undefined,
      backlinks,
      mentionable: computeMentionable({ allCharms }),
    };
  },
);

export default BacklinksIndex;
