/// <cts-enable />
import {
  Cell,
  Default,
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
  allCharms: Cell<MentionableCharm[]>;
};

export type BacklinksMap = { [charmId: string]: MentionableCharm[] };

type Output = {
  backlinks: BacklinksMap;
  mentionable: Cell<MentionableCharm[]>;
};

/**
 * BacklinksIndex builds a map of backlinks across all charms and exposes the
 * mentionable list for consumers like editors. The map is keyed by a
 * charm's content value. This mirrors how existing note patterns identify
 * notes when computing backlinks locally.
 */
const BacklinksIndex = recipe<Input, Output>(
  "BacklinksIndex",
  ({ allCharms }) => {
    const computeIndex = lift<{ allCharms: Cell<MentionableCharm[]> }, BacklinksMap>(
      ({ allCharms }) => {
        const cs = allCharms.get() ?? [];
        const index: BacklinksMap = {};

        for (const c of cs) {
          const mentions = c.mentioned ?? [];
          for (const m of mentions) {
            const key = m?.content ?? m?.[NAME];
            if (!key) continue;
            if (!index[key]) index[key] = [];
            index[key].push(c);
          }
        }

        return index;
      },
    );

    const backlinks: OpaqueRef<BacklinksMap> = computeIndex({ allCharms });

    return {
      [NAME]: "BacklinksIndex",
      [UI]: undefined,
      backlinks,
      mentionable: allCharms,
    };
  },
);

export default BacklinksIndex;

