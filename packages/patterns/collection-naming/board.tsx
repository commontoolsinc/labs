/**
 * The exemplar collection: a board of items that owns a member namespace.
 * `addItem` allocates the next name and appends the item in one write, so the
 * created item is reachable at `names[<n>]` the moment it exists;
 * `backfillNames` names, in filing order, whatever the board held before it
 * numbered anything. The board publishes its index with each member's name,
 * the names table its items read their names from, and the declaration a
 * consumer learns the naming policy from.
 */

import {
  action,
  type ComparableCell,
  Default,
  lift,
  NAME,
  pattern,
  type ReadonlyCell,
  Stream,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

import Item from "./item.tsx";
import {
  assignName,
  backfillNames,
  nameOf,
  type NamesMap,
  namesTable,
  type NamesTableRow,
  type NamingDeclaration,
  SEQUENCE_NAMING,
} from "./naming.ts";

/**
 * What the board reads of a stored item — its demand, not the item's whole
 * contract. Two scalars cover the index and the cards; `title` carries a
 * default so a missing path does not make the whole array unreadable, and
 * `createdAt` is published unconditionally by the item pattern.
 */
export interface ItemDemand {
  title: string | Default<"">;
  createdAt: number;
}

export interface BoardInput {
  /** The board's durable item list, in filing order. `addItem` appends here;
   * a whole-array write forfeits the mergeability the append keeps. */
  items?: Writable<ItemDemand[] | Default<[]>>;

  /** The board's member namespace: each name to the item it names, held as an
   * unread reference. `addItem` writes one key per create and `backfillNames`
   * one key per member it names; nothing rewrites the map whole. Reads as
   * empty on a board from before it numbered anything, in the default form
   * `NamesMap` explains. */
  // deno-lint-ignore ban-types
  names?: Writable<Default<NamesMap, {}>>;
}

export interface AddItemEvent {
  /** The item's title, trimmed before it is stored. Must be non-empty. */
  title: string;

  /** The item's initial body, stored verbatim. */
  body?: string;

  /** The agent making this mutation. Fabric records the human principal
   * behind the key; this names which agent acted under it. Required, and
   * checked rather than stored: a create that could be unsigned is a
   * tolerance the verb could never withdraw. */
  agentName: string;
}

/**
 * One row of the board's index: the item as a reference, the scalars a survey
 * reads, and the board's name for it.
 *
 * The scalars are COPIES, and the copies are what make the index one
 * self-contained document: a survey reads every row's strings, and a row that
 * pointed at its item for them would make every reader expand every item.
 * The reference is what a caller follows for the item itself.
 */
export interface ItemIndexRow {
  /** The item, written as a reference and never read through here. */
  member: unknown;

  title: string | Default<"">;
  createdAt: number | Default<0>;

  /** The board's name for the item. Defaulted so a board holding members
   * from before it numbered anything still reads whole: a member the board
   * has not named reads as the empty string. */
  name: string | Default<"">;
}

export interface AddItemResult {
  /** The item this call created, as its index row: the reference, the
   * scalars as stored, and the name the create allocated. */
  item: ItemIndexRow;
}

export interface BackfillNamesEvent {
  /** The agent running the backfill, checked as `addItem` checks it. */
  agentName: string;
}

export interface BackfillNamesResult {
  /** The names this run wrote, in filing order; empty when every member was
   * already named, which is what a second run returns. */
  assigned: string[];
}

/**
 * A board of items that names its members. Survey the board with one bounded
 * read of `index`, whose rows carry each item's name; follow a row's `member`
 * for the item itself. File with `addItem`, which allocates the next name in
 * the same write as the append and returns the row, name included. A board
 * that held items before it numbered anything runs `backfillNames` once.
 */
export interface BoardOutput {
  [NAME]: string;
  [UI]: VNode;

  /** The board's items, in filing order, through the shape the board demands
   * of them. */
  items: ItemDemand[];

  /** The survey surface: one row per item, scalars copied, name included. */
  index: ItemIndexRow[] | Default<[]>;

  /** The namespace itself: each name to the item it names. A slug pointing
   * here is what makes a member addressable as `<board>/<name>`. Published
   * under the default its input carries. */
  // deno-lint-ignore ban-types
  names: Default<NamesMap, {}>;

  /** The names table, one row per named member, which every item the board
   * creates reads its own name from. Published so an item composed outside
   * `addItem` can be wired to the same table. */
  namesTable: NamesTableRow[] | Default<[]>;

  /** What the board declares about its names, for a consumer deciding
   * whether a name may be held rather than an identity. */
  naming: NamingDeclaration;

  /** How many items the board holds. */
  itemCount: number;

  /** File an item: allocate its name and append it, atomically. */
  addItem: Stream<AddItemEvent, AddItemResult>;

  /** Name every unnamed member in filing order. Idempotent. */
  backfillNames: Stream<BackfillNamesEvent, BackfillNamesResult>;
}

/**
 * Rejects a mutation loudly. To a headless caller a silent early return is
 * indistinguishable from success; a throw surfaces as a failed handler
 * transaction and a nonzero CLI exit. The message carries the verb as a
 * stable prefix.
 */
const reject = (verb: string, reason: string): never => {
  throw new Error(`${verb} rejected: ${reason}`);
};

/**
 * The index rows over `members`, each addressed by the member it describes
 * and carrying the name `table` gives it. A member with no name gets a row
 * with no `name` field, which the published row schema's default fills.
 *
 * Declared structurally so that a member with nothing behind it yet — one
 * appended a moment ago, still mid-sync — reads as `undefined` here and gets
 * no row rather than a junk one; the row appears on the next run.
 */
export function indexRowsOf(
  members: readonly (
    | { get(): { title?: string; createdAt?: number } | undefined }
    | undefined
  )[],
  table: readonly NamesTableRow[],
): ItemIndexRow[] {
  const rows: unknown[] = [];
  for (const member of members) {
    const value = member?.get();
    if (!member || !value) continue;
    const name = nameOf(member, table);
    // `name` is left out rather than written empty for an unnamed member, so
    // the row schema's default is what a reader sees; the cast says that the
    // schema, not this object, supplies it.
    const row = {
      member,
      title: value.title ?? "",
      createdAt: value.createdAt ?? 0,
      ...(name === undefined ? {} : { name }),
    } as ItemIndexRow;
    rows.push(Writable.for<ItemIndexRow>(member).set(row));
  }
  return rows as ItemIndexRow[];
}

/**
 * The board's index, derived once for the whole board. The parameter is an
 * array of CELLS for the reason the names table's is: the cell is the
 * identity each row is addressed by, and a cell always writes as a link, so
 * an unchanged board recomputes to the same rows and writes nothing. Reading
 * two scalars per member is the entire cost of surveying the board.
 */
const indexRows = lift(
  (
    { members, table }: {
      members:
        | ReadonlyCell<{
          title: string | Default<"">;
          createdAt: number | Default<0>;
        }>[]
        | Default<[]>;
      table: { member: ComparableCell<unknown>; name: string }[] | Default<[]>;
    },
  ): ItemIndexRow[] =>
    // A plain array, read once per member: an element read through the
    // reactive array costs a link resolution per access.
    indexRowsOf(Array.from(members), table),
);

export default pattern<BoardInput, BoardOutput>(({ items, names }) => {
  // `.length` alone is what keeps this cheap: the shrunk schema declares
  // `items: unknown`, so counting the board expands no item.
  const itemCount = items.get().length;
  // Derived once for the whole board; every item reads its own row out of it.
  const table = namesTable({ names });
  const index = indexRows({ members: items, table });
  const hasNoItems = itemCount === 0;

  const addItem = action<AddItemEvent, AddItemResult>(
    ({ title, body, agentName }) => {
      const trimmed = (title ?? "").trim();
      if (!(agentName ?? "").trim()) {
        reject("addItem", "agentName must be non-blank");
      }
      if (!trimmed) reject("addItem", "title must be non-empty");
      const createdAt = Date.now();
      const piece = Item({
        title: trimmed,
        body: body ?? "",
        createdAt,
        // The board's names table, so the item can read its own name out of
        // the row the board already built for it.
        boardNames: table,
      });
      // The name and the append are one transaction: no reader observes the
      // item without its name, and a concurrent create serializes on the
      // map's keys rather than taking the same one.
      const name = assignName(names, piece);
      // Mergeable append: concurrent creates all land.
      items.push(piece);
      return { item: { member: piece, title: trimmed, createdAt, name } };
    },
  );

  const backfill = action<BackfillNamesEvent, BackfillNamesResult>(
    ({ agentName }) => {
      if (!(agentName ?? "").trim()) {
        reject("backfillNames", "agentName must be non-blank");
      }
      return { assigned: backfillNames(items, names) };
    },
  );

  return {
    [NAME]: `Items (${itemCount})`,
    [UI]: (
      <cf-screen>
        <cf-vstack slot="header" gap="2" padding="4">
          <cf-heading level={3}>Items</cf-heading>
          <cf-text variant="caption" tone="muted">
            {itemCount} items · each named by the board's sequence
          </cf-text>
        </cf-vstack>

        <cf-vstack gap="2" padding="4">
          {index.map((row) => (
            <cf-card>
              <cf-hstack gap="3" align="center">
                {row.name
                  ? (
                    <cf-badge size="sm" color="primary" data-member-name="">
                      {row.name}
                    </cf-badge>
                  )
                  : null}
                <cf-text block style="flex: 1; min-width: 0; font-weight: 600;">
                  {row.title || "(untitled item)"}
                </cf-text>
                <cf-cell-link $cell={row.member} label="Open" static />
              </cf-hstack>
            </cf-card>
          ))}

          {hasNoItems
            ? <cf-empty-state message="No items yet. File one with addItem." />
            : null}
        </cf-vstack>
      </cf-screen>
    ),
    items,
    index,
    names,
    namesTable: table,
    // The sequence policy, claiming no name for the board: what it is bound
    // as is decided where the binding is made.
    naming: SEQUENCE_NAMING,
    itemCount,
    addItem,
    backfillNames: backfill,
  };
});
