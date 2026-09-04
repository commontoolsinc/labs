/**
 * The exemplar member of a named collection: a title, a body, a filing time,
 * and the name its board calls it by. The name is not the item's to hold — it
 * lives in the board's namespace — so the item reads its own row out of the
 * board's names table by identity, and an item no board has named shows no
 * name and needs nothing else. The body is edited through `cf-code-editor`,
 * which completes `#42` over the board's mention universe and mints a
 * reference-form mention into the item's own map.
 */

import {
  action,
  Default,
  NAME,
  pattern,
  type PerSession,
  type ReadonlyCell,
  SELF,
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
   * whole by the body save, out of the draft the editor minted into.
   */
  // deno-lint-ignore ban-types
  references: ItemMentionRefMap | Default<{}>;

  /**
   * Whether the body editor is open, session-local: a second tab opens on the
   * stored body rather than on this one.
   *
   * The toggle alone is published, and the drafts behind it are not. Opening
   * the editor is the whole of what a surface outside this item needs: the
   * prose, the mention map and the Save that writes them together are the
   * item's own controls, rendered by the item, so an embedder that flips this
   * gets the whole edit rather than the half `saveBody` exists to prevent.
   * The streams are deliberately unpublished too — a member's published value
   * is written into its board's namespace map, and streams in it do not
   * survive that write.
   */
  editingBody: PerSession<Writable<boolean>>;
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
    // Session-local editing state: a second tab opens on the stored body.
    const editingBody = new Writable.perSession(false);
    const bodyDraft = new Writable.perSession("");
    const referencesDraft = new Writable.perSession<ItemMentionRefMap>({});

    // The board has already derived the table; this is a lookup by identity,
    // and it is written as one.
    const shortName = ownName({ table: boardNames, self });
    const itemName = title.get().trim() || "(untitled item)";
    const hasBody = body.get().trim().length > 0;

    const startEditBody = action(() => {
      bodyDraft.set(body.get());
      // Seeded together with the prose, so the editor opens on a map that
      // resolves every token the draft carries. Each `destination` crosses as
      // a link, which is what `unknown` is declared for.
      referencesDraft.set(references.get());
      editingBody.set(true);
    });

    const saveBody = action(() => {
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
      editingBody,
    };
  },
);
