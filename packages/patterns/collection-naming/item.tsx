/**
 * The exemplar member of a named collection: a title, a body, a filing time,
 * and the name its board calls it by. The name is not the item's to hold — it
 * lives in the board's namespace — so the item reads its own row out of the
 * board's names table by identity, and an item no board has named shows no
 * name and needs nothing else. The body is edited through `cf-code-editor`,
 * which completes `#42` over the board's mention universe and mints a
 * reference-form mention into the item's own map. The prose and that map are
 * drafted per session and written together by one save, because a body is a
 * single string with whole-value conflict semantics and a live-bound editor on
 * one would conflict per keystroke.
 */

import {
  action,
  Default,
  NAME,
  pattern,
  type ReadonlyCell,
  SELF,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

import { type NamesTableRow, ownName } from "./naming.ts";

/**
 * What the body editor's mention autocomplete needs of a universe entry: the
 * display name it lists and matches on, the title, and the board's name for
 * the member as `shortName`, which is what a `#42` query matches.
 *
 * These three are deliberately the WHOLE demand. A board's universe row
 * carries its item as a `piece` reference besides them, and leaving that out
 * of this projection is what keeps every walk under an item's argument out of
 * the sibling items: a property the declared demand does not select is
 * invisible to the walks that warm and watch the argument. The editor reaches
 * `piece` through its own declared contract instead, at the moment a
 * completion is picked.
 */
export interface ItemMentionable {
  [NAME]: string | Default<""> | undefined;
  title: string | Default<"">;
  shortName: string | Default<"">;
}

/**
 * One `[Label][key]` mention: where it points, and whether the reader has
 * given it a wording of their own.
 *
 * `destination` is `unknown` because a mention may address any piece, and
 * because that is the declaration that keeps it a reference: every consumer
 * compares it by identity, and a wider type would start expanding the piece
 * behind it. The shape is the `cf-code-editor` `$references` contract
 * (`packages/ui/src/v2/core/mention-refs.ts`).
 */
export interface ItemMentionRef {
  destination: unknown;
  modifiedTitle: boolean;
}

/**
 * An item's mentions, keyed by the token that appears in its body. The keys
 * are local to one item and mean nothing anywhere else.
 */
export type ItemMentionRefMap = Record<string, ItemMentionRef>;

/** What an item holds, and what its board hands it. */
export interface ItemInput {
  /** The item's title, trimmed by the board's create before it is stored. */
  title?: Writable<string | Default<"">>;

  /** The item's body, verbatim Markdown. */
  body?: Writable<string | Default<"">>;

  /** When the item was filed (epoch milliseconds), stamped at create. */
  createdAt?: number | Default<0>;

  /**
   * The board's names table, one row per named member. The item reads its
   * own row out of it and nothing else; absent, the item shows no name.
   *
   * Readable, not writable: the table is the board's derivation, and an item
   * has no business writing into it.
   */
  boardNames?: ReadonlyCell<NamesTableRow[] | Default<[]>>;

  /**
   * The board's mention universe — what the body editor completes over.
   * Wired at creation to the board's mention index, one derived document of
   * rows (`ItemMentionableRow` in `board.tsx`). Absent, the editor simply
   * offers no completions.
   */
  mentionable?: Writable<ItemMentionable[] | Default<[]>>;

  /**
   * Where this item's `[Label][key]` mentions point, keyed by the token that
   * appears in the body. The editor owns the contents; this pattern owns the
   * cell, which is what makes a mention durable and — because each entry
   * holds the destination as a REFERENCE — what makes the reference a
   * question about cell identity rather than about text.
   *
   * The default has to match the one `ItemOutput` publishes. A map published
   * under a different default than its input carries cannot be materialized.
   */
  // deno-lint-ignore ban-types
  references?: Writable<ItemMentionRefMap | Default<{}>>;
}

/**
 * An item of the exemplar board. The display name stays the title; the
 * board's name for the item rides beside it as `shortName`, and renders as a
 * badge in the header when there is one.
 */
export interface ItemOutput {
  [NAME]: string;
  [UI]: VNode;

  /** The item's title, as stored. */
  title: string | Default<"">;

  /** The item's body, verbatim Markdown. */
  body: string | Default<"">;

  /** When the item was filed (epoch milliseconds). */
  createdAt: number;

  /**
   * The name the board calls this item by, read out of the board's names
   * table; `undefined` for an item no board has named, or one wired to no
   * board.
   *
   * Published under the name a mention pill reads it by
   * (`Mentionable.shortName` in `packages/ui/src/v2/core/mentionable.ts`), so
   * a mention of this item elsewhere gains the number as soon as the board
   * names it.
   */
  shortName: string | undefined;

  /**
   * Where this item's mentions point, keyed by the token in the body. Written
   * whole by the save, out of the draft the editor minted into, in the same
   * transaction as the prose those tokens sit in.
   */
  // deno-lint-ignore ban-types
  references: ItemMentionRefMap | Default<{}>;

  /**
   * Open the body editor on the stored body and its mention map.
   *
   * These three are the whole editing surface, and opening is a verb rather
   * than a flag on purpose: the drafts are seeded here and nowhere else, so a
   * surface that could raise an `editingBody` flag directly would open an
   * editor showing nothing and then save that over the stored body. No such
   * flag is reachable — an unpublished session cell cannot be written from
   * outside, and publishing one as a plain `PerSession<boolean>` is not an
   * option either, because a published value carrying one cannot serve as an
   * action's captured state, which is what naming a member makes of it.
   */
  startEditBody: Stream<void>;

  /** Write the drafted body and its mention map together, and close. */
  saveBody: Stream<void>;

  /** Close the editor, leaving both drafts behind. */
  cancelEditBody: Stream<void>;
}

export default pattern<ItemInput, ItemOutput>(
  (
    {
      title,
      body,
      createdAt,
      boardNames,
      mentionable,
      references,
      [SELF]: self,
    },
  ) => {
    // Session-local: a second tab opens on the stored body, not on this view.
    const editingBody = new Writable.perSession(false);
    const bodyDraft = new Writable.perSession("");
    const referencesDraft = new Writable.perSession<ItemMentionRefMap>({});

    // The board has already derived the table; this is a lookup by identity,
    // and it is written as one.
    const shortName = ownName({ table: boardNames, self });
    const itemName = title.get().trim() || "(untitled item)";
    const hasBody = body.get().trim().length > 0;

    // The one place an edit begins, which is what makes the drafts safe: the
    // editor is reachable only through here, so it never opens on a draft the
    // stored body has not been read into.
    const startEditBody = action(() => {
      // Idempotent: a second open mid-edit would re-seed from the stored body
      // and silently discard whatever the editor is holding.
      if (editingBody.get()) return;
      bodyDraft.set(body.get());
      // Seeded together with the prose, so the editor opens on a map that
      // resolves every token the draft carries. Each `destination` crosses as
      // a link, which is what `unknown` is declared for.
      referencesDraft.set(references.get());
      editingBody.set(true);
    });

    const saveBody = action(() => {
      // A save is only ever the end of an edit. The drafts are seeded by
      // `startEditBody` and by nothing else, so a save arriving cold — before
      // any open, or again after a cancel — would write an empty draft over
      // the stored body and its mention map. Silent rather than thrown
      // because this is a control's stream and not a contract verb: sending
      // it with no edit open is pressing a button that is not on screen.
      if (!editingBody.get()) return;
      body.set(bodyDraft.get());
      // The map publishes with the prose it describes, in this one
      // transaction: the tokens and the destinations they name are one
      // document, and a save that landed only half of it would leave a dead
      // link either way.
      references.set(referencesDraft.get());
      editingBody.set(false);
    });

    // Nothing to undo: both drafts are session-local, so leaving them behind
    // IS the discard.
    const cancelEditBody = action(() => {
      editingBody.set(false);
    });

    return {
      [NAME]: itemName,
      [UI]: (
        <cf-screen>
          <cf-vstack slot="header" gap="1" padding="4">
            <cf-hstack gap="2" align="center">
              {shortName
                ? (
                  <cf-badge size="sm" color="primary" data-member-name="">
                    {shortName}
                  </cf-badge>
                )
                : null}
              <cf-text block style="font-size: 1.25rem; font-weight: 600;">
                {itemName}
              </cf-text>
            </cf-hstack>
          </cf-vstack>

          <cf-vstack gap="3" padding="4">
            <cf-card>
              <cf-vstack gap="2">
                <cf-hstack justify="between" align="center">
                  <cf-heading level={5}>Body</cf-heading>
                  {editingBody
                    ? null
                    : (
                      <cf-button variant="secondary" onClick={startEditBody}>
                        Edit
                      </cf-button>
                    )}
                </cf-hstack>

                {editingBody
                  ? (
                    <cf-vstack gap="2">
                      <cf-code-editor
                        $value={bodyDraft}
                        $mentionable={mentionable}
                        $references={referencesDraft}
                        language="text/markdown"
                        mode="prose"
                        wordWrap
                        tabIndent
                        placeholder="The item's body… type #42 to cite a member."
                        style="min-height: 8rem;"
                      />
                      <cf-hstack gap="2">
                        <cf-button variant="primary" onClick={saveBody}>
                          Save
                        </cf-button>
                        <cf-button variant="ghost" onClick={cancelEditBody}>
                          Cancel
                        </cf-button>
                      </cf-hstack>
                    </cf-vstack>
                  )
                  : hasBody
                  ? <cf-markdown content={body} />
                  : (
                    <cf-text tone="muted" block>
                      No body yet.
                    </cf-text>
                  )}
              </cf-vstack>
            </cf-card>
          </cf-vstack>
        </cf-screen>
      ),
      title,
      body,
      createdAt,
      shortName,
      references,
      startEditBody,
      saveBody,
      cancelEditBody,
    };
  },
);
