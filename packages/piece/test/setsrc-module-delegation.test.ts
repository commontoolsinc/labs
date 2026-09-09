import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { stub } from "@std/testing/mock";
import { createSession, Identity } from "@commonfabric/identity";
import {
  getPatternIdentityRef,
  Runtime,
  type RuntimeProgram,
} from "@commonfabric/runner";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import {
  loadCompiledClosure,
  loadVerifiedSourceClosure,
  setCompileCacheRuntimeVersionForTesting,
} from "../../runner/src/compilation-cache/cell-cache.ts";
import { PiecesController } from "../src/ops/pieces-controller.ts";

const signer = await Identity.fromPassphrase("setsrc module delegation");

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

describe("setsrc module delegation", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;
  let pieces: PiecesController;

  beforeEach(async () => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
    const session = await createSession({
      identity: signer,
      spaceName: "setsrc-delegation-" + crypto.randomUUID(),
    });
    pieces = new PiecesController(session, runtime);
    await pieces.synced();
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("keeps a preview and a rejected setup from publishing successor authority", async () => {
    const piece = await pieces.create(authorizedWriterProgram("v1"), {
      input: {},
    });
    const previous = getPatternIdentityRef(piece.getCell())!;
    const next = authorizedWriterProgram("v2");
    const report = await piece.checkPattern(next);
    expect(report.compatible).toBe(true);
    const delegated = () => {
      const tx = runtime.edit();
      try {
        return tx.getCfcState().moduleDelegations.get(pieces.getSpace())
          ?.get(report.candidate.identity) ?? [];
      } finally {
        tx.abort();
      }
    };
    expect(delegated()).not.toContain(previous.identity);

    const prepare = runtime.prepareTxForCommit.bind(runtime);
    let refusedSetup = false;
    {
      using _rejectSetup = stub(runtime, "prepareTxForCommit", (tx) => {
        const staged = getPatternIdentityRef(piece.getCell().withTx(tx));
        if (staged?.identity === report.candidate.identity) {
          refusedSetup = true;
          expect(
            tx.getCfcState().moduleDelegations.get(pieces.getSpace())
              ?.get(report.candidate.identity),
          ).toContain(previous.identity);
          expect(delegated()).not.toContain(previous.identity);
          tx.abort("injected setup refusal");
          throw new Error("injected setup refusal");
        }
        prepare(tx);
      });
      await expect(piece.setPattern(next)).rejects.toThrow(
        "injected setup refusal",
      );
    }
    expect(refusedSetup).toBe(true);
    expect(getPatternIdentityRef(piece.getCell())).toEqual(previous);
    expect(delegated()).not.toContain(previous.identity);
    const tx = runtime.edit();
    try {
      const closure = await loadVerifiedSourceClosure(
        runtime,
        pieces.getSpace(),
        report.candidate.identity,
        tx,
      );
      expect(
        closure?.get(report.candidate.identity)?.delegatedModuleIdentities ??
          [],
      )
        .not.toContain(previous.identity);
    } finally {
      tx.abort();
    }
    expect(delegated()).not.toContain(previous.identity);

    await piece.setPattern(next);
    expect(delegated()).toContain(previous.identity);
    const result = await piece.result.getCell();
    result.key("setName").send({ name: "accepted" });
    await result.pull();
    expect(await piece.result.get(["name"])).toBe("v2:accepted");
  });

  it("publishes authority only after an incompatible source change is confirmed", async () => {
    const program = (version: string, seedType: string): RuntimeProgram => ({
      main: "/api/patterns/confirm-authority.tsx",
      files: [{
        name: "/api/patterns/confirm-authority.tsx",
        contents: `/// <cts-enable />
import { handler, pattern, Writable, WriteAuthorizedBy } from "commonfabric";
const setName = handler<{name: string}, {name: Writable<string>}>(
  (event, state) => state.name.set(${
          JSON.stringify(version)
        } + ":" + event.name)
);
export default pattern<{seed?: ${seedType}}>(() => {
  const name = new Writable<WriteAuthorizedBy<string, typeof setName>>("initial").for("name");
  return {name, setName: setName({name})};
});`,
      }],
    });
    const piece = await pieces.create(program("old", "string"), { input: {} });
    const previous = getPatternIdentityRef(piece.getCell())!;
    const candidate = program("confirmed", "number");
    using _fetch = stub(globalThis, "fetch", () =>
      Promise.resolve(
        new Response(candidate.files[0].contents, {
          headers: { "content-type": "text/typescript-jsx" },
        }),
      ));
    const action = {
      kind: "repoint" as const,
      url: "system:confirm-authority.tsx",
    };
    const warning = await piece.changeSource(action);
    expect(warning.status).toBe("incompatible");
    if (warning.status !== "incompatible") {
      throw new Error("expected compatibility confirmation");
    }
    const delegated = () => {
      const tx = runtime.edit();
      try {
        return tx.getCfcState().moduleDelegations.get(pieces.getSpace())
          ?.get(warning.prepared.candidate.identity) ?? [];
      } finally {
        tx.abort();
      }
    };
    expect(delegated()).not.toContain(previous.identity);
    expect(
      (await piece.changeSource(action, { confirmedChange: warning.prepared }))
        .status,
    )
      .toBe("applied");
    expect(delegated()).toContain(previous.identity);
    const result = await piece.result.getCell();
    result.key("setName").send({ name: "accepted" });
    await result.pull();
    expect(await piece.result.get(["name"])).toBe("confirmed:accepted");
  });

  it("preserves both predecessor chains when concurrent updates share a successor", async () => {
    const first = await pieces.create(authorizedWriterProgram("a"), {
      input: {},
    });
    const second = await pieces.create(authorizedWriterProgram("b"), {
      input: {},
    });
    const predecessors = [first, second].map((piece) =>
      getPatternIdentityRef(piece.getCell())!.identity
    );
    await Promise.all([
      first.setPattern(authorizedWriterProgram("shared")),
      second.setPattern(authorizedWriterProgram("shared")),
    ]);
    const successor = getPatternIdentityRef(first.getCell())!;
    expect(getPatternIdentityRef(second.getCell())).toEqual(successor);
    const tx = runtime.edit();
    try {
      const source = await loadVerifiedSourceClosure(
        runtime,
        pieces.getSpace(),
        successor.identity,
        tx,
      );
      for (const predecessor of predecessors) {
        expect(source?.get(successor.identity)?.delegatedModuleIdentities)
          .toContain(predecessor);
      }
    } finally {
      tx.abort();
    }
    for (const piece of [first, second]) {
      const result = await piece.result.getCell();
      result.key("setName").send({ name: "accepted" });
      await result.pull();
      expect(await piece.result.get(["name"])).toBe("shared:accepted");
    }
  });

  it("merges predecessor chains into an already-stored successor closure", async () => {
    const first = await pieces.create(authorizedWriterProgram("v1"), {
      input: {},
    });
    const second = await pieces.create(authorizedWriterProgram("v4"), {
      input: {},
    });

    const firstRef = getPatternIdentityRef(first.getCell())!;
    const secondRef = getPatternIdentityRef(second.getCell())!;

    const invokeSetName = async (
      piece: typeof first,
      name: string,
    ): Promise<string> => {
      const result = await piece.result.getCell();
      result.key("setName").send({ name });
      await result.pull();
      return await piece.result.get(["name"]) as string;
    };

    expect(await invokeSetName(first, "before")).toBe("v1:before");

    await first.setPattern(authorizedWriterProgram("v2"));
    const intermediateRef = getPatternIdentityRef(first.getCell())!;
    expect(await invokeSetName(first, "middle")).toBe("v2:middle");
    await first.setPattern(authorizedWriterProgram("v3"));
    expect(await invokeSetName(first, "after")).toBe("v3:after");
    const successorRef = getPatternIdentityRef(first.getCell())!;

    await runtime.patternManager.flushCompileCacheWrites();
    await pieces.synced();
    const patternSpace = pieces.getSpace();
    const patternSpaceName = pieces.getSpaceName()!;

    const loadClosure = async (targetRuntime: Runtime, identity: string) => {
      const tx = targetRuntime.edit();
      try {
        return await loadVerifiedSourceClosure(
          targetRuntime,
          patternSpace,
          identity,
          tx,
        );
      } finally {
        tx.abort();
      }
    };
    const freshRuntimes: Runtime[] = [];
    try {
      const createFreshRuntime = () => {
        const freshRuntime = new Runtime({
          apiUrl: new URL("http://toolshed.test"),
          storageManager,
        });
        // Runtime.dispose() closes the shared emulated storage manager, so all
        // cold-start runtimes stay alive until the assertions are complete.
        freshRuntimes.push(freshRuntime);
        return freshRuntime;
      };
      const createFreshPieces = async (freshRuntime: Runtime) => {
        const freshSession = await createSession({
          identity: signer,
          spaceName: patternSpaceName,
        });
        const freshPieces = new PiecesController(freshSession, freshRuntime);
        await freshPieces.synced();
        return freshPieces;
      };

      // Restart before the second pattern converges on the already-stored
      // successor. Use a fresh compiled-cache variant so the source document
      // contributes the first pattern's chain while the second update
      // contributes the new chain. Both sets must persist their authenticated
      // union, and that committed union must be installed in this runtime.
      const bumpedRuntimeVersion = "setsrc-delegation-shared-successor";
      const restoreRuntimeVersion = setCompileCacheRuntimeVersionForTesting(
        bumpedRuntimeVersion,
      );
      try {
        const mergeRuntime = createFreshRuntime();
        const mergePieces = await createFreshPieces(mergeRuntime);
        const mergeSecond = await mergePieces.get(second.id, true);
        await mergeSecond.setPattern(authorizedWriterProgram("v3"));
        expect(getPatternIdentityRef(mergeSecond.getCell())).toEqual(
          successorRef,
        );

        const registeredTx = mergeRuntime.edit();
        const registeredDelegations = registeredTx.getCfcState()
          .moduleDelegations.get(patternSpace)?.get(successorRef.identity) ??
          [];
        registeredTx.abort();
        expect(registeredDelegations).toContain(firstRef.identity);
        expect(registeredDelegations).toContain(intermediateRef.identity);
        expect(registeredDelegations).toContain(secondRef.identity);

        // This resolves through the successor module already evaluated for
        // mergeSecond. It therefore depends on save-time registration of the
        // complete A+B union; reloading a closure cannot rescue a partial map.
        const mergeFirst = await mergePieces.get(first.id, true);
        expect(await invokeSetName(mergeFirst, "merged")).toBe("v3:merged");

        await mergeRuntime.patternManager.flushCompileCacheWrites();
        await mergePieces.synced();

        const firstClosure = await loadClosure(mergeRuntime, firstRef.identity);
        const intermediateClosure = await loadClosure(
          mergeRuntime,
          intermediateRef.identity,
        );
        const secondClosure = await loadClosure(
          mergeRuntime,
          secondRef.identity,
        );
        const successorClosure = await loadClosure(
          mergeRuntime,
          successorRef.identity,
        );
        const byName = (closure: NonNullable<typeof firstClosure>) =>
          new Map(
            [...closure].map(([identity, doc]) => [doc.filename, identity]),
          );
        const firstByName = byName(firstClosure!);
        const intermediateByName = byName(intermediateClosure!);
        const secondByName = byName(secondClosure!);

        for (const [identity, doc] of successorClosure!) {
          if (!doc.filename.startsWith("/")) continue;
          const delegated = doc.delegatedModuleIdentities ?? [];
          expect(delegated).toContain(firstByName.get(doc.filename));
          expect(delegated).toContain(intermediateByName.get(doc.filename));
          expect(delegated).toContain(secondByName.get(doc.filename));
          expect(delegated).not.toContain(identity);
        }

        const compiledTx = mergeRuntime.edit();
        try {
          const compiledClosure = await loadCompiledClosure(
            mergeRuntime,
            patternSpace,
            successorRef.identity,
            { runtimeVersion: bumpedRuntimeVersion },
            compiledTx,
          );
          for (const [identity, sourceDoc] of successorClosure!) {
            expect(compiledClosure.get(identity)?.delegatedModuleIdentities)
              .toEqual(sourceDoc.delegatedModuleIdentities);
          }
        } finally {
          compiledTx.abort();
        }

        // A later cold runtime can warm-hit only the repaired compiled set;
        // both predecessor chains still have to authorize the first pattern.
        const coldRuntime = createFreshRuntime();
        const coldPieces = await createFreshPieces(coldRuntime);
        const coldPiece = await coldPieces.get(
          first.id,
          true,
        );
        expect(await invokeSetName(coldPiece, "cold")).toBe("v3:cold");
      } finally {
        restoreRuntimeVersion();
      }
    } finally {
      for (const freshRuntime of freshRuntimes.reverse()) {
        await freshRuntime.dispose();
      }
    }
  });
});
