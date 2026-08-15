import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { dirname, join } from "@std/path";
import type { JSONSchema } from "@commonfabric/api";
import type { Cell } from "@commonfabric/runner";
import {
  type ExecutedMountedCallableFile,
  executeMountedCallableFile,
} from "../lib/exec.ts";
import { renderExecOutcome } from "../commands/exec.ts";
import { writeMountState } from "../lib/fuse.ts";
import { CF_RUNTIME_ERROR_LOG } from "../lib/callable.ts";
import {
  type CellSelection,
  parseCellSelectionOptions,
} from "../lib/cell-selection.ts";
import { cf, isIgnorableDenoWarningLine } from "./utils.ts";

/**
 * `cf exec`'s read options and the shape it emits.
 *
 * The end-to-end proof that a selection reaching this arrival actually shapes
 * the value lives in test/read-options-four-ways.test.ts, which drives exec
 * against a real runtime beside the other three arrivals. What is asserted
 * here is the wiring either side of that step: that the caller's selection
 * reaches it at all from both callable kinds, and that what exec writes is the
 * declared shape rather than prose.
 */
describe("cf exec read options", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await Deno.makeTempDir({ prefix: "cf-exec-read-options-" });
  });

  afterEach(async () => {
    await Deno.remove(tmpDir, { recursive: true });
  });

  /** The slice of `Cell` each callable double below implements. */
  interface CallableCellDouble extends Record<string, unknown> {
    get(): unknown;
    getRaw(): unknown;
  }

  /** A mounted callable file, its `meta.json`, and a live mount state entry. */
  async function mountCallable(name: string): Promise<string> {
    const mountpoint = join(tmpDir, "mount");
    const filePath = join(
      mountpoint,
      `home/pieces/notes/result/${name}`,
    );
    await Deno.mkdir(dirname(filePath), { recursive: true });
    await Deno.writeTextFile(filePath, "");
    await Deno.writeTextFile(
      join(dirname(dirname(filePath)), "meta.json"),
      JSON.stringify({ id: "of:piece-123", name: "Fixture Piece" }),
    );
    await writeMountState(join(tmpDir, "state"), {
      pid: Deno.pid,
      mountpoint,
      apiUrl: "http://localhost:8000",
      identity: "/tmp/test-identity.pem",
      startedAt: "2026-08-15T00:00:00.000Z",
    });
    return filePath;
  }

  /** Minimal doubles around one callable cell. The runtime is a double here:
   * the selection step itself is stubbed through its own seam, and what these
   * assert is what reaches it. */
  function harness(callable: CallableCellDouble, cellKey: string) {
    const rootCell: Record<string, unknown> = {
      schema: undefined,
      get: () => ({ [cellKey]: callable.get() }),
      getRaw: () => ({ [cellKey]: callable.getRaw() }),
      key: () => callable,
      asSchemaFromLinks: () => callable,
    };
    const piece = {
      id: "of:piece-123",
      getCell: () => ({ pull: () => Promise.resolve() }),
      input: { getCell: () => Promise.resolve(rootCell) },
      result: { getCell: () => Promise.resolve(rootCell) },
    };
    const resultCell = {
      get: () => ({ items: [{ id: "a", title: "Alpha", extra: 1 }] }),
      pull: () =>
        Promise.resolve({ items: [{ id: "a", title: "Alpha", extra: 1 }] }),
      key: () => resultCell,
      asSchemaFromLinks: () => resultCell,
      getAsNormalizedFullLink: () => ({
        id: "of:tool-result-cell",
        space: "did:key:test-home",
        scope: "user",
        path: [],
      }),
    };
    const receiptCell = {
      pull: () => Promise.resolve({ title: "Milk" }),
      getRaw: () => ({ title: "Milk" }),
      get: () => ({ title: "Milk" }),
      key: () => receiptCell,
      asSchemaFromLinks: () => receiptCell,
      getAsNormalizedFullLink: () => ({
        id: "of:receipt-cell",
        space: "did:key:test-home",
        scope: "space",
        path: [],
      }),
    };
    const pieces = {
      getSpace: () => "did:key:test-home",
      synced: () => Promise.resolve(),
      runtime: {
        [CF_RUNTIME_ERROR_LOG]: [] as Array<{ message: string }>,
        storageManager: { synced: () => Promise.resolve() },
        edit: () => ({ commit: () => Promise.resolve() }),
        prepareTxForCommit: () => {},
        getCell: () => resultCell,
        getCellFromLink: () => receiptCell,
        run: () => ({ sink: () => () => {} }),
        idle: () => Promise.resolve(),
        settled: () => Promise.resolve(),
      },
    };
    return { pieces, piece, resultCell, receiptCell };
  }

  /** A tool-shaped callable cell double. */
  function toolCell(): CallableCellDouble {
    const inputSchema: JSONSchema = {
      type: "object",
      properties: { query: { type: "string" } },
    };
    const value = {
      pattern: { argumentSchema: inputSchema },
      extraParams: {},
    };
    const cell: CallableCellDouble = {
      schema: {
        type: "object",
        properties: {
          pattern: { type: "object" },
          extraParams: { type: "object" },
        },
      } as JSONSchema,
      get: () => value,
      getRaw: () => value,
      asSchemaFromLinks: () => cell,
      getAsNormalizedFullLink: () => ({
        id: "of:callable-cell",
        space: "did:key:test-home",
        scope: "user",
        path: [],
      }),
    };
    cell.key = (key: string) => ({
      get: () => (value as Record<string, unknown>)[key],
      getRaw: () => (value as Record<string, unknown>)[key],
    });
    return cell;
  }

  /** A handler-shaped callable cell double whose send files a receipt. */
  function handlerCell(): CallableCellDouble {
    const cell: CallableCellDouble = {
      schema: { asCell: ["stream"] } as JSONSchema,
      get: () => ({ $stream: true }),
      getRaw: () => ({ $stream: true }),
      isStream: () => true,
      asSchemaFromLinks: () => cell,
      send: (_value: unknown, onCommit?: (tx: unknown) => void) => {
        onCommit?.({
          status: () => ({ status: "done" }),
          handlingReceiptLink: {
            id: "of:receipt-cell",
            space: "did:key:test-home",
            scope: "space",
            path: [],
          },
        });
      },
    };
    cell.key = () => cell;
    return cell;
  }

  it("hands a tool's selection to the selection step, over the tool's own result cell", async () => {
    const filePath = await mountCallable("search.tool");
    const { pieces, piece, resultCell } = harness(toolCell(), "search");
    const selection = await parseCellSelectionOptions({ select: "items" });
    const seen: Array<{ source: unknown; selection: CellSelection }> = [];

    const result = await executeMountedCallableFile(
      filePath,
      ["--query", "milk"],
      {
        stateDir: join(tmpDir, "state"),
        // deno-lint-ignore no-explicit-any
        loadPieces: () => Promise.resolve(pieces as any),
        // deno-lint-ignore no-explicit-any
        loadPiece: () => Promise.resolve(piece as any),
        deriveSelectedValue: (
          _runtime,
          _space,
          source: Cell<unknown>,
          received: CellSelection,
        ) => {
          seen.push({ source, selection: received });
          return Promise.resolve({ shaped: true });
        },
      },
      { selection: selection! },
    );

    // The caller's own selection, over the cell the tool wrote — not a fresh
    // one, and not the callable cell.
    expect(seen).toHaveLength(1);
    expect(seen[0].selection).toBe(selection);
    expect(seen[0].source).toBe(resultCell as unknown as Cell<unknown>);
    // And the SHAPED value is what reaches stdout. An implementation that
    // handed the selection down and then wrote the unshaped result would pass
    // the two assertions above and fail this one.
    expect(JSON.parse(result.outputText!)).toEqual({ shaped: true });
  });

  it("leaves a tool's output unshaped when no read option is given", async () => {
    const filePath = await mountCallable("search.tool");
    const { pieces, piece } = harness(toolCell(), "search");
    let called = false;

    const result = await executeMountedCallableFile(
      filePath,
      ["--query", "milk"],
      {
        stateDir: join(tmpDir, "state"),
        // deno-lint-ignore no-explicit-any
        loadPieces: () => Promise.resolve(pieces as any),
        // deno-lint-ignore no-explicit-any
        loadPiece: () => Promise.resolve(piece as any),
        deriveSelectedValue: () => {
          called = true;
          return Promise.resolve(undefined);
        },
      },
    );

    expect(called).toBe(false);
    expect(JSON.parse(result.outputText!)).toEqual({
      items: [{ id: "a", title: "Alpha", extra: 1 }],
    });
  });

  it("settles a handler under an invocation of its own, so a result exists to shape", async () => {
    const filePath = await mountCallable("add.handler");
    const { pieces, piece } = harness(handlerCell(), "add");

    const result = await executeMountedCallableFile(
      filePath,
      ["invoke"],
      {
        stateDir: join(tmpDir, "state"),
        // deno-lint-ignore no-explicit-any
        loadPieces: () => Promise.resolve(pieces as any),
        // deno-lint-ignore no-explicit-any
        loadPiece: () => Promise.resolve(piece as any),
        isStdinTerminal: () => true,
      },
    );

    // A dispatch naming no invocation files under no receipt and answers with
    // nothing at all, leaving a read option nothing to be about. The id is
    // minted per call, so the envelope names one and carries the address the
    // handling settled to.
    expect(result.invocation?.status).toBe("settled");
    expect(result.invocation?.id).toBeTruthy();
    expect(result.invocation?.receipt).toEqual({
      id: "of:receipt-cell",
      space: "did:key:test-home",
      scope: "space",
    });
  });

  it("writes a handler's outcome as the Invocation JSON on stdout", () => {
    const out: string[] = [];
    const err: string[] = [];
    renderExecOutcome(
      {
        invocation: {
          id: "inv-1",
          status: "settled",
          result: { title: "Milk" },
        },
        // deno-lint-ignore no-explicit-any
      } as any as ExecutedMountedCallableFile,
      { write: (text) => out.push(text), writeError: (text) => err.push(text) },
    );

    // The envelope `cf piece call` declares, not silence and not prose.
    expect(JSON.parse(out[0])).toEqual({
      invocation: "inv-1",
      status: "settled",
      result: { title: "Milk" },
    });
    expect(err).toEqual([]);
  });

  it("writes a tool's result cell as an address the next command takes", () => {
    const out: string[] = [];
    const err: string[] = [];
    renderExecOutcome(
      {
        outputText: "{}",
        resultRef: {
          id: "of:tool-result",
          space: "did:key:test-home",
          scope: "user",
        },
        // deno-lint-ignore no-explicit-any
      } as any as ExecutedMountedCallableFile,
      { write: (text) => out.push(text), writeError: (text) => err.push(text) },
    );

    // stdout stays exactly the tool's result; the address rides stderr in the
    // `<id>@<scope>` form `--piece` parses, rather than the prose spelling
    // `<id> (space <space>, scope <scope>)` that no command accepts.
    expect(out).toEqual(["{}"]);
    expect(err).toHaveLength(1);
    expect(err[0]).toContain("of:tool-result@user");
    expect(err[0]).toContain("cf piece get --piece of:tool-result@user");
    expect(err[0]).not.toContain("(space ");
  });

  it("writes a space-scoped address bare, which is the form that means space", () => {
    const err: string[] = [];
    renderExecOutcome(
      {
        outputText: "{}",
        resultRef: {
          id: "of:tool-result",
          space: "did:key:test-home",
          scope: "space",
        },
        // deno-lint-ignore no-explicit-any
      } as any as ExecutedMountedCallableFile,
      { write: () => {}, writeError: (text) => err.push(text) },
    );

    expect(err[0]).toContain("cf piece get --piece of:tool-result`)");
    expect(err[0]).not.toContain("@space");
  });

  it("refuses --select beside --schema, which name one projection twice", async () => {
    const { code, stderr } = await cf(
      `exec --select id --schema id ${join(tmpDir, "search.tool")}`,
    );

    expect(code).not.toBe(0);
    const relevant = stderr.filter((line) =>
      !line.includes("deno run ") && !isIgnorableDenoWarningLine(line)
    );
    expect(relevant.join("\n")).toContain("--schema");
    expect(relevant.join("\n")).toContain("--select");
  });
});
