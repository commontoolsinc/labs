/**
 * A member namespace for a collection pattern: the allocator its create verb
 * calls, the table that gives each member its name by identity, the backfill
 * that names what the collection held before it numbered anything, and the
 * declaration the collection publishes so a consumer learns the policy rather
 * than assuming one. Nothing here knows what kind of piece a member is: a
 * member is a cell, compared by identity and never read through.
 *
 * The namespace is one map cell on the collection, `{ "42": <member> }`,
 * written one key at a time. A name is a decimal string, dense from `1`, one
 * more than the largest name present, and never reused: a member keeps its
 * name whatever happens to it, and an entry outlives the member's place in the
 * collection's list. Concurrent allocations serialize through the runtime's
 * commit retry. A keyset read of the map conflicts with a key write to it
 * (`docs/specs/memory-v2/08-conflict-granularity.md`), so of two verbs that
 * read the same keys, the second to commit is rejected, re-runs against the
 * first one's write, and takes the next name.
 *
 * `docs/specs/collection-naming.md` is the design this implements.
 */

import {
  type ComparableCell,
  Default,
  equals,
  lift,
  type ReadonlyCell,
  Writable,
} from "commonfabric";

/**
 * What a collection holds its member names to over time. Published beside
 * the names rather than implied by them, so a consumer that needs a promise
 * — a printed citation, a reference leaving the fabric — can read whether it
 * has one.
 */
export interface NamingPolicy {
  /**
   * Whether a name is unique across the collection's whole history, or only
   * among its current members.
   */
  unique: "history" | "current";

  /** Whether a name, once assigned, is never retired or reassigned. */
  permanent: boolean;

  /** Whether a retired name may be given to another member. */
  reuse: boolean;

  /**
   * What a name is made of: a monotonic sequence, a random code, a string a
   * person chose, or a derivation from the member's own content.
   */
  allocator: "sequence" | "random" | "human" | "derived";
}

/** What a collection declares about the names it gives its members. */
export interface NamingDeclaration {
  /**
   * The collection's own name, which a binding uses to reach it. Absent when
   * the collection makes no claim about what it is bound as.
   */
  name?: string;

  /** The policy the names are held to. */
  policy: NamingPolicy;

  /**
   * Whether the collection offers the compact spelling that joins its name to
   * a member's with a hyphen. Only a collection whose member names cannot
   * contain a hyphen may say so.
   */
  compact: boolean;
}

/**
 * The declaration for the sequence this module allocates: unique across
 * history, permanent, never reused, and eligible for the compact spelling
 * because a decimal name holds no hyphen. It names no collection; a
 * collection that declares one spreads this and adds its own `name`.
 */
export const SEQUENCE_NAMING: NamingDeclaration = {
  policy: {
    unique: "history",
    permanent: true,
    reuse: false,
    allocator: "sequence",
  },
  compact: true,
};

/**
 * The namespace: each name to the member it names, held as an unread
 * reference. Declared `unknown` so that a member is stored as a link and a
 * reader of the map — the allocator surveying its keys, a resolver following
 * one entry — expands no member it did not follow.
 *
 * A collection declares it at its input as `Writable<Default<NamesMap, {}>>`,
 * written inline at the property rather than through an alias, and both
 * halves of that are load-bearing. `NamesMap | Default<{}>` adds a bare
 * empty-object arm to the union, and wherever that union reaches a handler
 * unmerged it becomes an `anyOf` whose empty arm reads every value whole —
 * the merge lets a branch that looked win over the opaque one — so the
 * allocator would expand every member to survey the keys; the two-argument
 * form keeps the union to the record type. And the schema generator reads
 * the default off the property's own type node, so a default declared
 * through an alias is dropped from the schema.
 */
export type NamesMap = Record<string, unknown>;

/**
 * The namespace as a verb holds it: read whole for its keys, written one key
 * at a time. Nothing here rewrites the map whole, which is what lets two
 * verbs naming different members merge instead of clobbering each other.
 *
 * Declared structurally, with `get()` returning `undefined` for a map nothing
 * has written yet. A verb reads its binding through a schema that carries no
 * default, so on a collection that has never named a member the map is
 * absent inside the verb however the input declares it; the structural
 * declaration is what makes the readers here handle that where the compiler
 * can see it. A `Writable<NamesMap>` satisfies it.
 */
export interface NamesMapCell {
  /** The map, or `undefined` before the first name is written. */
  get(): NamesMap | undefined;

  /** The entry for `name`, to be set to the member it names. */
  key(name: string): { set(member: unknown): void };
}

/**
 * One row of a collection's names table: a member, and the name the
 * collection calls it by.
 *
 * ONE ROW PER NAMED MEMBER, addressed by the member it describes. A row keeps
 * its identity wherever it sits in the table, so a member looking itself up
 * by identity finds one row, and a table recomputed over an unchanged map
 * writes nothing.
 */
export interface NamesTableRow {
  /**
   * The member. `unknown` because it is written as a reference and only ever
   * compared; anything wider would read the member back whole.
   */
  member: unknown;

  /** The member's name. */
  name: string;
}

/**
 * Whether `key` is a member name: a canonical decimal string — `0`, or a
 * non-zero digit followed by digits, with no leading zeros, no sign, and no
 * exponent. The map can be written by any client over the memory protocol,
 * so a key is not guaranteed to be a name this sequence issued; a key
 * outside the grammar is not a name, and it neither counts as the largest
 * nor blocks allocation.
 */
const isMemberName = (key: string): boolean => /^(0|[1-9][0-9]*)$/.test(key);

/**
 * Whether canonical decimal `a` is larger than canonical decimal `b`. Names
 * are compared as strings — by length, then lexicographically — and never
 * as JavaScript numbers, which lose distinctness past `2^53` and would
 * reuse a name there.
 */
const isLargerName = (a: string, b: string): boolean =>
  a.length !== b.length ? a.length > b.length : a > b;

/**
 * Helper for `nextNameAmong()` and `backfillNames()`, which returns the
 * canonical decimal one larger than `name`, as a string. The trailing run
 * of nines turns to zeros and the digit before it goes up by one; a name
 * that is all nines gains a leading `1`.
 */
const incrementName = (name: string): string => {
  const [, head, nines] = name.match(/^([0-9]*?)(9*)$/)!;
  const zeros = "0".repeat(nines.length);
  if (head === "") return `1${zeros}`;
  return `${head.slice(0, -1)}${Number(head.at(-1)) + 1}${zeros}`;
};

/**
 * The next name the sequence issues over the keys in use: `1` when none of
 * them is a member name, otherwise one more than the largest. The sequence
 * is dense from `1` and a name is never reused, so this is the whole of the
 * allocation rule; what makes it safe under concurrency is where it is
 * called, which `assignName()` states. Keys that are not member names —
 * `isMemberName()` says which — are ignored.
 */
export function nextNameAmong(names: Iterable<string>): string {
  const largest = Array.from(names)
    .filter(isMemberName)
    .reduce<string | undefined>(
      (max, name) => max === undefined || isLargerName(name, max) ? name : max,
      undefined,
    );
  return largest === undefined ? "1" : incrementName(largest);
}

/**
 * Allocates the next name over `names` and records `member` under it, and
 * returns the name. Called from the body of an `action()` or `handler()`, so
 * the read of the map's keys and the write of the new key land in one
 * transaction. That is what makes the name safe: a concurrent create that
 * read the same keys conflicts on commit, re-runs against this write, and
 * takes the name after it.
 */
export function assignName(names: NamesMapCell, member: unknown): string {
  const name = nextNameAmong(Object.keys(names.get() ?? {}));
  names.key(name).set(member);
  return name;
}

/**
 * The name `table` gives `member`, or `undefined` when it has none. Matching
 * is by identity: `equals` compares what each side refers to, whether it
 * arrived as a cell or as the raw link a read left behind.
 */
export function nameOf(
  member: object,
  table: readonly NamesTableRow[],
): string | undefined {
  return table.find((row) => equals(member, row.member as object))?.name;
}

/**
 * The names table derived from the namespace: one row per named member,
 * addressed by the member. The table publishes exactly the names the grammar
 * admits — `isMemberName()` — so a key a foreign writer put in the map is no
 * member's name here, as it is no name to the allocator. A collection derives
 * this once and hands it to each member it creates, so a member's reverse
 * lookup is a scan of the rows rather than a read of the map.
 */
export const namesTable = lift(
  (
    { names }: {
      // A record of CELLS, which is what lets one declaration serve both of
      // the table's needs: the cell is the member's identity, which addresses
      // its row, and a cell always writes as a link, so the rows below are
      // the same documents on every run over the same map. Defaulted in the
      // form `NamesMap` explains.
      // deno-lint-ignore ban-types
      names: Default<Record<string, ReadonlyCell<unknown>>, {}>;
    },
  ): NamesTableRow[] => {
    // An entry under a key the grammar does not admit is not a name and gets
    // no row. An entry with nothing behind it yet (mid-sync) reads as
    // `undefined`, has no identity to address a row by, and gets no row
    // rather than a junk one. Nothing else is filtered: the values are cells,
    // so a value a foreign writer stored under a name — `null`, a scalar —
    // arrives as a cell too, and telling it apart would mean reading through
    // the member.
    const rows: unknown[] = Object.entries(names)
      .filter(([name, member]) => isMemberName(name) && member !== undefined)
      .map(([name, member]) =>
        Writable.for<NamesTableRow>(member).set({ member, name })
      );
    return rows as NamesTableRow[];
  },
);

/**
 * Names every member of `members` that has no name, in filing order, and
 * returns the names it wrote — exactly the keys it added to `names`, in the
 * order it added them. A member already named is skipped, whatever position
 * it holds, and a member listed at two positions is named once: membership
 * is asked of IDENTITY, never of position. Idempotent: a run over a fully
 * named list writes nothing and returns `[]`.
 *
 * Called from a verb body for the reason `assignName()` is: the keyset read
 * and the key writes are one transaction, so a create that lands while a
 * backfill runs serializes with it rather than colliding on a name.
 */
export function backfillNames(
  members: { get(): readonly unknown[]; key(index: number): object },
  names: NamesMapCell,
): string[] {
  const map = names.get() ?? {};
  // The members with a name: those the map already holds, and — as the walk
  // goes — those this run names, so a member met again is not named again.
  const named = Object.values(map) as (object | undefined)[];
  const count = members.get().length;
  const written: string[] = [];
  let next = nextNameAmong(Object.keys(map));
  for (let index = 0; index < count; index++) {
    // The cell at the position rather than the value read out of it: a cell
    // is an identity `equals` can match against the map's links, and it is
    // what the map stores.
    const member = members.key(index);
    if (named.some((other) => equals(member, other))) continue;
    names.key(next).set(member);
    written.push(next);
    named.push(member);
    next = incrementName(next);
  }
  return written;
}

/**
 * A member's own name, looked up in its collection's names table by
 * identity: `undefined` for a member no table names, or one handed no table.
 *
 * Re-runs whenever any row changes, and writes nothing when the row it finds
 * is unchanged. The parameter declares the rows' members as comparable cells
 * and nothing more, so surveying the whole table expands no member.
 */
export const ownName = lift(
  (
    { table, self }: {
      table: { member: ComparableCell<unknown>; name: string }[] | Default<[]>;
      self: ComparableCell<unknown>;
    },
  ): string | undefined => nameOf(self, table),
);
