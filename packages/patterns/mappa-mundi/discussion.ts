// Comments anchored to places in the map.
//
// Every commentable thing gets a stable key derived from the document's own
// text — no minted ids, so the same concern resolves to the same thread in any
// session. The trade is that rewording a concern orphans its thread;
// discussion.test.ts pins the keys so that can't happen silently.
//
// Four kinds, because a flagged concern and its open question are genuinely
// different topics — the flag is labelled "an open question to interrogate",
// which is exactly the thing people will want to argue about:
//
//   cn|band|domain|name   the concern itself
//   cq|band|domain|name   its open question (flagged rows only)
//   lc|layer|label        a chip on one of the three layers
//   tc|tier|group|label   a chip in the Loom prototype tiers
//
// Anything that already opens the referent sheet gets a thread; the five
// promises do not open it, so they are out of scope for now.

import { BANDS, LAYERS, TIERS } from "./content.ts";

export interface Comment {
  /** Which place in the map this hangs off. */
  anchor: string;
  /**
   * The author's live profile cell. Deliberately no name snapshot: a snapshot
   * goes stale when someone renames, and cf-profile-badge already degrades to
   * "Unknown profile" when the cell cannot be resolved.
   */
  author: unknown;
  body: string;
  /**
   * The poster's clock at post time, coarsened to one second by the sandbox.
   * DISPLAY ONLY — it is not comparable across authors (there is no shared
   * clock, and the commit-time Lamport seq is not pattern-visible), so
   * ordering comes from the array's append order and never from this.
   */
  stampedAt: number;
}

export interface Discussion {
  items: Comment[];
}

/**
 * The comment as a reader outside the pattern sees it. The live `author` cell
 * does not survive the flat `.get()` snapshot, so it is typed out rather than
 * promised — `cf piece get discussion` returns anchor, body and stamp.
 */
export type CommentView = Omit<Comment, "author">;

export interface DiscussionView {
  items: CommentView[];
}

export interface Anchor {
  key: string;
  /** The referent text shown above the thread. */
  text: string;
}

// The key builders are exported and used both to build the registry below and
// to stamp the render-time view models, so the two cannot drift apart.
export const concernKey = (
  band: string,
  domain: string,
  name: string,
): string => "cn|" + band + "|" + domain + "|" + name;

export const questionKey = (
  band: string,
  domain: string,
  name: string,
): string => "cq|" + band + "|" + domain + "|" + name;

// Chips take a prefix rather than a key builder: the transformer rejects a
// callback passed as an argument into pattern-facing JSX, so the render site
// concatenates prefix + label itself.
export const layerChipPrefix = (tone: string): string => "lc|" + tone + "|";

export const tierChipPrefix = (tier: string, group: string): string =>
  "tc|" + tier + "|" + group + "|";

export const layerChipKey = (tone: string, label: string): string =>
  layerChipPrefix(tone) + label;

export const tierChipKey = (
  tier: string,
  group: string,
  label: string,
): string => tierChipPrefix(tier, group) + label;

const concernAnchors = (): Anchor[] =>
  BANDS.flatMap((b) =>
    b.domains.flatMap((d) =>
      d.rows.flatMap((r) => {
        const self = [{
          key: concernKey(b.title, d.title, r.name),
          text: r.tip ?? r.name,
        }];
        return r.flag
          ? self.concat([{
            key: questionKey(b.title, d.title, r.name),
            text: r.flag,
          }])
          : self;
      })
    )
  );

const layerChipAnchors = (): Anchor[] =>
  LAYERS.flatMap((l) =>
    l.chips.map((c) => ({ key: layerChipKey(l.tone, c.label), text: c.tip }))
  );

const tierChipAnchors = (): Anchor[] =>
  TIERS.flatMap((t) =>
    t.groups.flatMap((g) =>
      g.chips.map((c) => ({
        key: tierChipKey(t.tname, g.label, c.label),
        text: c.tip,
      }))
    )
  );

const allAnchors = (): Anchor[] =>
  concernAnchors().concat(layerChipAnchors()).concat(tierChipAnchors());

/** Every anchor, in a deterministic order. Position is the CSS-side id. */
export const ANCHORS: Anchor[] = allAnchors();

const indexOf = (): Record<string, number> =>
  Object.fromEntries(ANCHORS.map((a, i) => [a.key, i]));

/**
 * Anchor key to its position. Rendered into `data-a`, so the per-anchor
 * comment-count CSS can address a row by a plain number and never has to
 * interpolate document text into a selector.
 */
export const ANCHOR_INDEX: Record<string, number> = indexOf();

const textOf = (): Record<string, string> =>
  Object.fromEntries(ANCHORS.map((a) => [a.key, a.text]));

/** Anchor key to the referent text the sheet shows above the thread. */
export const ANCHOR_TEXT: Record<string, string> = textOf();

const tally = (items: readonly Comment[]): Record<number, number> =>
  items.reduce((acc: Record<number, number>, c) => {
    const i = ANCHOR_INDEX[c.anchor];
    if (i === undefined) return acc;
    acc[i] = (acc[i] ?? 0) + 1;
    return acc;
  }, {});

/**
 * One reactive value carries every comment count.
 *
 * A count badge per row would otherwise mean a computed on all ~200 anchors.
 * Instead the markers are static markup addressed by `data-a`, and this emits
 * the rules that fill them in — the same move the ledger's sort uses. Only
 * numbers reach the selector, so no document text is ever interpolated into
 * CSS.
 */
export const countCss = (items: readonly Comment[]): string => {
  const counts = tally(items);
  return Object.keys(counts)
    .map((i) =>
      '.mm [data-a="' + i + '"] .ccount::after{content:"' + counts[Number(i)] +
      '"}'
    )
    .join("\n");
};
