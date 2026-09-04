/**
 * The naming tool over a handle the run holds: registry join plus slug
 * assignment, the pre-flight availability rules ported from the days when
 * `run_pattern` carried a `register` option, and the boundary refusals — a
 * token that is not a piece, a position inside one, another space's
 * reference.
 */

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";

import { expect } from "@std/expect";
import { normalize } from "@std/path/posix";
import { createSession, Identity } from "@commonfabric/identity";
import {
  assignSlug,
  resolvePieceAddress,
  resolveSlugTarget,
  setSlugLink,
} from "@commonfabric/piece";
import { PiecesController } from "@commonfabric/piece/ops";
import {
  entityIdFrom,
  getEntityId,
  Runtime,
  slugIdForSpace,
} from "@commonfabric/runner";
import { parseLLMFriendlyLink } from "@commonfabric/runner/shared";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { CfHarnessEngine } from "../src/engine.ts";
import {
  type AssignSlugToolErrorOutput,
  type AssignSlugToolSuccessOutput,
  namedPieceUrl,
} from "../src/tools/assign-slug.ts";
import type { RunPatternToolSuccessOutput } from "../src/tools/run-pattern.ts";
import type {
  SandboxCommandRequest,
  SandboxCommandResult,
  SandboxRuntime,
  SandboxRuntimeDescription,
  SandboxShellRequest,
} from "../src/sandbox/types.ts";

const signer = await Identity.fromPassphrase("cf-harness assign-slug tool");

const DOUBLING_PATTERN_SOURCE = [
  "import { computed, pattern } from 'commonfabric';",
  "interface Input { n: number; }",
  "interface Output { doubled: number; }",
  "export default pattern<Input, Output>(({ n }) => ({",
  "  doubled: computed(() => n * 2),",
  "}));",
  "",
].join("\n");

const DEFAULT_PATTERN_SOURCE = [
  "import { handler, pattern, type Cell, type Stream } from 'commonfabric';",
  "const addPiece = handler<{ piece: unknown }, { pieceRegistry: Cell<unknown[]> }>(",
  "  true,",
  "  { type: 'object', properties: { pieceRegistry: { type: 'array', asCell: ['cell'] } } },",
  "  ({ piece }, { pieceRegistry }) => {",
  "    pieceRegistry.push(piece);",
  "  },",
  ");",
  "export default pattern<",
  "  { pieceRegistry: unknown[] },",
  "  { pieceRegistry: unknown[]; addPiece: Stream<{ piece: unknown }> }",
  ">(({ pieceRegistry }) => ({",
  "  pieceRegistry,",
  "  addPiece: addPiece({ pieceRegistry }),",
  "}));",
].join("\n");

class FakeSandboxRuntime implements SandboxRuntime {
  describe(): SandboxRuntimeDescription {
    return {
      kind: "docker-runsc-cfc",
      defaultWorkingDirectory: this.defaultWorkingDirectory(),
      cfc: { runtimeRequested: true, workspaceMountPath: "/workspace" },
    };
  }
  resolvePath(path: string, cwd = this.defaultWorkingDirectory()): string {
    return normalize(path.startsWith("/") ? path : `${cwd}/${path}`);
  }
  isPathWithinWorkspace(path: string): boolean {
    return path === "/workspace" || path.startsWith("/workspace/");
  }
  isPathWithinAllowedRoots(path: string): boolean {
    return this.isPathWithinWorkspace(path);
  }
  defaultWorkingDirectory(): string {
    return "/workspace";
  }
  run(_request: SandboxCommandRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
  runShell(_request: SandboxShellRequest): Promise<SandboxCommandResult> {
    return Promise.resolve({ stdout: "", stderr: "", exitCode: 0 });
  }
}

describe("assign-slug", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    originalFetch = globalThis.fetch;
    const patternFetch: typeof globalThis.fetch = () =>
      Promise.resolve(
        new Response(DEFAULT_PATTERN_SOURCE, {
          headers: { "content-type": "text/typescript-jsx" },
        }),
      );
    globalThis.fetch = patternFetch;
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
      fetch: patternFetch,
    });
    pieces = new PiecesController(
      await createSession({
        identity: signer,
        spaceName: `assign-slug-${crypto.randomUUID()}`,
      }),
      runtime,
    );
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
    globalThis.fetch = originalFetch;
  });

  function createEngine() {
    return new CfHarnessEngine({
      sandboxRuntime: new FakeSandboxRuntime(),
      runId: `assign-slug-test-${crypto.randomUUID()}`,
      cfcEnforcementMode: "disabled",
      fabricSessionFactory: () => Promise.resolve({ pieces }),
    });
  }

  async function linkDefaultPattern() {
    const defaultRoot = await pieces.create(DEFAULT_PATTERN_SOURCE, {
      input: { pieceRegistry: [] },
    });
    await pieces.linkDefaultPattern(defaultRoot.getCell());
    await runtime.idle();
    await pieces.synced();
  }

  async function createPiece(
    engine: CfHarnessEngine,
    n = 21,
  ): Promise<RunPatternToolSuccessOutput> {
    const result = await engine.invokeBuiltinTool("run_pattern", {
      sourceText: DOUBLING_PATTERN_SOURCE,
      inputs: { n },
    });
    const output = result.output as RunPatternToolSuccessOutput;
    expect(output.status).toBe("ok");
    return output;
  }

  describe("assignSlugTool", () => {
    it("registers the referenced piece and points the slug at it", async () => {
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);

      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.slug).toBe("doubling-report");
      // The URL is the session's API URL, the space name, and the slug.
      expect(output.url).toContain("http://toolshed.test/");
      expect(output.url).toContain("/doubling-report");
      const registered = await pieces.getRegisteredPieces();
      expect(registered.map((piece) => piece.id)).toEqual([created.pieceId]);
      // The slug resolves to the same piece, so the address a person opens
      // names the piece the handle named rather than merely existing.
      expect(await resolvePieceAddress(pieces, "doubling-report")).toBe(
        created.pieceId,
      );
    });

    it("refuses a slug that already names another piece, leaving the address where it pointed", async () => {
      // Assigning a slug is a blind write, so a second call naming the same
      // slug would repoint an address a person already opens. The refusal is
      // a pre-flight one, so the attempt costs a message and nothing else.
      await linkDefaultPattern();
      const engine = createEngine();
      const first = await createPiece(engine, 21);
      const second = await createPiece(engine, 22);
      const held = await engine.invokeBuiltinTool("assign_slug", {
        token: first.resultRef,
        slug: "doubling-report",
      });
      expect((held.output as AssignSlugToolSuccessOutput).status).toBe("ok");

      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: second.resultRef,
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("doubling-report");
      // The address still names the piece it named before, so the refusal
      // protected the name rather than merely reporting on it.
      expect(await resolvePieceAddress(pieces, "doubling-report")).toBe(
        first.pieceId,
      );
    });

    it("refuses a slug that names a collection, leaving the address where it pointed", async () => {
      // A slug pointing at a cell inside a piece names a collection, which is
      // an address a person opens as much as a piece is. Reading that as an
      // operational failure would report a positive statement about what the
      // space holds as a "try again", and reading it as vacancy would repoint
      // the name.
      await linkDefaultPattern();
      const engine = createEngine();
      const held = await createPiece(engine, 21);
      const taking = await createPiece(engine, 22);
      const cell = pieces.runtime.getCellFromLink(
        parseLLMFriendlyLink(held.resultRef, pieces.getSpace()),
      );
      await cell.sync();
      await setSlugLink(pieces, "doubling-report", cell.key("doubled"));

      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: taking.resultRef,
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("already names a collection");
      expect(output.message).not.toContain("could not establish");
      // The refusal names the caller's own slug and nothing behind it, the
      // way the refusal for a name already taken by a piece does: the address
      // the name resolves to stays trusted-side.
      expect(output.message).not.toContain(held.pieceId);
      // The name still points into the piece it pointed into, so the refusal
      // protected the address rather than merely reporting on it.
      expect(await resolveSlugTarget(pieces, "doubling-report")).toEqual({
        piece: held.pieceId,
        pathInside: ["doubled"],
      });
    });

    it("takes a name whose document points at no piece, which this tool calls free", async () => {
      // The tool's availability rule competes only with pieces and
      // collections, so a name redirecting to a plain document is free here
      // even though the assignment underneath refuses a bound name by
      // default. Forcing is what keeps the two rules from disagreeing.
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);
      const plain = pieces.runtime.getCell(
        pieces.getSpace(),
        { space: pieces.getSpace(), random: "plain" },
      );
      await pieces.runtime.editWithRetry((tx) => {
        plain.withTx(tx).set({ value: 1 });
      });
      await setSlugLink(pieces, "doubling-report", plain);

      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });

      const output = result.output as AssignSlugToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(await resolvePieceAddress(pieces, "doubling-report")).toBe(
        created.pieceId,
      );
    });

    it("answers ok for a slug already pointing at the very piece the token names", async () => {
      // The request is already true, so saying so beats refusing it — a
      // retried call settles on the outcome instead of failing.
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);
      const first = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      expect((first.output as AssignSlugToolSuccessOutput).status).toBe("ok");

      const again = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      const output = again.output as AssignSlugToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.slug).toBe("doubling-report");
    });

    it("registers an unlisted piece whose slug already points at it", async () => {
      // A slug can point at a piece the registry does not list — a
      // pre-existing name, or a naming interrupted between its two steps.
      // The idempotent answer still delivers the contract's other half.
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);
      const cell = pieces.runtime.getCellFromLink(
        // The resultRef names the piece cell itself.
        parseLLMFriendlyLink(created.resultRef, pieces.getSpace()),
      );
      await cell.sync();
      await assignSlug(pieces, cell, "doubling-report");
      expect(await pieces.getRegisteredPieces()).toEqual([]);

      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolSuccessOutput;
      expect(output.status).toBe("ok");
      const registered = await pieces.getRegisteredPieces();
      expect(registered.map((piece) => piece.id)).toEqual([created.pieceId]);
    });

    it("initializes the space when an already-named piece has no registry to join", async () => {
      const engine = createEngine();
      const created = await createPiece(engine);
      const cell = pieces.runtime.getCellFromLink(
        parseLLMFriendlyLink(created.resultRef, pieces.getSpace()),
      );
      await cell.sync();
      await assignSlug(pieces, cell, "doubling-report");

      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(await pieces.getDefaultPattern(false)).toBeDefined();
      const registered = await pieces.getRegisteredPieces();
      expect(registered.map((piece) => piece.id)).toEqual([created.pieceId]);
    });

    it("reports an initialization failure while listing an already-named piece", async () => {
      const engine = createEngine();
      const created = await createPiece(engine);
      const cell = pieces.runtime.getCellFromLink(
        parseLLMFriendlyLink(created.resultRef, pieces.getSpace()),
      );
      await cell.sync();
      await assignSlug(pieces, cell, "doubling-report");
      const originalEnsureDefaultPattern = pieces.ensureDefaultPattern;
      pieces.ensureDefaultPattern = () =>
        Promise.reject(new Error("space root unavailable"));

      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      pieces.ensureDefaultPattern = originalEnsureDefaultPattern;

      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("failed while listing");
      expect(output.message).toContain("space root unavailable");
    });

    it("does not list the piece twice when retried after a failed assignment", async () => {
      // A first call can join the registry and then fail at the slug write.
      // The retry must settle the name without appending a second entry.
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);

      const originalGetSpace = pieces.getSpace.bind(pieces);
      const originalAdd = pieces.add.bind(pieces);
      pieces.add = async (cells) => {
        await originalAdd(cells);
        // The join has landed; make the assignment that follows fail once.
        pieces.getSpace = () => {
          pieces.getSpace = originalGetSpace;
          throw new Error("slug assignment refused");
        };
      };
      const first = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      pieces.add = originalAdd;
      pieces.getSpace = originalGetSpace;
      const failed = first.output as AssignSlugToolErrorOutput;
      expect(failed.status).toBe("error");
      expect(failed.message).toContain("failed while naming");

      const retry = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      expect((retry.output as AssignSlugToolSuccessOutput).status).toBe("ok");
      const registered = await pieces.getRegisteredPieces();
      expect(registered.map((piece) => piece.id)).toEqual([created.pieceId]);
      expect(await resolvePieceAddress(pieces, "doubling-report")).toBe(
        created.pieceId,
      );
    });

    it("reports a structured error when the referenced piece cannot be loaded", async () => {
      // A storage or connection failure while loading the referent is the
      // tool's answer to give, not an exception to escape with.
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);
      const originalGetCellFromLink = pieces.runtime.getCellFromLink.bind(
        pieces.runtime,
      );
      pieces.runtime.getCellFromLink = ((
        ...args: Parameters<Runtime["getCellFromLink"]>
      ) => {
        const cell = originalGetCellFromLink(...args);
        (cell as unknown as { sync: () => Promise<unknown> }).sync = () =>
          Promise.reject(new Error("storage unavailable"));
        return cell;
        // deno-lint-ignore no-explicit-any
      }) as any;
      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      pieces.runtime.getCellFromLink = originalGetCellFromLink;
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("could not load the referenced piece");
      expect(output.message).toContain("storage unavailable");
    });

    it("refuses when the slug's availability could not be established, assigning nothing", async () => {
      // A resolution that fails operationally — storage error, sync that
      // never landed — says nothing about what the slug holds. Reading it as
      // vacancy would send the call on to the blind assignment the
      // availability check exists to prevent.
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);

      // The slug document's own cell, so only its sync fails and every other
      // cell the call reaches behaves normally.
      const slugEntity = JSON.stringify(
        entityIdFrom(slugIdForSpace(pieces.getSpace(), "doubling-report")),
      );
      const originalGetCell = runtime.getCellFromEntityId.bind(runtime);
      let syncFailures = 0;
      runtime.getCellFromEntityId = ((
        ...args: Parameters<Runtime["getCellFromEntityId"]>
      ) => {
        const cell = originalGetCell(...args);
        if (JSON.stringify(args[1]) !== slugEntity) {
          return cell;
        }
        (cell as unknown as { sync: () => Promise<unknown> }).sync = () => {
          syncFailures += 1;
          return Promise.reject(new Error("storage unavailable"));
        };
        return cell;
      }) as Runtime["getCellFromEntityId"];

      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      runtime.getCellFromEntityId = originalGetCell;

      // The injected failure really was the slug resolution's, so the
      // refusal below answers it rather than something else going wrong.
      expect(syncFailures).toBe(1);
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("could not establish");
      expect(output.message).toContain("doubling-report");
      expect(output.message).not.toContain("already names another piece");
      expect(await pieces.getRegisteredPieces()).toEqual([]);
    });

    it("returns the slug without a URL when the session's space is configured by DID", async () => {
      // A space configured by `did:key` has no name to put in a URL, and the
      // only address available would carry the space DID — a bare fabric
      // identifier that does not cross the model boundary. The slug still
      // reaches the model, because it is the caller's own word.
      const spaceIdentity = await signer.derive(
        `assign-slug-did-${crypto.randomUUID()}`,
      );
      const didPieces = new PiecesController(
        await createSession({
          identity: signer,
          spaceDid: spaceIdentity.did(),
        }),
        runtime,
      );
      await didPieces.synced();
      expect(didPieces.getSpaceName()).toBeUndefined();
      const defaultRoot = await didPieces.create(DEFAULT_PATTERN_SOURCE, {
        input: { pieceRegistry: [] },
      });
      await didPieces.linkDefaultPattern(defaultRoot.getCell());
      await runtime.idle();
      await didPieces.synced();
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: `assign-slug-test-${crypto.randomUUID()}`,
        cfcEnforcementMode: "disabled",
        fabricSessionFactory: () => Promise.resolve({ pieces: didPieces }),
      });
      const created = await engine.invokeBuiltinTool("run_pattern", {
        sourceText: DOUBLING_PATTERN_SOURCE,
        inputs: { n: 21 },
      });
      const piece = created.output as RunPatternToolSuccessOutput;
      expect(piece.status).toBe("ok");

      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: piece.resultRef,
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(output.slug).toBe("doubling-report");
      expect(output.url).toBeUndefined();
      // The naming really happened, so the missing URL is a refusal to
      // compose one rather than an assignment that did not take place.
      expect(await resolvePieceAddress(didPieces, "doubling-report")).toBe(
        piece.pieceId,
      );
    });

    it("returns an error for an unusable slug, assigning nothing", async () => {
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);
      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "Not A Slug!",
      });
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("slug is invalid");
      expect(await pieces.getRegisteredPieces()).toEqual([]);
    });

    it("returns an error when the slug is not a string", async () => {
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);
      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: 7 as unknown as string,
      });
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("string slug");
    });

    it("refuses a token naming a position inside a piece rather than the piece itself", async () => {
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);
      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: `${created.resultRef}/doubled`,
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("not a position inside one");
      expect(await pieces.getRegisteredPieces()).toEqual([]);
    });

    it("refuses a token whose document is not a piece", async () => {
      await linkDefaultPattern();
      const engine = createEngine();
      // A document that exists but carries no pattern identity: an ordinary
      // data cell is not a piece and naming it would put a dead entry in the
      // piece list.
      const cell = runtime.getCell<Record<string, unknown>>(
        pieces.getSpace(),
        `assign-slug-plain-${crypto.randomUUID()}`,
      );
      const { error } = await runtime.editWithRetry((tx) => {
        cell.withTx(tx).set({ n: 1 });
      });
      expect(error).toBeUndefined();
      const link = cell.getAsNormalizedFullLink();
      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: `/${link.id}`,
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("does not refer to a piece");
      expect(await pieces.getRegisteredPieces()).toEqual([]);
    });

    it("refuses a token naming a reference in another space", async () => {
      await linkDefaultPattern();
      const engine = createEngine();
      const created = await createPiece(engine);
      const otherSpace =
        "did:key:z6MkhaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK";
      const bare = created.resultRef.replace(/^\//, "");
      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: `/@${otherSpace}/${bare}`,
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("own space");
    });

    it("returns an error when the run has no fabric session", async () => {
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: `assign-slug-test-${crypto.randomUUID()}`,
        cfcEnforcementMode: "disabled",
      });
      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: "/of:fid1:abc",
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("requires a fabric session");
    });

    it("returns an error for a missing token", async () => {
      await linkDefaultPattern();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("assign_slug", {
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("requires a token");
    });

    it("initializes a fresh space before registering and naming the piece", async () => {
      const engine = createEngine();
      const created = await createPiece(engine);
      expect(await pieces.getDefaultPattern(false)).toBeUndefined();

      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(await pieces.getDefaultPattern(false)).toBeDefined();
      const registered = await pieces.getRegisteredPieces();
      expect(registered.map((piece) => piece.id)).toEqual([created.pieceId]);
      expect(await resolvePieceAddress(pieces, "doubling-report")).toBe(
        created.pieceId,
      );
    });

    it("reports the naming failure when the space root cannot be initialized", async () => {
      const engine = createEngine();
      const created = await createPiece(engine);
      const originalEnsureDefaultPattern = pieces.ensureDefaultPattern;
      pieces.ensureDefaultPattern = () =>
        Promise.reject(new Error("space root unavailable"));

      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      pieces.ensureDefaultPattern = originalEnsureDefaultPattern;

      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("failed while naming");
      expect(output.message).toContain("space root unavailable");
    });

    it("leaves an initialized space root untouched while assigning the slug", async () => {
      await linkDefaultPattern();
      const existingRoot = await pieces.getDefaultPattern(false);
      expect(existingRoot).toBeDefined();
      const existingRootId = getEntityId(existingRoot!);
      const originalEnsureDefaultPattern = pieces.ensureDefaultPattern.bind(
        pieces,
      );
      const originalEditWithRetry = runtime.editWithRetry.bind(runtime);
      let ensureCalls = 0;
      let rootWriteAttempts = 0;
      pieces.ensureDefaultPattern = async () => {
        ensureCalls++;
        runtime.editWithRetry = ((fn, maxRetries) => {
          rootWriteAttempts++;
          return originalEditWithRetry(fn, maxRetries);
        }) as typeof runtime.editWithRetry;
        try {
          return await originalEnsureDefaultPattern();
        } finally {
          runtime.editWithRetry = originalEditWithRetry;
        }
      };

      const engine = createEngine();
      const created = await createPiece(engine);
      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: created.resultRef,
        slug: "doubling-report",
      });
      pieces.ensureDefaultPattern = originalEnsureDefaultPattern;

      const output = result.output as AssignSlugToolSuccessOutput;
      expect(output.status).toBe("ok");
      expect(ensureCalls).toBe(1);
      expect(rootWriteAttempts).toBe(0);
      const rootAfterAssignment = await pieces.getDefaultPattern(false);
      expect(getEntityId(rootAfterAssignment!)).toEqual(existingRootId);
    });

    it("surfaces a rejected session construction as a structured error", async () => {
      const engine = new CfHarnessEngine({
        sandboxRuntime: new FakeSandboxRuntime(),
        runId: `assign-slug-test-${crypto.randomUUID()}`,
        cfcEnforcementMode: "disabled",
        fabricSessionFactory: () =>
          Promise.reject(new Error("authorization denied")),
      });
      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: "/of:fid1:abc",
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain(
        "could not establish the fabric session",
      );
      expect(output.message).toContain("authorization denied");
    });

    it("composes no URL when the session's API URL cannot carry one", () => {
      // The URL guard fails closed: a session whose API URL does not parse
      // yields no link rather than a broken one.
      const broken = {
        getSpaceName: () => "demo",
        runtime: { apiUrl: "http://[invalid" },
      } as unknown as Parameters<typeof namedPieceUrl>[0];
      expect(namedPieceUrl(broken, "doubling-report")).toBeUndefined();
    });

    it("returns an error for a token that does not parse as a reference", async () => {
      await linkDefaultPattern();
      const engine = createEngine();
      const result = await engine.invokeBuiltinTool("assign_slug", {
        token: "not a reference at all",
        slug: "doubling-report",
      });
      const output = result.output as AssignSlugToolErrorOutput;
      expect(output.status).toBe("error");
      expect(output.message).toContain("does not name a reference");
    });
  });
});
