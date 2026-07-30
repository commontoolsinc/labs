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

import { paragraphs } from "./markup.ts";
import { BANDS, CLAIMS, FIGURE, LAYERS, TIERS, WHY, WHY3 } from "./content.ts";

/** The open-question mark. Lives here because anchors label with it too. */
export const FLAG = "⚑";

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

/** A comment as the Discussion tab lists it: joined to where it hangs off. */
export interface ThreadRow {
  anchor: string;
  tab: string;
  label: string;
  body: string;
  author: unknown;
}

/**
 * Join every comment to its anchor's label and tab in ONE pass, so the tab
 * needs no per-row lookup. Order is the array's append order and is never
 * touched — the newest-first reading is done with CSS.
 */
export const threadRows = (items: readonly Comment[]): ThreadRow[] =>
  items.map((c) => ({
    anchor: c.anchor,
    tab: ANCHOR_TAB[c.anchor] ?? "ledger",
    label: ANCHOR_LABEL[c.anchor] ?? "a place that has since been reworded",
    body: c.body,
    author: c.author,
  }));

export interface Anchor {
  key: string;
  /** Which tab holds it, so the Discussion tab can link back. */
  tab: string;
  /** Short human name for a thread list. */
  label: string;
  /** The referent text shown above the thread. */
  text: string;
}

/** Prose is stored as markup; an anchor's referent shows it as plain text. */
const plain = (markup: string): string => (markup ?? "").split("**").join("");

/**
 * A record's anchor IS its stable id. Ids are minted once in content.ts and
 * never derived from the text, so renaming a concern keeps its thread — which
 * is the whole reason they exist now that the text is editable.
 *
 * Two exceptions, both because they are not records: a row's open question
 * shares the row's id and so takes a prefix, and the Why essay and the map are
 * singletons with fixed keys.
 */
export const questionKey = (rowId: string): string => "q_" + rowId;

export const WHY_ESSAY = "wh_essay";
export const WHY_MAP = "wh_map";

const concernAnchors = (): Anchor[] =>
  BANDS.flatMap((b) =>
    b.domains.flatMap((d) =>
      d.rows.flatMap((r) => {
        const self = [{
          key: r.id,
          tab: "ledger",
          label: r.name,
          text: r.tip ?? r.name,
        }];
        return r.flag
          ? self.concat([{
            key: questionKey(r.id),
            tab: "ledger",
            label: r.name + " " + FLAG,
            text: r.flag,
          }])
          : self;
      })
    )
  );

const layerChipAnchors = (): Anchor[] =>
  LAYERS.flatMap((l) =>
    l.chips.map((c) => ({
      key: c.id,
      tab: "orient",
      label: c.label,
      text: c.tip,
    }))
  );

const tierChipAnchors = (): Anchor[] =>
  TIERS.flatMap((t) =>
    t.groups.flatMap((g) =>
      g.chips.map((c) => ({
        key: c.id,
        tab: "reach",
        label: c.label,
        text: c.tip,
      }))
    )
  );

// The whole essay and the map are each one thing to argue with; splitting the
// prose per paragraph would be an arbitrary cut.
const whyAnchors = (): Anchor[] => [
  {
    key: WHY_ESSAY,
    tab: "why",
    label: WHY.title,
    text: paragraphs(WHY.body)[0] ?? WHY.title,
  },
  {
    key: WHY_MAP,
    tab: "why",
    label: "The mappa mundi",
    text: FIGURE.caption,
  },
];

const claimAnchors = (): Anchor[] =>
  CLAIMS.map((c) => ({
    key: c.id,
    tab: "claims",
    label: c.name,
    text: c.lede,
  }));

const why3Anchors = (): Anchor[] =>
  WHY3.map((w) => ({
    key: w.id,
    tab: "orient",
    label: w.key,
    text: plain(w.body),
  }));

const layerAnchors = (): Anchor[] =>
  LAYERS.map((l) => ({
    key: l.id,
    tab: "orient",
    label: l.name + " " + l.tag,
    text: plain(l.what),
  }));

const tierAnchors = (): Anchor[] =>
  TIERS.map((t) => ({
    key: t.id,
    tab: "reach",
    label: t.tname,
    text: t.tline,
  }));

const allAnchors = (): Anchor[] =>
  whyAnchors()
    .concat(claimAnchors())
    .concat(why3Anchors())
    .concat(layerAnchors())
    .concat(concernAnchors())
    .concat(tierAnchors())
    .concat(layerChipAnchors())
    .concat(tierChipAnchors());

/** Every anchor, in a deterministic order. */
export const ANCHORS: Anchor[] = allAnchors();

const keySet = (): Set<string> => new Set(ANCHORS.map((a) => a.key));

/** Which anchors exist, so a thread on reworded content can be dropped. */
export const ANCHOR_KEYS: Set<string> = keySet();

const textOf = (): Record<string, string> =>
  Object.fromEntries(ANCHORS.map((a) => [a.key, a.text]));

/** Anchor key to the referent text the panel shows above the thread. */
export const ANCHOR_TEXT: Record<string, string> = textOf();

const labelOf = (): Record<string, string> =>
  Object.fromEntries(ANCHORS.map((a) => [a.key, a.label]));

const tabOf = (): Record<string, string> =>
  Object.fromEntries(ANCHORS.map((a) => [a.key, a.tab]));

/** Anchor key to a short human name, for the Discussion tab's thread list. */
export const ANCHOR_LABEL: Record<string, string> = labelOf();

/** Anchor key to the tab that holds it, so a thread can link back to it. */
export const ANCHOR_TAB: Record<string, string> = tabOf();

const tally = (items: readonly Comment[]): Record<string, number> =>
  items.reduce((acc: Record<string, number>, c) => {
    if (!ANCHOR_KEYS.has(c.anchor)) return acc;
    acc[c.anchor] = (acc[c.anchor] ?? 0) + 1;
    return acc;
  }, {});

/**
 * One reactive value carries every comment count.
 *
 * A count badge per row would otherwise mean a computed on all ~250 anchors.
 * Instead the markers are static markup addressed by `data-a`, and this emits
 * the rules that fill them in — the same move the ledger's sort uses.
 *
 * Only minted ids reach the selector. They match /^[a-z][a-z0-9_]*$/ by
 * construction, so no document text is ever interpolated into CSS; an anchor
 * that no longer exists is dropped rather than emitted.
 */
export const countCss = (items: readonly Comment[]): string => {
  const counts = tally(items);
  return Object.keys(counts)
    .map((k) =>
      '.mm [data-a="' + k + '"] .ccount::after{content:"' + counts[k] + '"}'
    )
    .join("\n");
};
