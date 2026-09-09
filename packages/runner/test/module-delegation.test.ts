import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { PreparedSourceUpdate } from "../src/pattern-manager.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { CacheableModule, RuntimeProgram } from "../src/harness/types.ts";
import { computeModuleHashes } from "../src/harness/module-identity.ts";
import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";
import {
  compiledDocKey,
  deriveModuleDelegations,
  loadCompiledClosure,
  loadVerifiedSourceClosure,
  type SourceDoc,
  sourceDocKey,
  stageModuleDelegations,
  writeCompiledDocs,
  writeSourceDocs,
} from "../src/compilation-cache/cell-cache.ts";

await ensureCompilerStack();

const signer = await Identity.fromPassphrase("module delegation");
const space = signer.did();

const moduleProgram = (revision: string): RuntimeProgram => ({
  main: "/writer.ts",
  files: [{
    name: "/writer.ts",
    contents: `export const revision = ${JSON.stringify(revision)};`,
  }],
});

function moduleFor(program: RuntimeProgram): CacheableModule {
  return {
    identity: computeModuleHashes(program).get(program.main)!,
    filename: program.main,
    source: program.files[0].contents,
    js: "export const revision = 'compiled';",
    imports: [],
  };
}

const protectedSchema = {
  type: "object",
  properties: {
    value: {
      type: "string",
      ifc: {
        writeAuthorizedBy: {
          __ctWriterIdentityOf: {
            moduleIdentity: computeModuleHashes(moduleProgram("old")).get(
              "/writer.ts",
            )!,
            file: "/writer.ts",
            path: ["setValue"],
          },
        },
      },
    },
  },
  required: ["value"],
} as unknown as JSONSchema;

describe("module identity delegation", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL("http://toolshed.test"),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("filters invalid identities and pins each transaction's trust snapshot", () => {
    const otherSpace = "did:key:z6MkModuleDelegationOtherSpace";
    runtime.registerModuleDelegations(
      space,
      new Map([
        ["", new Set(["ignored-predecessor"])],
        ["successor", new Set(["predecessor"])],
        ["predecessor", new Set(["ancestor"])],
      ]),
    );
    runtime.registerModuleDelegations(
      otherSpace,
      new Map([["predecessor", new Set(["attacker"])]]),
    );

    const tx = runtime.edit();
    const spaceDelegations = tx.getCfcState().moduleDelegations.get(space)!;
    expect(spaceDelegations.has("")).toBe(false);
    expect(spaceDelegations.get("successor")).toEqual([
      "ancestor",
      "predecessor",
    ]);
    expect(
      tx.getCfcState().moduleDelegations.get(otherSpace)?.get("predecessor"),
    ).toEqual(["attacker"]);

    // The Runtime pins this trust snapshot when it creates the transaction.
    // Code that reaches the concrete transaction must not replace it later.
    const delegationSetter = tx as unknown as {
      setCfcModuleDelegations(
        delegations: ReadonlyMap<
          string,
          ReadonlyMap<string, readonly string[]>
        >,
      ): void;
    };
    delegationSetter.setCfcModuleDelegations(
      new Map([[space, new Map([["successor", ["attacker"]]])]]),
    );
    expect(
      tx.getCfcState().moduleDelegations.get(space)?.get("successor"),
    ).toEqual([
      "ancestor",
      "predecessor",
    ]);
    tx.abort?.("module-delegation snapshot pin test complete");
  });

  it("rejects an update when the predecessor source closure is unavailable", async () => {
    await expect(
      runtime.patternManager.prepareSourceUpdate(
        space,
        "missing-predecessor",
        "candidate",
      ),
    ).rejects.toThrow(
      "cannot authorize source update without verified source closures",
    );
  });

  it("refuses forged and mismatched source update preparations", async () => {
    const manager = runtime.patternManager;
    const forged = {} as PreparedSourceUpdate;
    expect(() => manager.sourceUpdateDelegations(forged))
      .toThrow("unrecognized source update preparation");
    const previous = moduleFor(moduleProgram("old"));
    const candidate = moduleFor(moduleProgram("new"));
    expect(
      (await runtime.editWithRetry((tx) => {
        writeSourceDocs(runtime, space, [previous], previous.identity, tx);
        writeSourceDocs(runtime, space, [candidate], candidate.identity, tx);
      })).error,
    ).toBeUndefined();
    const prepared = await manager.prepareSourceUpdate(
      space,
      previous.identity,
      candidate.identity,
    );
    const tx = runtime.edit({ sourceUpdate: prepared });
    try {
      for (
        const [proposal, targetSpace, predecessor, successor] of [
          [forged, space, previous.identity, candidate.identity],
          [prepared, signer.did(), candidate.identity, previous.identity],
          [
            prepared,
            "did:key:another-space",
            previous.identity,
            candidate.identity,
          ],
        ] as const
      ) {
        expect(() =>
          manager.stageSourceUpdate(
            proposal,
            targetSpace,
            predecessor,
            successor,
            tx,
          )
        )
          .toThrow("source update preparation does not match the transition");
      }
    } finally {
      tx.abort();
    }
    const storedTx = runtime.edit();
    try {
      const closure = await loadVerifiedSourceClosure(
        runtime,
        space,
        candidate.identity,
        storedTx,
      );
      expect(closure?.get(candidate.identity)?.delegatedModuleIdentities)
        .toBeUndefined();
      expect(
        storedTx.getCfcState().moduleDelegations.get(space)?.get(
          candidate.identity,
        ),
      ).toBeUndefined();
    } finally {
      storedTx.abort();
    }
  });

  for (const artifact of ["missing source", "untrusted compiled record"]) {
    it(`refuses a delegation update with ${artifact} without publishing staged authority`, async () => {
      const previous = moduleFor(moduleProgram("old"));
      const candidate = moduleFor(moduleProgram("new"));
      const version = "delegation-corrupt-cache";
      if (artifact === "untrusted compiled record") {
        expect(
          (await runtime.editWithRetry((tx) => {
            writeSourceDocs(
              runtime,
              space,
              [candidate],
              candidate.identity,
              tx,
            );
            runtime.getCell(
              space,
              compiledDocKey(version, candidate.identity),
              undefined,
              tx,
            )
              .set({
                identity: candidate.identity,
                kind: "compiled",
                code: "untrusted",
              });
          })).error,
        ).toBeUndefined();
      }
      const result = await runtime.editWithRetry((tx) => {
        stageModuleDelegations(
          runtime,
          space,
          new Map([[candidate.identity, new Set([previous.identity])]]),
          version,
          tx,
        );
      });
      expect(result.error?.message).toContain(
        artifact === "missing source" ? "is unavailable" : "is untrusted",
      );
      const tx = runtime.edit();
      try {
        const source = runtime.getCell<
          { delegatedModuleIdentities?: string[] }
        >(space, sourceDocKey(candidate.identity), undefined, tx).get();
        expect(source?.delegatedModuleIdentities).toBeUndefined();
        expect(
          tx.getCfcState().moduleDelegations.get(space)?.get(
            candidate.identity,
          ),
        ).toBeUndefined();
      } finally {
        tx.abort();
      }
    });
  }

  for (const artifact of ["source", "compiled"]) {
    it(`returns staged ${artifact} grants without publishing them after an abort`, async () => {
      const previous = moduleFor(moduleProgram("old"));
      const intermediate = moduleFor(moduleProgram("intermediate"));
      const candidate = moduleFor(moduleProgram("new"));
      const version = "delegation-staged-read";
      const committed = new Map([
        [candidate.identity, new Set([previous.identity])],
      ]);
      expect(
        (await runtime.editWithRetry((tx) => {
          writeSourceDocs(
            runtime,
            space,
            [candidate],
            candidate.identity,
            tx,
            committed,
          );
          writeCompiledDocs(runtime, space, [candidate], candidate.identity, {
            runtimeVersion: version,
            moduleDelegations: committed,
          }, tx);
        })).error,
      ).toBeUndefined();
      const staged = runtime.edit();
      try {
        stageModuleDelegations(
          runtime,
          space,
          new Map([[candidate.identity, new Set([intermediate.identity])]]),
          version,
          staged,
        );
        const closure = artifact === "source"
          ? await loadVerifiedSourceClosure(
            runtime,
            space,
            candidate.identity,
            staged,
          )
          : await loadCompiledClosure(runtime, space, candidate.identity, {
            runtimeVersion: version,
          }, staged);
        expect(closure?.get(candidate.identity)?.delegatedModuleIdentities)
          .toEqual(
            expect.arrayContaining([previous.identity, intermediate.identity]),
          );
      } finally {
        staged.abort();
      }
      const read = runtime.edit();
      try {
        expect(
          read.getCfcState().moduleDelegations.get(space)?.get(
            candidate.identity,
          ),
        )
          .toBeUndefined();
        const closure = artifact === "source"
          ? await loadVerifiedSourceClosure(
            runtime,
            space,
            candidate.identity,
            read,
          )
          : await loadCompiledClosure(runtime, space, candidate.identity, {
            runtimeVersion: version,
          }, read);
        expect(closure?.get(candidate.identity)?.delegatedModuleIdentities)
          .toEqual([previous.identity]);
      } finally {
        read.abort();
      }
      const reloaded = runtime.edit();
      try {
        expect(
          reloaded.getCfcState().moduleDelegations.get(space)?.get(
            candidate.identity,
          ),
        )
          .toEqual([previous.identity]);
      } finally {
        reloaded.abort();
      }
    });
  }

  it("matches canonical full paths and carries the predecessor chain", () => {
    const previous = new Map<string, SourceDoc>([
      ["old-a", {
        kind: "source",
        code: "export {};",
        filename: "/features/./writer.ts",
        imports: [],
        delegatedModuleIdentities: ["ancestor-a"],
      }],
      ["old-b", {
        kind: "source",
        code: "export {};",
        filename: "/other/writer.ts",
        imports: [],
      }],
    ]);
    const next: CacheableModule[] = [
      {
        identity: "new-a",
        filename: "/features/writer.ts",
        source: "export {};",
        js: "export {};",
        imports: [],
      },
      {
        identity: "new-b",
        filename: "/other/writer.ts",
        source: "export {};",
        js: "export {};",
        imports: [],
      },
    ];

    const delegations = deriveModuleDelegations(previous, next);
    expect(delegations.get("new-a")).toEqual(
      new Set(["ancestor-a", "old-a"]),
    );
    expect(delegations.get("new-b")).toEqual(new Set(["old-b"]));
  });

  it("skips ambiguous canonical filenames instead of delegating by basename", () => {
    const previous = new Map<string, SourceDoc>([
      ["old-a", {
        kind: "source",
        code: "export {};",
        filename: "/features/../writer.ts",
        imports: [],
      }],
      ["old-b", {
        kind: "source",
        code: "export {};",
        filename: "/writer.ts",
        imports: [],
      }],
    ]);
    const delegations = deriveModuleDelegations(previous, [{
      identity: "new",
      filename: "/writer.ts",
      source: "export {};",
      js: "export {};",
      imports: [],
    }]);

    expect(delegations.has("new")).toBe(false);
  });

  it("does not trust delegation metadata without compiler integrity", async () => {
    const oldIdentity = computeModuleHashes(moduleProgram("old")).get(
      "/writer.ts",
    )!;
    const successor = moduleFor(moduleProgram("new"));

    const sourceTx = runtime.edit();
    writeSourceDocs(runtime, space, [successor], successor.identity, sourceTx);
    runtime.prepareTxForCommit(sourceTx);
    expect((await sourceTx.commit()).error).toBeUndefined();

    // A later ordinary write can mutate the Merkle-excluded metadata but must
    // not inherit the compiler-only attestation from the original cache write.
    const forgeTx = runtime.edit();
    const sourceCell = runtime.getCell<Record<string, unknown>>(
      space,
      sourceDocKey(successor.identity),
      undefined,
      forgeTx,
    );
    await sourceCell.sync();
    sourceCell.set({
      kind: "source",
      identity: successor.identity,
      code: successor.source,
      filename: successor.filename,
      imports: [],
      delegatedModuleIdentities: [oldIdentity],
    });
    runtime.prepareTxForCommit(forgeTx);
    expect((await forgeTx.commit()).error).toBeUndefined();

    const protectedCell = runtime.getCell<{ value: string }>(
      space,
      "module-delegation-untrusted-source",
      protectedSchema,
    );
    const seed = await runtime.editWithRetry((tx) => {
      tx.setCfcImplementationIdentity({
        kind: "verified",
        moduleIdentity: oldIdentity,
        sourceFile: "/writer.ts",
        bindingPath: ["setValue"],
      });
      protectedCell.withTx(tx).set({ value: "seed" });
    });
    expect(seed.error).toBeUndefined();

    const loadTx = runtime.edit();
    const closure = await loadVerifiedSourceClosure(
      runtime,
      space,
      successor.identity,
      loadTx,
    );
    loadTx.abort?.("untrusted module-delegation source load complete");
    expect(closure?.get(successor.identity)?.delegatedModuleIdentities)
      .toBeUndefined();

    const denied = await runtime.editWithRetry((tx) => {
      tx.setCfcImplementationIdentity({
        kind: "verified",
        moduleIdentity: successor.identity,
        sourceFile: "/writer.ts",
        bindingPath: ["setValue"],
      });
      protectedCell.withTx(tx).set({ value: "forged" });
    }, 0);
    expect(denied.error?.message).toContain("writeAuthorizedBy failed");
  });

  it("allows a loaded successor module while keeping the binding path exact", async () => {
    const oldIdentity = computeModuleHashes(moduleProgram("old")).get(
      "/writer.ts",
    )!;
    const successor = moduleFor(moduleProgram("new"));

    const sourceTx = runtime.edit();
    writeSourceDocs(
      runtime,
      space,
      [successor],
      successor.identity,
      sourceTx,
      new Map([[successor.identity, new Set([oldIdentity])]]),
    );
    runtime.prepareTxForCommit(sourceTx);
    expect((await sourceTx.commit()).error).toBeUndefined();

    const protectedCell = runtime.getCell<{ value: string }>(
      space,
      "module-delegation-protected-value",
      protectedSchema,
    );
    const seed = await runtime.editWithRetry((tx) => {
      tx.setCfcImplementationIdentity({
        kind: "verified",
        moduleIdentity: oldIdentity,
        sourceFile: "/writer.ts",
        bindingPath: ["setValue"],
      });
      protectedCell.withTx(tx).set({ value: "seed" });
    });
    expect(seed.error).toBeUndefined();

    const denied = await runtime.editWithRetry((tx) => {
      tx.setCfcImplementationIdentity({
        kind: "verified",
        moduleIdentity: successor.identity,
        sourceFile: "/writer.ts",
        bindingPath: ["setValue"],
      });
      protectedCell.withTx(tx).set({ value: "before-load" });
    }, 0);
    expect(denied.error?.message).toContain("writeAuthorizedBy failed");

    const loadTx = runtime.edit();
    const closure = await loadVerifiedSourceClosure(
      runtime,
      space,
      successor.identity,
      loadTx,
    );
    loadTx.abort?.("module-delegation source load complete");
    expect(closure?.get(successor.identity)).toBeDefined();

    const allowed = await runtime.editWithRetry((tx) => {
      tx.setCfcImplementationIdentity({
        kind: "verified",
        moduleIdentity: successor.identity,
        sourceFile: "/writer.ts",
        bindingPath: ["setValue"],
      });
      protectedCell.withTx(tx).set({ value: "after-load" });
    }, 0);
    expect(allowed.error).toBeUndefined();
    expect(protectedCell.get()).toEqual({ value: "after-load" });

    // Resolver-dependent source-file spelling is diagnostic once the
    // successor's authenticated delegation has established module authority.
    const differentFileAllowed = await runtime.editWithRetry((tx) => {
      tx.setCfcImplementationIdentity({
        kind: "verified",
        moduleIdentity: successor.identity,
        sourceFile: "/resolver-prefix/writer.ts",
        bindingPath: ["setValue"],
      });
      protectedCell.withTx(tx).set({ value: "different-file" });
    }, 0);
    expect(differentFileAllowed.error).toBeUndefined();
    expect(protectedCell.get()).toEqual({ value: "different-file" });

    // Delegation grants only module authority; it must not relax which binding
    // inside that module may write the protected field.
    const wrongPathDenied = await runtime.editWithRetry((tx) => {
      tx.setCfcImplementationIdentity({
        kind: "verified",
        moduleIdentity: successor.identity,
        sourceFile: "/writer.ts",
        bindingPath: ["otherBinding"],
      });
      protectedCell.withTx(tx).set({ value: "wrong-binding" });
    }, 0);
    expect(wrongPathDenied.error?.message).toContain(
      "writeAuthorizedBy failed",
    );
    expect(protectedCell.get()).toEqual({ value: "different-file" });
  });

  it("does not import module authority from another space", async () => {
    const attacker = await Identity.fromPassphrase(
      "module delegation attacker space",
    );
    const attackerSpace = attacker.did();
    const oldIdentity = computeModuleHashes(moduleProgram("old")).get(
      "/writer.ts",
    )!;
    const successor = moduleFor(moduleProgram("new"));

    const sourceTx = runtime.edit();
    writeSourceDocs(
      runtime,
      attackerSpace,
      [successor],
      successor.identity,
      sourceTx,
      new Map([[successor.identity, new Set([oldIdentity])]]),
    );
    runtime.prepareTxForCommit(sourceTx);
    expect((await sourceTx.commit()).error).toBeUndefined();

    const loadTx = runtime.edit();
    const closure = await loadVerifiedSourceClosure(
      runtime,
      attackerSpace,
      successor.identity,
      loadTx,
    );
    loadTx.abort?.("cross-space module-delegation source load complete");
    expect(closure?.get(successor.identity)).toBeDefined();

    const snapshotTx = runtime.edit();
    expect(
      snapshotTx.getCfcState().moduleDelegations.get(attackerSpace)?.get(
        successor.identity,
      ),
    ).toEqual([oldIdentity]);
    expect(snapshotTx.getCfcState().moduleDelegations.get(space))
      .toBeUndefined();
    snapshotTx.abort?.("cross-space module-delegation snapshot inspected");

    const protectedCell = runtime.getCell<{ value: string }>(
      space,
      "module-delegation-cross-space-value",
      protectedSchema,
    );
    const seed = await runtime.editWithRetry((tx) => {
      tx.setCfcImplementationIdentity({
        kind: "verified",
        moduleIdentity: oldIdentity,
        sourceFile: "/writer.ts",
        bindingPath: ["setValue"],
      });
      protectedCell.withTx(tx).set({ value: "seed" });
    });
    expect(seed.error).toBeUndefined();

    const denied = await runtime.editWithRetry((tx) => {
      tx.setCfcImplementationIdentity({
        kind: "verified",
        moduleIdentity: successor.identity,
        sourceFile: "/writer.ts",
        bindingPath: ["setValue"],
      });
      protectedCell.withTx(tx).set({ value: "cross-space" });
    }, 0);
    expect(denied.error?.message).toContain("writeAuthorizedBy failed");
    expect(protectedCell.get()).toEqual({ value: "seed" });
  });
});
