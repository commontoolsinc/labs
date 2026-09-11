// The served lifecycle verbs, end to end: a serving host over a real
// in-process memory server runs each verb on the space's serving runtime,
// and a client runtime opened afterwards reads what the verb left in the
// store. What is pinned is the store's state, never the serving runtime's
// own view of it.

import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { createSession, Identity, type Session } from "@commonfabric/identity";
import type { DID, MemorySpace } from "@commonfabric/memory/interface";
import * as MemoryV2Server from "@commonfabric/memory/v2/server";
import {
  getPatternIdentityRef,
  getPieceSourceRevisions,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { ExecutorHost } from "@commonfabric/runner/executor/host";
import { LoopbackStorageManager } from "@commonfabric/runner/executor/loopback-storage";
import { EmulatedStorageManager } from "@commonfabric/runner/storage/cache.deno";
import { loadVerifiedSourceClosure } from "../../runner/src/compilation-cache/cell-cache.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";
import { pieceId } from "../src/piece-id.ts";
import { resolveSlugTargetCell } from "../src/slugs.ts";
import {
  confirmServedInstantiate,
  confirmServedSetSource,
  servedInstantiatePiece,
  ServedLifecycleRefusal,
  type ServedPatternSource,
  servedSetPieceSource,
  type ServedSetSourceRequest,
  servedUploadPattern,
} from "../src/ops/served-lifecycle.ts";

const spaceSigner = await Identity.fromPassphrase("served lifecycle space");
const space = spaceSigner.did() as MemorySpace;
const serviceSigner = await Identity.fromPassphrase(
  "served lifecycle service",
);
const aliceSigner = await Identity.fromPassphrase("served lifecycle alice");

const TEST_AUDIENCE = "did:key:z6Mk-served-lifecycle-audience";

function programOf(contents: string): RuntimeProgram {
  return { main: "/main.tsx", files: [{ name: "/main.tsx", contents }] };
}

/** One optional input, one output. */
const BASE_PROGRAM = programOf([
  "import { NAME, pattern } from 'commonfabric';",
  "export default pattern<{ seed?: string }, { label: string }>(",
  "  ({ seed }) => ({",
  "    [NAME]: 'Served lifecycle',",
  "    label: seed ?? 'unset',",
  "  }),",
  ");",
  "",
].join("\n"));

const BROKEN_PROGRAM = programOf(
  "import { pattern } from 'commonfabric';\nexport default pattern<{}, {}>(() => ({ label: undefinedName }));\n",
);

/** `BASE_PROGRAM` with its `seed` argument narrowed to a number. */
const NUMERIC_SEED_PROGRAM = programOf([
  "import { NAME, pattern } from 'commonfabric';",
  "export default pattern<{ seed?: number }, { label: string }>(",
  "  ({ seed }) => ({",
  "    [NAME]: 'Served lifecycle',",
  "    label: seed === undefined ? 'unset' : String(seed),",
  "  }),",
  ");",
  "",
].join("\n"));

/**
 * A handler whose write is authorized by its own module, over a field it
 * binds — the shape a source update must carry writer authority across.
 */
function authorizedWriterProgram(version: string): RuntimeProgram {
  return {
    main: "/app/main.tsx",
    files: [
      {
        name: "/app/main.tsx",
        contents: `/// <cts-enable />
import {
  handler,
  pattern,
  Writable,
  WriteAuthorizedBy,
} from "commonfabric";
import { revision } from "../shared/revision.ts";

const setName = handler<
  { name: string },
  { name: Writable<string> }
>((event, state) => {
  state.name.set(revision + ":" + event.name);
});

export default pattern<{ seed?: string }>(() => {
  const name = new Writable<
    WriteAuthorizedBy<string, typeof setName>
  >("initial").for("name");
  return { name, setName: setName({ name }) };
});
`,
      },
      {
        name: "/shared/revision.ts",
        contents: `/// <cts-enable />
export const revision = ${JSON.stringify(version)};
`,
      },
    ],
  };
}

describe("served lifecycle verbs", () => {
  let server: MemoryV2Server.Server;
  let host: ExecutorHost;
  let session: Session;
  let cleanups: Array<() => Promise<void>>;

  beforeEach(async () => {
    server = new MemoryV2Server.Server({
      store: new URL(`memory://served-lifecycle-${crypto.randomUUID()}`),
      authorizeSessionOpen(message) {
        const principal = (message.authorization as { principal?: unknown })
          ?.principal;
        return typeof principal === "string" ? principal : undefined;
      },
      sessionOpenAuth: { audience: TEST_AUDIENCE },
      subscriptionRefreshDelayMs: 0,
    });
    session = await createSession({
      identity: serviceSigner,
      spaceDid: space as DID,
    });
    host = new ExecutorHost({
      server,
      serviceIdentity: serviceSigner.did(),
      createRuntime: (servedSpace) => {
        const manager = LoopbackStorageManager.connect(server, {
          as: serviceSigner,
          servingHomeSpace: servedSpace,
        });
        const runtime = new Runtime({
          apiUrl: new URL(import.meta.url),
          storageManager: manager,
          servingPosture: true,
          experimental: { serverExecution: true },
        });
        return Promise.resolve({
          runtime,
          dispose: async () => {
            await runtime.dispose();
            await manager.close();
          },
        });
      },
      policy: { flushDeadlineMs: 5_000, idleParkMs: 600_000 },
      ensureSpaceRoots: false,
    });
    cleanups = [];
  });

  afterEach(async () => {
    await host.close();
    for (const cleanup of cleanups.reverse()) await cleanup();
    await server.close();
  });

  /** A client's view of the space, opened as alice after the verb ran. */
  const clientPieces = async (): Promise<PiecesController> => {
    const manager = EmulatedStorageManager.connectTo(server, {
      as: aliceSigner,
    });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager: manager,
      experimental: { serverExecution: true },
    });
    cleanups.push(async () => {
      await runtime.dispose();
      await manager.close();
    });
    const pieces = new PiecesController(session, runtime, {
      deferSpaceCellSync: true,
    });
    await pieces.ready;
    return pieces;
  };

  const served = <T>(
    name: string,
    run: (pieces: PiecesController) => Promise<T>,
    confirm?: (runtime: Runtime, receipt: T) => Promise<void>,
  ): Promise<T> =>
    host.runLifecycleVerb(space, {
      name,
      run: (runtime) =>
        run(
          new PiecesController(session, runtime, { deferSpaceCellSync: true }),
        ),
      ...(confirm === undefined ? {} : { confirm }),
    });

  const instantiate = (
    source: ServedPatternSource,
    argument?: object,
    naming: { slug?: string; force?: boolean; register?: boolean } = {},
  ) =>
    served(
      "instantiate",
      (pieces) =>
        servedInstantiatePiece(pieces, {
          source,
          ...(argument === undefined ? {} : { argument }),
          ...naming,
          actingUser: aliceSigner.did(),
        }),
      (runtime, receipt) => confirmServedInstantiate(runtime, space, receipt),
    );

  const refusalOf = async (work: Promise<unknown>) => {
    try {
      await work;
    } catch (error) {
      expect(error).toBeInstanceOf(ServedLifecycleRefusal);
      return error as ServedLifecycleRefusal;
    }
    throw new Error("expected a refusal");
  };

  describe("instantiate", () => {
    it("creates a piece a later client reads with the pattern pointer and argument the verb wrote", async () => {
      const receipt = await instantiate({ program: BASE_PROGRAM }, {
        seed: "planted",
      });
      expect(receipt.pattern.symbol).toBe("default");

      const pieces = await clientPieces();
      const piece = await pieces.get(receipt.pieceId);
      expect(getPatternIdentityRef(piece.getCell())).toEqual(receipt.pattern);
      const argument = pieces.getArgument<{ seed?: string }>(piece.getCell());
      await argument.sync();
      expect(argument.get()).toEqual({ seed: "planted" });
      expect(getPieceSourceRevisions(piece.getCell())).toHaveLength(1);
      expect(host.stats().lifecycleVerbs).toEqual({ runs: 1, failures: 0 });
    });

    it("takes a pattern an earlier upload left in the space", async () => {
      const { ref } = await served(
        "upload",
        (pieces) => servedUploadPattern(pieces, BASE_PROGRAM),
      );
      const receipt = await instantiate({ pattern: ref });
      expect(receipt.pattern).toEqual(ref);
      const pieces = await clientPieces();
      const piece = await pieces.get(receipt.pieceId);
      expect(getPatternIdentityRef(piece.getCell())).toEqual(ref);
    });

    it("refuses a pattern the space does not hold", async () => {
      const refusal = await refusalOf(instantiate({
        pattern: { identity: "no-such-identity", symbol: "default" },
      }));
      expect(refusal.code).toBe("pattern-not-found");
    });

    it("claims the slug with the creation, refuses a taken name, and takes it under force", async () => {
      const first = await instantiate({ program: BASE_PROGRAM }, undefined, {
        slug: "named-piece",
      });
      expect(first.slug).toBe("named-piece");
      const pieces = await clientPieces();
      expect(pieceId(await resolveSlugTargetCell(pieces, "named-piece")))
        .toBe(first.pieceId);

      const refusal = await refusalOf(
        instantiate({ program: BASE_PROGRAM }, undefined, {
          slug: "named-piece",
        }),
      );
      expect(refusal.code).toBe("slug-taken");
      expect(refusal.message).toContain("nothing was created");

      const taken = await instantiate({ program: BASE_PROGRAM }, undefined, {
        slug: "named-piece",
        force: true,
      });
      // A client opened after the forced claim: the earlier one holds the
      // name's document from before it moved.
      const later = await clientPieces();
      expect(pieceId(await resolveSlugTargetCell(later, "named-piece")))
        .toBe(taken.pieceId);
    });

    it("refuses to register a piece in a space with no root", async () => {
      const refusal = await refusalOf(
        instantiate({ program: BASE_PROGRAM }, undefined, { register: true }),
      );
      expect(refusal.code).toBe("no-space-root");
    });

    it("refuses a program that does not compile, naming the failure", async () => {
      const refusal = await refusalOf(instantiate({ program: BROKEN_PROGRAM }));
      expect(refusal.code).toBe("compile-failed");
      expect(refusal.message).toContain("undefinedName");
      expect(host.stats().lifecycleVerbs).toEqual({ runs: 1, failures: 1 });
    });
  });

  describe("setsrc", () => {
    // The served source update commits its setup transaction directly to
    // the store, outside the cycle's wave, so the update's module authority
    // registers from a durable verdict on the serving runtime and a later
    // runtime reads it from the stored closure.

    // A program is uploaded as a verb of its own, the way the route does
    // it, so its closure is durable before the update reads it.
    const patternOf = async (source: ServedPatternSource) =>
      source.pattern ?? (await served(
        "upload",
        (pieces) => servedUploadPattern(pieces, source.program),
      )).ref;

    const setSource = async (
      pieceId: string,
      source: ServedPatternSource,
      options: Omit<
        ServedSetSourceRequest,
        "pieceId" | "pattern" | "actingUser"
      > = {},
    ) => {
      const pattern = await patternOf(source);
      return await served(
        "setsrc",
        (pieces) =>
          servedSetPieceSource(pieces, {
            pieceId,
            pattern,
            ...options,
            actingUser: aliceSigner.did(),
          }),
        (runtime, receipt) => confirmServedSetSource(runtime, space, receipt),
      );
    };

    it("replaces the source a later client reads, with the revision the receipt names, and authorizes the successor over the predecessor", async () => {
      const created = await instantiate({
        program: authorizedWriterProgram("v1"),
      });
      const candidate = await patternOf({
        program: authorizedWriterProgram("v2"),
      });
      // Registered on the serving runtime from the committed transaction:
      // read inside the verb, before the cycle's wave could commit.
      let granted: boolean | undefined;
      const receipt = await served(
        "setsrc",
        async (pieces) => {
          const receipt = await servedSetPieceSource(pieces, {
            pieceId: created.pieceId,
            pattern: candidate,
            actingUser: aliceSigner.did(),
          });
          granted = pieces.runtime.grantsModuleDelegation(
            space,
            receipt.pattern.identity,
            created.pattern.identity,
          );
          return receipt;
        },
        (runtime, receipt) => confirmServedSetSource(runtime, space, receipt),
      );
      expect(receipt.pieceId).toBe(created.pieceId);
      expect(receipt.pattern.identity).not.toBe(created.pattern.identity);
      expect(receipt.detachedOrigin).toBeNull();
      expect(granted).toBe(true);

      const pieces = await clientPieces();
      const piece = await pieces.get(receipt.pieceId);
      expect(getPatternIdentityRef(piece.getCell())).toEqual(receipt.pattern);
      const revisions = getPieceSourceRevisions(piece.getCell());
      expect(revisions.at(-1)?.revisionId).toBe(receipt.revisionId);
      expect(revisions.at(-1)?.pattern).toEqual(receipt.pattern);
      // The stored closure carries the delegation a fresh runtime registers
      // from.
      const tx = pieces.runtime.edit();
      try {
        const closure = await loadVerifiedSourceClosure(
          pieces.runtime,
          space,
          receipt.pattern.identity,
          tx,
        );
        expect(
          closure?.get(receipt.pattern.identity)?.delegatedModuleIdentities,
        ).toContain(created.pattern.identity);
      } finally {
        tx.abort();
      }
      expect(host.stats().lifecycleVerbs).toEqual({ runs: 3, failures: 0 });
    });

    it("refuses a source whose argument schema is not backward compatible, and applies it under the dangerous override", async () => {
      // Created without a seed, so the stored argument satisfies either
      // schema and only the declared contract stands between the two.
      const created = await instantiate({ program: BASE_PROGRAM });
      const refusal = await refusalOf(
        setSource(created.pieceId, { program: NUMERIC_SEED_PROGRAM }),
      );
      expect(refusal.code).toBe("incompatible");
      expect(refusal.message).toContain("not backward compatible");
      const unchanged = await clientPieces();
      expect(
        getPatternIdentityRef((await unchanged.get(created.pieceId)).getCell()),
      ).toEqual(created.pattern);

      const receipt = await setSource(
        created.pieceId,
        { program: NUMERIC_SEED_PROGRAM },
        { dangerouslyAllowIncompatibleSchema: true },
      );
      const pieces = await clientPieces();
      expect(
        getPatternIdentityRef((await pieces.get(created.pieceId)).getCell()),
      ).toEqual(receipt.pattern);
    });

    it("refuses a piece the space does not hold", async () => {
      const refusal = await refusalOf(
        setSource("no-such-piece", { program: BASE_PROGRAM }),
      );
      expect(refusal.code).toBe("piece-not-found");
    });

    it("refuses an update proved against a pattern the piece is no longer on", async () => {
      const created = await instantiate({ program: BASE_PROGRAM });
      const refusal = await refusalOf(
        setSource(created.pieceId, { program: BASE_PROGRAM }, {
          expectedPattern: { identity: "elsewhere", symbol: "default" },
        }),
      );
      expect(refusal.code).toBe("source-moved");
    });

    it("refuses a pattern the space does not hold", async () => {
      const created = await instantiate({ program: BASE_PROGRAM });
      const refusal = await refusalOf(
        setSource(created.pieceId, {
          pattern: { identity: "no-such-identity", symbol: "default" },
        }),
      );
      expect(refusal.code).toBe("pattern-not-found");
    });

    it("reports the refresh as deferred on the receipt the served update is built on", async () => {
      // The served option on the client's own runtime: the commit is the
      // store's as always there, and the piece is left to whoever runs it.
      const created = await instantiate({ program: BASE_PROGRAM });
      const candidate = await patternOf({ program: NUMERIC_SEED_PROGRAM });
      const pieces = await clientPieces();
      const pattern = await pieces.runtime.patternManager
        .loadPatternByIdentity(candidate.identity, candidate.symbol, space);
      const piece = await pieces.get(created.pieceId);
      const receipt = await piece.setCompiledPattern(pattern!, {
        dangerouslyAllowIncompatibleSchema: true,
        served: { actingUser: aliceSigner.did() },
      });
      expect(receipt.status).toBe("committed");
      expect(receipt.refresh).toEqual({ status: "deferred" });
      expect(getPatternIdentityRef(piece.getCell())).toEqual(receipt.ref);
    });
  });
});
