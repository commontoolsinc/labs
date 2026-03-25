/// <cts-enable />
import {
  computed,
  equals,
  lift,
  NAME,
  pattern,
  UI,
  type VNode,
  Writable,
} from "commonfabric";

/**
 * Type for pieces used in the mentionable/backlinks system.
 *
 * Note: While `mentioned` and `backlinks` are typed as required for structural
 * compatibility, at runtime most pieces don't actually have these fields.
 * Only patterns like notes and calendar events define them. The computeIndex
 * function safely handles pieces that lack these fields.
 */
export type MentionablePiece = {
  [NAME]?: string;
  isHidden?: boolean;
  isMentionable?: boolean;
  mentioned?: MentionablePiece[];
  backlinks?: MentionablePiece[];
  mentionable?: MentionablePiece[] | { get?: () => MentionablePiece[] };
};

export type WritableBacklinks = {
  mentioned?: WritableBacklinks[];
  backlinks?: Writable<WritableBacklinks[]>;
};

type Input = {
  allPieces: MentionablePiece[];
};

type Output = {
  mentionable: MentionablePiece[];
};

const computeIndex = lift<{ allPieces: WritableBacklinks[] | undefined }, void>(
  ({ allPieces }) => {
    const cs = allPieces ?? [];

    // Reset backlinks for pieces that support it.
    // Many pieces don't have backlinks (e.g., auth pieces, google patterns),
    // so we safely skip them with optional chaining.
    // Also skip undefined/null entries that may exist in the array.
    for (const c of cs) {
      if (!c) continue;
      c.backlinks?.set?.([]);
    }

    // Populate backlinks from mentioned references.
    // Again, use optional chaining since not all pieces support backlinks.
    for (const c of cs) {
      if (!c) continue;
      const mentions = c.mentioned ?? [];
      for (const m of mentions) {
        m?.backlinks?.push?.(c);
      }
    }
  },
);

/**
 * BacklinksIndex builds a map of backlinks across all pieces and exposes a
 * unified mentionable list for consumers like editors.
 *
 * Behavior:
 * - Backlinks are computed by scanning each piece's `mentioned` list and
 *   mapping mention target -> list of source pieces.
 * - Mentionable list is a union of:
 *   - every piece in `allPieces`
 *   - any items a piece exports via a `mentionable` property
 *     (either an array of pieces or a Cell of such an array)
 *
 * The backlinks map is keyed by a piece's `content` value (falling back to
 * its `[NAME]`). This mirrors how existing note patterns identify notes when
 * computing backlinks locally.
 */
const MAX_MENTIONABLE_DEPTH = 5;

const computeMentionable = lift<
  { allPieces: MentionablePiece[] },
  MentionablePiece[]
>(({ allPieces: pieceList }) => {
  const cs = pieceList ?? [];
  const out: MentionablePiece[] = [];

  function isVisited(piece: MentionablePiece): boolean {
    return out.some((other) => equals(piece, other));
  }

  function collect(piece: MentionablePiece, depth: number) {
    if (!piece || piece.isMentionable === false) return;
    if (isVisited(piece)) return;
    out.push(piece);

    if (depth >= MAX_MENTIONABLE_DEPTH) return;

    const exported = piece.mentionable;
    let items: MentionablePiece[] = [];
    if (Array.isArray(exported)) {
      items = exported;
    } else if (exported && typeof (exported as any).get === "function") {
      items = (exported as { get: () => MentionablePiece[] }).get() ?? [];
    }

    for (const m of items) {
      collect(m, depth + 1);
    }
  }

  for (const c of cs) {
    collect(c, 0);
  }

  return out;
});

type Entry = {
  piece: any;
  name: string;
  backlinks: any[];
};

/** Sub-pattern to render a single entry row with its backlinks. */
const EntryRow = pattern<Entry, { [UI]: VNode }>(({ piece, backlinks }) => {
  return {
    [UI]: (
      <cf-card>
        <cf-vstack gap="1">
          <cf-cell-link $cell={piece} />
          <cf-hstack gap="2" style={{ paddingLeft: "8px", flexWrap: "wrap" }}>
            {backlinks.map((link) => (
              <cf-cell-link
                $cell={link}
                style={{
                  fontSize: "12px",
                  color: "var(--cf-color-text-secondary)",
                }}
              />
            ))}
          </cf-hstack>
        </cf-vstack>
      </cf-card>
    ),
  };
});

const BacklinksIndex = pattern<Input, Output>(({ allPieces }) => {
  computeIndex({ allPieces } as { allPieces: WritableBacklinks[] });

  // Compute mentionable list from allPieces reactively
  const mentionable = computeMentionable({ allPieces });

  const query = Writable.of("");

  // Build resolved entries with backlinks materialized as plain arrays
  const entries = computed(() => {
    const items = mentionable ?? [];
    const result: Entry[] = [];
    for (const piece of items) {
      if (!piece) continue;
      const name = (piece[NAME] ?? "").toString();
      const bl = Array.isArray(piece.backlinks) ? piece.backlinks : [];
      result.push({ piece, name, backlinks: bl });
    }
    return result;
  });

  // Filter by name
  const filtered = computed(() => {
    const q = query.get().toLowerCase().trim();
    if (!q) return entries;
    return entries.filter((e) => e.name.toLowerCase().includes(q));
  });

  const totalCount = computed(() => entries.length);
  const filteredCount = computed(() => filtered.length);

  return {
    [NAME]: "BacklinksIndex",
    [UI]: (
      <cf-screen>
        <cf-toolbar slot="header" sticky>
          <h2 style={{ margin: 0, fontSize: "18px" }}>Mentions</h2>
        </cf-toolbar>

        <cf-vstack gap="4" padding="6">
          <cf-input $value={query} placeholder="Filter by name..." />
          <span
            style={{
              fontSize: "13px",
              color: "var(--cf-color-text-secondary)",
            }}
          >
            {filteredCount} of {totalCount} pieces
          </span>

          {filtered.map((entry) => {
            const row = EntryRow({
              piece: entry.piece,
              name: entry.name,
              backlinks: entry.backlinks,
            });
            return row[UI];
          })}
        </cf-vstack>
      </cf-screen>
    ),
    mentionable,
  };
});

export default BacklinksIndex;
