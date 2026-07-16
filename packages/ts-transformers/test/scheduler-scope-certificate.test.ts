import { assert, assertEquals } from "@std/assert";
import ts from "typescript";
import type {
  CapabilityParamSummary,
  FunctionCapabilitySummary,
} from "../src/core/mod.ts";
import { hasCompleteSchedulerScopeSummary } from "../src/policy/derive-scheduler-options.ts";
import { transformSource } from "./utils.ts";
import { COMMONFABRIC_TYPES } from "./commonfabric-test-types.ts";
import { callsNamed, literalToValue, parseModule } from "./transformed-ast.ts";

// ---------------------------------------------------------------------------
// W2.12/W2.13 shared: the `completeSchedulerScopeSummary` certificate the
// server-primary executor consults to admit an action as statically servable.
// These pin the read-only relaxation (W2.12) and the direct-builder cert path
// (W2.13) that make R4 offenders (note.tsx opaque/passthrough computeds and
// module-scope lift builders) certify while genuine write surfaces stay closed.
// ---------------------------------------------------------------------------

function param(
  overrides: Partial<CapabilityParamSummary> & { name: string },
): CapabilityParamSummary {
  return {
    capability: "readonly",
    readPaths: [],
    writePaths: [],
    passthrough: false,
    wildcard: false,
    ...overrides,
  };
}

function summary(
  params: CapabilityParamSummary[],
  extra?: Partial<FunctionCapabilitySummary>,
): FunctionCapabilitySummary {
  return { params, ...extra };
}

// --- Unit: the gate's soundness boundary --------------------------------------

Deno.test("cert gate: read-only opaque whole-value param certifies (W2.12)", () => {
  // The note.tsx `allNotesPiece ? "block" : "none"` shape: a captured piece ref
  // used only for truthiness classifies opaque with no reads or writes.
  assert(
    hasCompleteSchedulerScopeSummary(
      summary([param({ name: "p", capability: "opaque" })]),
    ),
  );
});

Deno.test("cert gate: read-only `??` passthrough param certifies (W2.12)", () => {
  // `x ?? fallback` on a bare captured root marks passthrough (and, for a pure
  // passthrough, opaque). A read-only passthrough carries no hidden write.
  assert(
    hasCompleteSchedulerScopeSummary(
      summary([param({ name: "p", capability: "opaque", passthrough: true })]),
    ),
  );
});

Deno.test("cert gate: plain readonly param still certifies (unchanged)", () => {
  assert(
    hasCompleteSchedulerScopeSummary(
      summary([
        param({ name: "p", capability: "readonly", readPaths: [["v"]] }),
      ]),
    ),
  );
});

Deno.test("cert gate: enumerable write param still certifies (materializer, unchanged)", () => {
  assert(
    hasCompleteSchedulerScopeSummary(
      summary([
        param({ name: "p", capability: "writable", writePaths: [["counter"]] }),
      ]),
    ),
  );
});

Deno.test("cert gate: opaque param alongside a writing sibling stays uncertified (regression)", () => {
  // A callback that also writes keeps today's strict gate: an opaque read on a
  // sibling must not certify a non-read-only callback (its write envelope must
  // be exactly enumerable, and an opaque param is a hidden-write risk there).
  assertEquals(
    hasCompleteSchedulerScopeSummary(
      summary([
        param({ name: "w", capability: "writeonly", writePaths: [["log"]] }),
        param({ name: "p", capability: "opaque" }),
      ]),
    ),
    false,
  );
});

Deno.test("cert gate: read-only wildcard param stays uncertified (no envelope)", () => {
  // A dynamic (`cell[k]`) access can hide a write, and a read-only wildcard
  // declares no write envelope, so it must fail closed. W2.16 only relaxes
  // wildcards that ALSO write (materializers); this boundary is unchanged.
  assertEquals(
    hasCompleteSchedulerScopeSummary(
      summary([param({ name: "p", capability: "opaque", wildcard: true })]),
    ),
    false,
  );
});

// --- W2.16: envelope-complete materializers -----------------------------------

Deno.test("cert gate: wildcard materializer with a write envelope certifies", () => {
  // The backlinks-index `computeIndex` family-2 shape: a dynamic `.key(i)` write
  // (`m.key("backlinks").push(...)`) surfaces only as a write ENVELOPE bounded to
  // the descent prefix, with `wildcardUnbounded` clear. Its envelope is a
  // complete write bound, so it certifies as a materializer.
  assert(
    hasCompleteSchedulerScopeSummary(
      summary([
        param({
          name: "allPieces",
          capability: "readonly",
          wildcard: true,
          writeEnvelopePaths: [["allPieces", "0", "mentioned"]],
        }),
      ]),
    ),
  );
});

Deno.test("cert gate: materializer with both exact and envelope writes certifies", () => {
  // The full `computeIndex` param: an exact write path (`allPieces[*].backlinks`)
  // plus a dynamic write envelope (`allPieces[*].mentioned`). Both families must
  // land in the complete bound.
  assert(
    hasCompleteSchedulerScopeSummary(
      summary([
        param({
          name: "allPieces",
          capability: "writable",
          wildcard: true,
          writePaths: [["allPieces", "0", "backlinks"]],
          writeEnvelopePaths: [["allPieces", "0", "mentioned"]],
        }),
      ]),
    ),
  );
});

Deno.test("cert gate: unbounded wildcard write stays uncertified (soundness)", () => {
  // An `elementById`/dynamic-method write cannot be bounded to a param-anchored
  // envelope: `wildcardUnbounded` is set, so a write could hide outside the
  // recorded envelopes and the materializer must fail closed — even though it
  // carries a write envelope for the part the analysis COULD bound.
  assertEquals(
    hasCompleteSchedulerScopeSummary(
      summary([
        param({
          name: "p",
          capability: "writable",
          wildcard: true,
          writeEnvelopePaths: [["p", "0", "mentioned"]],
          wildcardUnbounded: true,
        }),
      ]),
    ),
    false,
  );
});

Deno.test("cert gate: unbounded wildcard with exact writes stays uncertified", () => {
  // A param with enumerable writes but an unbounded dynamic access alongside
  // them still fails closed: the unbounded access could hide a write outside the
  // enumerated set.
  assertEquals(
    hasCompleteSchedulerScopeSummary(
      summary([
        param({
          name: "p",
          capability: "writable",
          wildcard: true,
          writePaths: [["p", "0", "backlinks"]],
          wildcardUnbounded: true,
        }),
      ]),
    ),
    false,
  );
});

Deno.test("cert gate: hasUnverifiedCellUse stays uncertified even when read-only", () => {
  // Write-exhaustiveness is unverifiable, so `writePaths` may be incomplete.
  assertEquals(
    hasCompleteSchedulerScopeSummary(
      summary([param({ name: "p", hasUnverifiedCellUse: true })]),
    ),
    false,
  );
});

Deno.test("cert gate: opaque sub-path derivation stays uncertified even when read-only", () => {
  assertEquals(
    hasCompleteSchedulerScopeSummary(
      summary([param({ name: "p", opaquePaths: [["items"]] })]),
    ),
    false,
  );
});

Deno.test("cert gate: recursive analysis stays uncertified", () => {
  assertEquals(
    hasCompleteSchedulerScopeSummary(
      summary([param({ name: "p", capability: "readonly" })], {
        recursive: true,
      }),
    ),
    false,
  );
});

Deno.test("cert gate: unreadable cell argument stays uncertified", () => {
  assertEquals(
    hasCompleteSchedulerScopeSummary(
      summary([param({ name: "p", capability: "readonly" })], {
        unreadableCellArguments: [
          { node: ts.factory.createNull(), message: "unreadable" },
        ],
      }),
    ),
    false,
  );
});

// --- Pipeline: end-to-end transformed output ----------------------------------

function schedulerOptionsFor(
  call: ts.CallExpression,
): Record<string, unknown> | undefined {
  for (const argument of [...call.arguments].reverse()) {
    if (
      !ts.isObjectLiteralExpression(argument) &&
      !ts.isSatisfiesExpression(argument)
    ) {
      continue;
    }
    const value = literalToValue(argument);
    if (value === null || typeof value !== "object") {
      continue;
    }
    if (
      "completeSchedulerScopeSummary" in value ||
      "materializerWriteInputPaths" in value
    ) {
      return value as Record<string, unknown>;
    }
  }
  return undefined;
}

/** The scheduler options of the (single) hoisted lift that drives `resultName`. */
function certifiedLiftCount(root: ts.SourceFile): number {
  return callsNamed(root, "lift").filter((call) =>
    schedulerOptionsFor(call)?.completeSchedulerScopeSummary === true
  ).length;
}

/**
 * The `materializerWriteInputPaths` emitted on the (single) certifying lift,
 * each path joined with "." for readable assertions. Empty when no lift emits
 * one.
 */
function certifiedMaterializerPaths(root: ts.SourceFile): string[] {
  for (const call of callsNamed(root, "lift")) {
    const options = schedulerOptionsFor(call);
    if (options?.completeSchedulerScopeSummary !== true) continue;
    const paths = options.materializerWriteInputPaths;
    if (!Array.isArray(paths)) continue;
    return paths.map((path) => (path as string[]).join("."));
  }
  return [];
}

async function transform(source: string): Promise<ts.SourceFile> {
  return parseModule(
    await transformSource(source, { types: COMMONFABRIC_TYPES }),
  );
}

Deno.test(
  "pipeline W2.12: truthiness-on-opaque computed certifies",
  async () => {
    // note.tsx __cfLift_12/13: `allNotesPiece ? "block" : "none"` over a wish
    // result (opaque whole-value read).
    const root = await transform(
      `import { computed, pattern, wish } from "commonfabric";
interface Piece { name: string; }
export default pattern(() => {
  const w = wish<Piece>({ query: "#p", scope: ["."], headless: true });
  const allNotesPiece = w.result;
  const dividerDisplay = computed(() => allNotesPiece ? "block" : "none");
  return dividerDisplay;
});`,
    );
    assertEquals(certifiedLiftCount(root), 1);
  },
);

Deno.test(
  "pipeline W2.12: `.get()` read control computed still certifies",
  async () => {
    // note.tsx __cfLift_11 control: `.get()` on a readable cell — must remain
    // certified and unaffected by the relaxation.
    const root = await transform(
      `import { Writable, computed, pattern } from "commonfabric";
export default pattern(() => {
  const menuOpen = new Writable(false);
  const menuDisplay = computed(() => menuOpen.get() ? "flex" : "none");
  return menuDisplay;
});`,
    );
    assertEquals(certifiedLiftCount(root), 1);
  },
);

Deno.test(
  "pipeline W2.12 regression: captured-cell write computed keeps materializer + cert",
  async () => {
    const root = await transform(
      `import { Writable, computed, pattern } from "commonfabric";
export default pattern(() => {
  const counter = new Writable(0);
  const source = new Writable(1);
  const bumped = computed(() => { counter.set(source.get()); return source.get(); });
  return bumped;
});`,
    );
    const opts = callsNamed(root, "lift")
      .map(schedulerOptionsFor)
      .find((o) => o !== undefined);
    assert(opts, "expected a scheduler-options object");
    assertEquals(opts!.completeSchedulerScopeSummary, true);
    assertEquals(opts!.materializerWriteInputPaths, [["counter"]]);
  },
);

Deno.test(
  "pipeline W2.13: module-scope direct lift with a clean body certifies",
  async () => {
    const root = await transform(
      `import { lift } from "commonfabric";
interface In { a: number; b: number; }
export const sum = lift((input: In) => input.a + input.b);`,
    );
    assertEquals(certifiedLiftCount(root), 1);
  },
);

Deno.test(
  "pipeline W2.13: auto-lowered `?? new Writable()` passthrough certifies",
  async () => {
    // note.tsx __cfLift_5 shape: a bare reactive `??` expression the
    // expression-site transformer lowers to a direct lift builder.
    const root = await transform(
      `import { Writable, derive, pattern } from "commonfabric";
interface Notebook { name: string; }
export default pattern<{ parent?: Writable<Notebook | null> }>(({ parent }) => {
  const parentNotebook = derive(
    parent,
    (_parentNotebook) => _parentNotebook ?? new Writable(null as Notebook | null),
  );
  return parentNotebook;
});`,
    );
    assert(
      certifiedLiftCount(root) >= 1,
      "expected the passthrough lift certified",
    );
  },
);

Deno.test(
  "pipeline W2.16: module-scope lift with a `.key(i)` write certifies as a materializer",
  async () => {
    // backlinks-index computeIndex family-2 shape: a dynamic `.key(i)` write is
    // now bounded to the descent prefix (`items[*].mentioned`) as a write
    // ENVELOPE and certifies — the write surface is data-dependent but
    // prefix-bounded, exactly the materializer contract (W2.13 previously kept
    // this closed).
    const root = await transform(
      `import { lift, type Cell } from "commonfabric";
interface Item { mentioned: (Item | null)[]; backlinks: unknown[]; }
export const indexAll = lift((input: { items: Cell<Item>[] }) => {
  for (const item of input.items) {
    const mentions = item.key("mentioned").get() ?? [];
    for (let i = 0; i < mentions.length; i++) {
      item.key("mentioned").key(i).key("backlinks").set([]);
    }
  }
});`,
    );
    assertEquals(certifiedLiftCount(root), 1);
    assertEquals(certifiedMaterializerPaths(root), ["items.0.mentioned"]);
  },
);

Deno.test(
  "pipeline W2.16: computeIndex two-family shape names both write families",
  async () => {
    // The full backlinks-index `computeIndex`: an exact write
    // (`allPieces[*].backlinks`) plus a dynamic-`.key(i)` write envelope
    // (`allPieces[*].mentioned`). Both families must appear in
    // `materializerWriteInputPaths` — the exact write must NOT be
    // under-declared, and the envelope names the dynamic family.
    const root = await transform(
      `import { lift, type Cell } from "commonfabric";
interface Piece { mentioned?: Piece[]; backlinks?: Piece[]; }
export const computeIndex = lift(
  ({ allPieces }: { allPieces: Cell<Piece>[] | undefined }) => {
    const cs = allPieces ?? [];
    for (const c of cs) {
      if (!c) continue;
      const value = c.get();
      if (!value || !("backlinks" in value)) continue;
      c.key("backlinks").set([]);
    }
    for (const c of cs) {
      if (!c) continue;
      const mentions = c.key("mentioned").get() ?? [];
      for (let i = 0; i < mentions.length; i++) {
        const m = c.key("mentioned").key(i);
        const target = m?.get();
        if (!target || !("backlinks" in target)) continue;
        m.key("backlinks").push(c);
      }
    }
  },
);`,
    );
    assertEquals(certifiedLiftCount(root), 1);
    // The statically-visible exact write MUST be covered (no under-declaration),
    // and the dynamic family MUST be named by its envelope.
    assertEquals(certifiedMaterializerPaths(root), [
      "allPieces.0.backlinks",
      "allPieces.0.mentioned",
    ]);
  },
);

Deno.test(
  "pipeline W2.16: an `elementById` write stays uncertified (unbounded)",
  async () => {
    // `elementById` addresses a separately derived entity, so the analysis
    // cannot bound the write to a param-anchored envelope — it must fail closed
    // rather than emit an under-declared materializer bound.
    const root = await transform(
      `import { lift, type Cell } from "commonfabric";
interface Item { backlinks: unknown[]; }
export const byId = lift(
  (input: { items: { elementById(id: string): Cell<Item> } }) => {
    input.items.elementById("x").key("backlinks").set([]);
  },
);`,
    );
    assertEquals(certifiedLiftCount(root), 0);
  },
);

Deno.test(
  "pipeline W2.16: a dynamic array-index `[i]` write stays uncertified (unbounded)",
  async () => {
    // A raw `items[i]` element access is not a `.key(index)` keyed descent, so
    // the analysis leaves its write unbounded and fails closed — only the
    // explicit materializer idiom certifies.
    const root = await transform(
      `import { lift, type Cell } from "commonfabric";
interface Item { backlinks: unknown[]; }
export const byIndex = lift((input: { items: Cell<Item>[] }) => {
  for (let i = 0; i < input.items.length; i++) {
    const c = input.items[i];
    c.key("backlinks").set([]);
  }
});`,
    );
    assertEquals(certifiedLiftCount(root), 0);
  },
);

Deno.test(
  "pipeline W2.16: read-only `.key(i)` wildcard stays uncertified (no write)",
  async () => {
    // A bounded `.key(i)` descent that only READS declares no write envelope,
    // so it keeps the W2.12 boundary: a wildcard with no write does not certify
    // (its dynamic reads are admitted at runtime by C0 instead).
    const root = await transform(
      `import { lift, type Cell } from "commonfabric";
interface Item { mentioned: Item[]; }
export const readOnly = lift((input: { items: Cell<Item>[] }) => {
  let n = 0;
  for (const c of input.items) {
    const ms = c.key("mentioned").get() ?? [];
    for (let i = 0; i < ms.length; i++) {
      if (c.key("mentioned").key(i).get()) n++;
    }
  }
  return n;
});`,
    );
    assertEquals(certifiedLiftCount(root), 0);
  },
);

Deno.test(
  "pipeline W2.13: recursive-helper lift (computeMentionable shape) does NOT certify",
  async () => {
    // backlinks-index computeMentionable shape: a nested recursive helper that
    // passes a cell reached through a dynamic `.key(i)` into itself. The
    // interprocedural certificate analysis follows the helper and surfaces the
    // wildcard/recursion, so a write-free-looking body still fails closed
    // statically (W2.14 admits it at runtime instead).
    const root = await transform(
      `import { lift, type Cell } from "commonfabric";
interface Node { children: Node[]; }
export const flatten = lift((input: { roots: Cell<Node>[] }) => {
  const out: Cell<Node>[] = [];
  function collect(node: Cell<Node>, depth: number) {
    if (depth > 5) return;
    const value = node.get();
    if (!value) return;
    out.push(node);
    const kids = node.key("children").get() ?? [];
    for (let i = 0; i < kids.length; i++) {
      collect(node.key("children").key(i), depth + 1);
    }
  }
  for (const root of input.roots) collect(root, 0);
  return out;
});`,
    );
    assertEquals(certifiedLiftCount(root), 0);
  },
);
