/**
 * The exemplar member of a named collection: a title, a body, a filing time,
 * and the name its board calls it by. The name is not the item's to hold — it
 * lives in the board's namespace — so the item reads its own row out of the
 * board's names table by identity, and an item no board has named shows no
 * name and needs nothing else.
 */

import {
  Default,
  NAME,
  pattern,
  type ReadonlyCell,
  SELF,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

import { type NamesTableRow, ownName } from "./naming.ts";

/** What an item holds, and the one thing its board hands it. */
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
   */
  shortName: string | undefined;
}

export default pattern<ItemInput, ItemOutput>(
  ({ title, body, createdAt, boardNames, [SELF]: self }) => {
    // The board has already derived the table; this is a lookup by identity,
    // and it is written as one.
    const shortName = ownName({ table: boardNames, self });
    const itemName = title.get().trim() || "(untitled item)";
    const hasBody = body.get().trim().length > 0;

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
              {hasBody
                ? <cf-markdown content={body} />
                : (
                  <cf-text tone="muted" block>
                    No body yet.
                  </cf-text>
                )}
            </cf-card>
          </cf-vstack>
        </cf-screen>
      ),
      title,
      body,
      createdAt,
      shortName,
    };
  },
);
