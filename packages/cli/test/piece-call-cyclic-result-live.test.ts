import { describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { type Cell, Runtime } from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { CyclicResultError } from "../lib/callable.ts";
import { parseSelectProjection } from "../lib/cell-selection.ts";
import { executePieceCallable } from "../lib/piece.ts";

/**
 * A work item that carries a back-reference: the doubly-linked shape
 * `docs/common/concepts/self-reference.md` documents, reduced to the two
 * fields that close the circle. `addChild` files a child under this item and
 * hands it back, so the returned piece's `parent` is the container and the
 * container's `children` holds the returned piece.
 *
 * Driven against a COMPILED, RUN pattern rather than a hand-built value,
 * because both halves of what is under test are things the runtime constructs
 * and a double would only assert back. The circle has to be a real one — the
 * same object reached from inside itself, through links the runner resolved —
 * and the bound is derived from a declared result the TRANSFORMER lowered,
 * whose recursion is spelled with `$ref`/`$defs` that no hand-written schema
 * would predict.
 *
 * Three verbs, for the three answers a readback can give:
 *
 * - `addChild` returns the new item, and its declared result re-enters itself.
 * - `addChildSelf` returns the CONTAINER, so the circle closes through a
 *   collection rather than through a single field.
 * - `addChildLoose` returns the same container behind `unknown`, which
 *   declares a shape that bounds nothing.
 */
const PROGRAM = {
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: [
      'import { action, type Default, NAME, pattern, type PatternFactory, SELF, type Stream, Writable } from "commonfabric";',
      "",
      "interface AddChildEvent { title: string; }",
      "interface AddChildResult { item: ItemOutput; }",
      "interface ContainerResult { container: ItemOutput; }",
      "interface LooseResult { container: unknown; }",
      "interface FinishEvent { note: string; }",
      "interface FinishResult { status: string; note: string; }",
      "",
      "export interface ItemOutput {",
      "  addChild: Stream<AddChildEvent, AddChildResult>;",
      "  addChildSelf: Stream<AddChildEvent, ContainerResult>;",
      "  addChildLoose: Stream<AddChildEvent, LooseResult>;",
      "  finish: Stream<FinishEvent, FinishResult>;",
      "  [NAME]: string;",
      "  title: string;",
      "  status: string;",
      "  parent: ItemOutput | null;",
      "  children: ItemOutput[];",
      "}",
      "",
      "interface ItemInput {",
      "  title: string | Default<'Untitled'>;",
      "  parent?: ItemOutput | null | Default<null>;",
      "}",
      "",
      "export const Item: PatternFactory<ItemInput, ItemOutput> = pattern<ItemInput, ItemOutput>(",
      "  ({ title, parent, [SELF]: self }) => {",
      "    const status = new Writable('open');",
      "    const children = new Writable<ItemOutput[]>([]);",
      "    const addChild = action<AddChildEvent, AddChildResult>((event) => {",
      "      const item = Item({ title: event.title, parent: self });",
      "      children.push(item);",
      "      return { item };",
      "    });",
      "    const addChildSelf = action<AddChildEvent, ContainerResult>((event) => {",
      "      children.push(Item({ title: event.title, parent: self }));",
      "      return { container: self };",
      "    });",
      "    const addChildLoose = action<AddChildEvent, LooseResult>((event) => {",
      "      children.push(Item({ title: event.title, parent: self }));",
      "      return { container: self as unknown };",
      "    });",
      "    const finish = action<FinishEvent, FinishResult>((event) => {",
      "      status.set('done');",
      "      return { status: 'done', note: event.note };",
      "    });",
      "    return {",
      "      [NAME]: title,",
      "      title,",
      "      status,",
      "      parent,",
      "      children,",
      "      addChild,",
      "      addChildSelf,",
      "      addChildLoose,",
      "      finish,",
      "    };",
      "  },",
      ");",
      "",
      "export default Item;",
    ].join("\n"),
  }],
};

const CONFIG = {
  apiUrl: "http://localhost:8000",
  identity: "/tmp/test-identity.pem",
  piece: "fid1:live",
  space: "" as string,
};

interface Tracker {
  /** Dispatch `verb` the way `cf piece call` does, under an invocation id so
   * the outcome is read back off the handling's receipt. */
  call: (
    verb: string,
    rawArgs: string[],
    extra?: Record<string, unknown>,
  ) => Promise<unknown>;
  /** How many times a caller reached for the compiled pattern. The declared
   * result is behind it, so this is what a readback pays to bound itself. */
  patternLoads: () => number;
  root: Cell<any>;
}

/** Run the program above as a root item and hand a driver to `body`. */
async function withTracker<T>(
  passphrase: string,
  body: (tracker: Tracker) => Promise<T>,
): Promise<T> {
  const signer = await Identity.fromPassphrase(passphrase);
  const storageManager = StorageManager.emulate({ as: signer });
  const runtime = new Runtime({
    apiUrl: new URL("https://example.com"),
    storageManager,
  });
  const space = signer.did();

  try {
    const compiled = await runtime.patternManager.compilePattern(
      PROGRAM as never,
      { space },
    );
    const tx = runtime.edit();
    const rootCell = runtime.getCell(space, "cyclic-live", undefined, tx);
    const root = runtime.run(tx, compiled, { title: "Root" }, rootCell);
    runtime.prepareTxForCommit(tx);
    expect((await tx.commit()).error).toBeUndefined();
    await root.pull();

    let patternLoads = 0;
    const piece = {
      result: { getCell: () => Promise.resolve(root) },
      input: {
        getCell: () =>
          Promise.resolve(runtime.getCell(space, "cyclic-live-input")),
      },
      getCell: () => root,
      getPattern: () => {
        patternLoads++;
        return Promise.resolve(compiled);
      },
    };
    const deps = {
      loadPieces: () =>
        Promise.resolve({ getSpace: () => space, runtime } as never),
      loadPiece: () => Promise.resolve(piece as never),
    };

    let dispatched = 0;
    return await body({
      root,
      patternLoads: () => patternLoads,
      call: async (verb, rawArgs, extra = {}) => {
        dispatched++;
        const executed = await executePieceCallable(
          { ...CONFIG, space },
          verb,
          rawArgs,
          {
            ...deps,
            invocation: { id: `inv-${dispatched}`, session: "sess" },
            ...extra,
          } as never,
        );
        return executed.invocation?.result;
      },
    });
  } finally {
    await runtime.dispose?.();
    await storageManager.close?.();
  }
}

/** The item titles the root currently files beneath it, read straight off the
 * cell rather than through any rendering, so it says what committed. */
function childTitles(root: Cell<any>): string[] {
  return (root.key("children").get() ?? []).map((child: any) => child.title);
}

describe("cf piece call on a piece that points back at its container", () => {
  it("renders the returned piece, with the back-reference as an address", async () => {
    await withTracker("cyclic-returns-child", async ({ call }) => {
      const result = await call("addChild", [
        "--title",
        "Rotate signing key",
      ]) as any;

      // The whole point: this is what the command writes to stdout, and it
      // used to be the throw.
      expect(() => JSON.stringify(result)).not.toThrow();
      expect(result.item.title).toBe("Rotate signing key");
      expect(result.item.status).toBe("open");
      // `parent` is where the declared type re-enters itself, so it renders an
      // address rather than being followed back into the container. The
      // address names the deepest link the walk crossed plus the segments
      // below it, which is the child's own document and the field on it.
      expect(result.item.parent.$link.id.startsWith("of:")).toBe(true);
      expect(result.item.parent.$link.space.startsWith("did:")).toBe(true);
      expect(result.item.parent.$link.scope).toBe("space");
      expect(result.item.parent.$link.path).toEqual(["parent"]);
      // A stream is a dispatch surface, not a value, and carries nothing to
      // read at the position it occupies.
      expect(Object.hasOwn(result.item, "addChild")).toBe(false);
    });
  });

  it("answers a collection that re-enters with one address per element", async () => {
    await withTracker("cyclic-returns-container", async ({ call }) => {
      await call("addChildSelf", ["--title", "First"]);
      const result = await call("addChildSelf", ["--title", "Second"]) as any;

      expect(() => JSON.stringify(result)).not.toThrow();
      expect(result.container.title).toBe("Root");
      // Each child is addressed by its own document rather than by the slot it
      // sits in, so the answers survive a reordering of the collection.
      const ids = result.container.children.map((child: any) => child.$link.id);
      expect(ids.length).toBe(2);
      expect(new Set(ids).size).toBe(2);
      expect(ids.every((id: string) => id.startsWith("of:"))).toBe(true);
    });
  });

  it("leaves a caller's own selection in charge of the shape", async () => {
    await withTracker("cyclic-explicit-selection", async ({ call }) => {
      const result = await call("addChild", ["--title", "Selected"], {
        selection: { projection: parseSelectProjection("item.title") },
      }) as any;

      // Exactly what was asked for: no derived address anywhere, because the
      // caller's shape is applied to the receipt and leaves no circle behind
      // for anything to bound.
      expect(result).toEqual({ item: { title: "Selected" } });
    });
  });

  it("refuses legibly, naming the committed write, where the declaration bounds nothing", async () => {
    await withTracker("cyclic-undeclared", async ({ call, root }) => {
      const error = await call("addChildLoose", ["--title", "Unbounded"])
        .then(() => undefined, (thrown: unknown) => thrown);

      expect(error).toBeInstanceOf(CyclicResultError);
      const message = (error as Error).message;
      // Where the circle closes, so a caller can see which field to bound.
      expect(message).toContain(
        'closes a circle at "/container/children/0/parent"',
      );
      // The property worth not losing: an unrenderable result is not a failed
      // mutation, and the message says so rather than leaving a stack trace to
      // read as "the call failed".
      expect(message).toContain("COMMITTED");
      expect(message).toContain("cf piece get --piece of:");
      expect(message).toContain("declared result leaves the closing position");

      // And the write did land.
      expect(childTitles(root)).toEqual(["Unbounded"]);
    });
  });

  it("pays for the declared result only where the result will not render", async () => {
    await withTracker(
      "cyclic-pattern-load-cost",
      async ({ call, patternLoads }) => {
        await call("finish", ["--note", "Shipped"]);
        // A result that renders is written out exactly as it was read: nothing
        // is derived, so no compiled pattern is loaded to derive it from.
        expect(patternLoads()).toBe(0);

        await call("addChild", ["--title", "Bounded"]);
        expect(patternLoads()).toBe(1);
      },
    );
  });
});
