import { expect } from "@std/expect";
import { describe, it } from "@std/testing/bdd";

import { hashOf } from "@commonfabric/data-model";
import { Identity } from "@commonfabric/identity";
import { waitForCellValue } from "@commonfabric/integration/wait-for-cell-value";
import type { BuiltInCompileAndRunParams } from "commonfabric";

import { compileAndRun } from "../../src/builtins/compile-and-run.ts";
import type { Cell } from "../../src/cell.ts";
import { readStoredCfcMetadata } from "../../src/cfc/metadata.ts";
import { RUNNER_ACCEPTANCE_EFFECT_KIND } from "../../src/executor/outbox.ts";
import {
  stampWaveRunContext,
  WaveAccumulator,
  waveSettlementOf,
} from "../../src/executor/wave.ts";
import type { RuntimeProgram } from "../../src/harness/types.ts";
import { MAX_ENFORCEMENT_CFC_OPTIONS } from "../../src/runtime-presets.ts";
import { Runtime } from "../../src/runtime.ts";
import { StorageManager } from "../../src/storage/cache.deno.ts";
import {
  SEED_ENVELOPE_SCHEMA_HASH,
  writeSeedEnvelopeDoc,
} from "../cfc-seed-envelope.ts";
import { createTrustedBuilder } from "../support/trusted-builder.ts";

/** Public cells retained by the builtin. */
type Outputs = {
  /** Pending compilation or child setup. */
  pending: Cell<boolean>;

  /** Child piece result. */
  result: Cell<unknown>;

  /** Unstructured compile error. */
  error: Cell<string | undefined>;

  /** Structured source diagnostics. */
  errors: Cell<unknown>;
};

/** Constructs a builtin over a real runtime and a distinct durable input cell. */
async function fixture(
  servingPosture: boolean,
  cfcFlowLabels: "off" | "persist" = "off",
) {
  const identity = await Identity.fromPassphrase("served compile unit");
  const storage = StorageManager.emulate({ as: identity });
  const runtime = new Runtime({
    apiUrl: new URL(import.meta.url),
    storageManager: storage,
    experimental: { serverExecution: true },
    servingPosture,
    cfcFlowLabels,
  });
  const space = identity.did();
  const inputs = runtime.getCell<BuiltInCompileAndRunParams<any>>(
    space,
    "inputs",
  );
  const parent = runtime.getCell(space, "parent");
  const publication = runtime.getCellFromLink<unknown>({
    ...runtime.getCell(space, "compile-publication").getAsNormalizedFullLink(),
    scope: "user",
  });
  const cause = "served compile unit";
  const cancels: Array<() => void> = [];
  let outputs: Outputs;
  const action = compileAndRun(
    inputs,
    (tx, result) => {
      outputs = result;
      publication.withTx(tx).set(result);
    },
    (cancel) => cancels.push(cancel),
    cause,
    parent,
    runtime,
  );
  await inputs.sync();
  const memo = runtime.getCell<{
    requestHash: string;
    phase: "pending" | "compiled" | "resolved";
  }>(space, { compile: { internal: cause } });
  await memo.sync();
  return {
    runtime,
    storage,
    inputs,
    memo,
    publication,
    action,
    get outputs() {
      return outputs;
    },
    async run(program: RuntimeProgram) {
      const tx = runtime.edit();
      inputs.withTx(tx).set(program);
      action(tx);
      const hadEffect = tx.getCfcState().outbox.some((effect) =>
        effect.kind !== RUNNER_ACCEPTANCE_EFFECT_KIND
      );
      expect((await tx.commit()).error).toBeUndefined();
      await tx.postCommitEffectsSettled();
      return hadEffect;
    },
    async close() {
      for (const cancel of cancels) cancel();
      await runtime.dispose();
      await storage.close();
    },
  };
}

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [{ name: "/main.tsx", contents: "export default 1;" }],
};

describe("compile-and-run-served", () => {
  it("publishes resolved output links for each acting user", async () => {
    const f = await fixture(true);
    const bob = await Identity.fromPassphrase("compile publication bob");
    try {
      expect(await f.run({ files: [], main: "" })).toBe(false);
      expect(f.publication.key("pending").get()).toBe(false);

      const tx = f.runtime.edit();
      tx.tx.scopeKeyIdentity = { principal: bob.did(), sessionId: "bob" };
      f.action(tx);
      expect(f.publication.withTx(tx).key("pending").get()).toBe(false);
      expect((await tx.commit()).error).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  it("leaves client outcomes for the server and launches no compile", async () => {
    const f = await fixture(false);
    const launches: RuntimeProgram[] = [];
    f.runtime.patternManager.compileOrGetPattern = (input) => {
      if (typeof input !== "string") launches.push(input);
      return new Promise<never>(() => {});
    };
    try {
      for (
        const program of [
          PROGRAM,
          { files: [], main: "" },
          { ...PROGRAM, main: "/missing.tsx" },
        ]
      ) {
        expect(await f.run(program)).toBe(false);
        expect(f.outputs.error.get()).toBeUndefined();
        expect(f.outputs.errors.get()).toBeUndefined();
        expect(f.memo.get()).toBeUndefined();
      }
      expect(launches).toEqual([]);
    } finally {
      await f.close();
    }
  });

  it("launches at commit and keeps one unresolved request through repeated runs", async () => {
    const f = await fixture(true);
    const compilation = Promise.withResolvers<never>();
    let launches = 0;
    f.runtime.patternManager.compileOrGetPattern = () => {
      launches++;
      return compilation.promise;
    };
    try {
      const tx = f.runtime.edit();
      f.inputs.withTx(tx).set(PROGRAM);
      f.action(tx);
      expect(launches).toBe(0);
      expect(tx.getCfcState().writePolicyInputs).toContainEqual({
        kind: "sink-request",
        sink: "compileAndRun",
        effectId: `compileAndRun:${hashOf(PROGRAM)}`,
        request: PROGRAM,
      });
      expect(f.memo.withTx(tx).get()?.requestHash).toBe(
        hashOf(PROGRAM).toString(),
      );
      expect(f.outputs.pending.withTx(tx).get()).toBe(true);
      expect((await tx.commit()).error).toBeUndefined();
      await tx.postCommitEffectsSettled();
      expect(launches).toBe(1);
      expect(await f.run(PROGRAM)).toBe(false);
      expect(launches).toBe(1);
      compilation.reject(new Error("controlled compiler failure"));
      await f.runtime.settled();
      expect(f.outputs.pending.get()).toBe(false);
      expect(f.outputs.error.get()).toContain("controlled compiler failure");
      expect(f.memo.get()?.requestHash).toBe(hashOf(PROGRAM).toString());
      expect(f.memo.get()?.phase).toBe("resolved");
      expect(await f.run(PROGRAM)).toBe(false);
      expect(launches).toBe(1);
    } finally {
      await f.close();
    }
  });

  it("refuses a labeled program at the compile request ceiling", async () => {
    const signer = await Identity.fromPassphrase("compile request ceiling");
    const storageManager = StorageManager.emulate({ as: signer });
    const runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
      ...MAX_ENFORCEMENT_CFC_OPTIONS,
      cfcEnforcementMode: "enforce-strict",
      cfcSinkMaxConfidentiality: { compileAndRun: [] },
      experimental: { serverExecution: true },
      servingPosture: true,
    });
    let launches = 0;
    runtime.patternManager.compileOrGetPattern = () => {
      launches++;
      return Promise.reject(new Error("Unexpected compiler launch"));
    };
    const refusals: unknown[] = [];
    runtime.scheduler.onError((error) => refusals.push(error));
    const { pattern, Cell: BuilderCell, compileAndRun: compile } =
      createTrustedBuilder(runtime).commonfabric;
    const parent = pattern<Record<string, never>>(() => {
      const contents = BuilderCell.of("export default 1;", {
        type: "string",
        ifc: {
          confidentiality: [{
            type: "https://commonfabric.org/cfc/atom/Caveat",
            kind: "https://commonfabric.org/cfc/concepts/prompt-influence",
            source: "of:compile-private-source",
          }],
        },
      });
      return compile({
        main: "/main.tsx",
        files: [{ name: "/main.tsx", contents }],
      });
    });
    try {
      const tx = runtime.edit();
      const result = runtime.getCell(
        signer.did(),
        "compile-ceiling-result",
        parent.resultSchema,
        tx,
      );
      runtime.run(tx, parent, {}, result);
      runtime.prepareTxForCommit(tx);
      expect((await tx.commit()).error).toBeUndefined();
      const value = await waitForCellValue<
        { pending: boolean; error?: string }
      >(
        runtime,
        result,
        (value) => value?.error !== undefined,
      );
      await runtime.settled();
      expect(launches).toBe(0);
      expect(refusals.map(String).join("\n")).toContain(
        "sink-request confidentiality exceeds ceiling for compileAndRun",
      );
      expect(value.pending).toBe(false);
      expect(value.error).toBe(
        "compileAndRun request was refused before it started",
      );
    } finally {
      await runtime.dispose();
      await storageManager.close();
    }
  });

  it("reissues a recovered compilation before consulting the process cache", async () => {
    const f = await fixture(true);
    const compilation = Promise.withResolvers<never>();
    const spaces: unknown[] = [];
    f.runtime.patternManager.compileOrGetPattern = (_input, space) => {
      spaces.push(space);
      return compilation.promise;
    };
    f.runtime.patternManager.getCompiledPatternForProgramSync = () => {
      throw new Error("Cache lookup preceded the target-space compile request");
    };
    try {
      const seed = f.runtime.edit();
      const hash = hashOf(PROGRAM).toString();
      f.inputs.withTx(seed).set(PROGRAM);
      f.memo.withTx(seed).set({ requestHash: hash, phase: "compiled" });
      expect((await seed.commit()).error).toBeUndefined();

      expect(await f.run(PROGRAM)).toBe(true);
      expect(spaces).toEqual([f.inputs.space]);
      expect(f.memo.get()?.phase).toBe("pending");
      compilation.reject(new Error("controlled recovery failure"));
      await f.runtime.settled();
      expect(f.outputs.error.get()).toContain("controlled recovery failure");
    } finally {
      await f.close();
    }
  });

  it("reissues a recovered pending request after its sealed wave is withdrawn", async () => {
    const f = await fixture(true);
    const compilation = Promise.withResolvers<never>();
    let launches = 0;
    f.runtime.patternManager.compileOrGetPattern = () => {
      launches++;
      return compilation.promise;
    };
    const wave = new WaveAccumulator({
      space: f.inputs.space,
      // An abandoned wave never consults its commit basis sequence.
      basisSeq: 0,
      scopeKeyIdentity: f.runtime.scopeKeyIdentity,
      replicaFor: (space) => f.storage.open(space).replica,
    });
    try {
      const hash = hashOf(PROGRAM).toString();
      const seed = f.runtime.edit();
      f.inputs.withTx(seed).set(PROGRAM);
      f.memo.withTx(seed).set({ requestHash: hash, phase: "pending" });
      expect((await seed.commit()).error).toBeUndefined();

      const deferredRequests: Array<() => Promise<void>> = [];
      f.runtime.installSealDestination({
        seal: (tx) => wave.seal(tx),
        deferSealedEffects: (committed, effects) => {
          for (const effect of effects) {
            if (effect.kind === RUNNER_ACCEPTANCE_EFFECT_KIND) continue;
            deferredRequests.push(async () => {
              await effect.flush(committed);
            });
          }
          return true;
        },
      });
      const tx = f.runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "recover-compile-request",
        kind: "derivation",
      });
      f.action(tx);
      expect((await tx.commit()).error).toBeUndefined();
      expect(deferredRequests).toHaveLength(1);
      expect(launches).toBe(0);
      const settlement = waveSettlementOf(tx);
      expect(settlement).toBeDefined();

      f.runtime.clearSealDestination();
      wave.abandon("Retry the recovered request in a new wave");
      expect((await settlement)?.error).toBeDefined();
      await wave.settled();
      expect(f.memo.get()).toEqual({ requestHash: hash, phase: "pending" });
      await deferredRequests[0]();
      expect(launches).toBe(0);
      await f.runtime.settled();

      expect(await f.run(PROGRAM)).toBe(true);
      expect(launches).toBe(1);
      expect(await f.run(PROGRAM)).toBe(false);
      expect(launches).toBe(1);
      compilation.reject(new Error("controlled retry completion"));
      await f.runtime.settled();
      expect(f.outputs.pending.get()).toBe(false);
      expect(f.outputs.error.get()).toContain("controlled retry completion");
    } finally {
      f.runtime.clearSealDestination();
      wave.abandon("Test finished");
      await wave.settled();
      await f.close();
    }
  });

  it("reports abandoned compilation without launching the compiler", async () => {
    const f = await fixture(true);
    let launches = 0;
    f.runtime.patternManager.compileOrGetPattern = () => {
      launches++;
      return new Promise<never>(() => {});
    };
    try {
      const seed = f.runtime.edit();
      f.inputs.withTx(seed).set(PROGRAM);
      expect((await seed.commit()).error).toBeUndefined();
      const tx = f.runtime.edit();
      f.action(tx);
      const refusal = {
        name: "StorageTransactionAborted",
        message: "Controlled request refusal",
        reason: "Controlled request refusal",
      } as const;
      tx.abort(refusal);
      tx.abandonStagedWork(refusal);
      await f.runtime.settled();
      expect(launches).toBe(0);
      expect(f.outputs.pending.get()).toBe(false);
      expect(f.outputs.error.get()).toBe(
        "compileAndRun request was refused before it started",
      );
      expect(f.outputs.result.get()).toBeUndefined();
      expect(f.memo.get()?.requestHash).toBe(hashOf(PROGRAM).toString());
      expect(f.memo.get()?.phase).toBe("resolved");
    } finally {
      await f.close();
    }
  });

  it("completes the accepted request before the next input derivation", async () => {
    const f = await fixture(true);
    const child = createTrustedBuilder(f.runtime).commonfabric.pattern(
      () => ({ answer: 1 }),
    );
    const compilation = Promise.withResolvers<typeof child>();
    f.runtime.patternManager.compileOrGetPattern = () => compilation.promise;
    try {
      expect(await f.run(PROGRAM)).toBe(true);
      const empty = { files: [], main: "" };
      const edit = f.runtime.edit();
      f.inputs.withTx(edit).set(empty);
      expect((await edit.commit()).error).toBeUndefined();

      compilation.resolve(child);
      await f.runtime.settled();
      expect(f.memo.get()).toEqual({
        requestHash: hashOf(PROGRAM).toString(),
        phase: "compiled",
      });
      expect(f.outputs.pending.get()).toBe(true);
      expect(f.outputs.result.get()).toBeUndefined();

      expect(await f.run(empty)).toBe(false);
      expect(f.memo.get()).toEqual({
        requestHash: hashOf(empty).toString(),
        phase: "resolved",
      });
      expect(f.outputs.pending.get()).toBe(false);
      expect(f.outputs.result.get()).toBeUndefined();
    } finally {
      await f.close();
    }
  });

  for (
    const [name, extra] of [
      ["without attachments", {}],
      ["with an empty attachment list", { dataFiles: [] }],
      ["with retained attachment paths", { dataFiles: ["/data.json"] }],
    ] satisfies Array<[string, Pick<RuntimeProgram, "dataFiles">]>
  ) {
    it(`clears a compiled child ${name}`, async () => {
      const f = await fixture(true);
      const child = createTrustedBuilder(f.runtime).commonfabric.pattern(
        () => ({ answer: 1 }),
      );
      const compilation = Promise.withResolvers<typeof child>();
      f.runtime.patternManager.compileOrGetPattern = () => compilation.promise;
      f.runtime.patternManager.getCompiledPatternForProgramSync = () => child;
      try {
        expect(await f.run(PROGRAM)).toBe(true);
        compilation.resolve(child);
        await f.runtime.settled();
        expect(f.memo.get()?.phase).toBe("compiled");
        expect(await f.run(PROGRAM)).toBe(false);
        await f.runtime.settled();
        expect(await f.outputs.result.pull()).toEqual({
          answer: 1,
          isHidden: true,
        });
        expect(f.memo.get()?.phase).toBe("resolved");
        const empty = { files: [], main: "", ...extra };
        const edit = f.runtime.edit();
        f.inputs.withTx(edit).set(empty);
        expect((await edit.commit()).error).toBeUndefined();
        expect(f.inputs.get()).toEqual(empty);
        expect(await f.run(empty)).toBe(false);
        expect(f.outputs.pending.get()).toBe(false);
        expect(f.outputs.result.get()).toBeUndefined();
        expect(f.memo.get()).toEqual({
          requestHash: hashOf(empty).toString(),
          phase: "resolved",
        });
      } finally {
        await f.close();
      }
    });
  }

  it("preserves an accepted request while its source list is incomplete", async () => {
    const f = await fixture(true);
    const child = createTrustedBuilder(f.runtime).commonfabric.pattern(() => ({
      answer: 1,
    }));
    f.runtime.patternManager.compileOrGetPattern = () => Promise.resolve(child);
    try {
      expect(await f.run(PROGRAM)).toBe(true);
      await f.runtime.settled();
      const memo = f.memo.get();
      expect(await f.run({ files: [], main: "/main.tsx", dataFiles: [] })).toBe(
        false,
      );
      expect(f.memo.get()).toEqual(memo);
      expect(f.outputs.pending.get()).toBe(true);
    } finally {
      await f.close();
    }
  });

  it("ignores a superseded completion and reports its retirement", async () => {
    const f = await fixture(true);
    const compilation = Promise.withResolvers<never>();
    const events: string[] = [];
    f.runtime.effectMemoObserver = (event) => events.push(event.kind);
    f.runtime.patternManager.compileOrGetPattern = () => compilation.promise;
    try {
      expect(await f.run(PROGRAM)).toBe(true);
      const empty = { files: [], main: "" };
      expect(await f.run(empty)).toBe(false);
      compilation.reject(new Error("superseded error"));
      await f.runtime.settled();
      expect(f.outputs.error.get()).toBeUndefined();
      expect(f.outputs.pending.get()).toBe(false);
      expect(f.memo.get()?.requestHash).toBe(hashOf(empty).toString());
      expect(f.memo.get()?.phase).toBe("resolved");
      expect(events).toEqual(["superseded"]);
    } finally {
      await f.close();
    }
  });

  it("settles an accepted request after a newer sealed request is withdrawn", async () => {
    const f = await fixture(true);
    const compilation = Promise.withResolvers<never>();
    let completion: Promise<unknown> | undefined;
    let launches = 0;
    f.runtime.asyncWorkObserver = (work) => completion = work;
    f.runtime.patternManager.compileOrGetPattern = () => {
      launches++;
      return compilation.promise;
    };
    const wave = new WaveAccumulator({
      space: f.inputs.space,
      // This contribution is withdrawn without reaching the engine.
      basisSeq: 0,
      scopeKeyIdentity: f.runtime.scopeKeyIdentity,
      replicaFor: (space) => f.storage.open(space).replica,
    });
    try {
      expect(await f.run(PROGRAM)).toBe(true);
      expect(launches).toBe(1);
      expect(completion).toBeDefined();

      const newer = {
        ...PROGRAM,
        files: [{ name: "/main.tsx", contents: "export default 2;" }],
      };
      f.runtime.installSealDestination({
        seal: (tx) => wave.seal(tx),
        deferSealedEffects: () => true,
      });
      const tx = f.runtime.edit();
      stampWaveRunContext(tx, {
        actionId: "stage-newer-compile-request",
        kind: "derivation",
      });
      f.inputs.withTx(tx).set(newer);
      f.action(tx);
      expect((await tx.commit()).error).toBeUndefined();
      const settlement = waveSettlementOf(tx);
      expect(settlement).toBeDefined();
      expect(f.memo.get()?.requestHash).toBe(hashOf(newer).toString());
      expect(launches).toBe(1);

      f.runtime.clearSealDestination();
      compilation.reject(new Error("accepted request compiler failure"));
      await completion;
      wave.abandon("The newer request is withdrawn");
      expect((await settlement)?.error).toBeDefined();
      await wave.settled();
      expect(f.memo.get()?.requestHash).toBe(hashOf(PROGRAM).toString());

      await f.run(PROGRAM);
      await f.runtime.settled();
      expect(f.outputs.pending.get()).toBe(false);
      expect(f.outputs.error.get()).toContain(
        "accepted request compiler failure",
      );
      expect(f.memo.get()?.requestHash).toBe(hashOf(PROGRAM).toString());
      expect(f.memo.get()?.phase).toBe("resolved");
    } finally {
      compilation.reject(new Error("Test finished"));
      f.runtime.clearSealDestination();
      wave.abandon("Test finished");
      await wave.settled();
      await f.close();
    }
  });

  it("inherits source labels added while an accepted compile is pending", async () => {
    const f = await fixture(true, "persist");
    const compilation = Promise.withResolvers<never>();
    f.runtime.patternManager.compileOrGetPattern = () => compilation.promise;

    /** Replaces the source's metadata while preserving the program bytes. */
    const writeSourceLabels = async (atoms: string[]) => {
      const tx = f.runtime.edit();
      writeSeedEnvelopeDoc(tx, f.inputs.space);
      tx.writeOrThrow({
        space: f.inputs.space,
        scope: "space",
        id: f.inputs.getAsNormalizedFullLink().id,
        path: [],
      }, {
        value: PROGRAM,
        cfc: {
          version: 1,
          schemaHash: SEED_ENVELOPE_SCHEMA_HASH,
          labelMap: {
            version: 1,
            entries: [{
              path: ["files", "0", "contents"],
              label: { confidentiality: atoms },
              origin: "derived",
            }],
          },
        },
      });
      expect((await tx.commit()).error).toBeUndefined();
    };

    /** Reads the confidentiality stored on the builtin's durable state. */
    const confidentiality = (cell: Cell<unknown>) => {
      const tx = f.runtime.edit();
      try {
        const link = cell.getAsNormalizedFullLink();
        const metadata = readStoredCfcMetadata(tx, {
          space: link.space,
          id: link.id,
        });
        return (metadata?.labelMap.entries ?? []).flatMap((entry) =>
          entry.label.confidentiality ?? []
        );
      } finally {
        tx.abort("Label inspection complete");
      }
    };

    try {
      await writeSourceLabels(["initial-source-label"]);
      expect(await f.run(PROGRAM)).toBe(true);
      expect(confidentiality(f.memo)).toContain("initial-source-label");
      await writeSourceLabels(["initial-source-label", "late-source-label"]);
      compilation.reject(new Error("labeled compiler failure"));
      await f.runtime.settled();
      expect(f.outputs.error.get()).toContain("labeled compiler failure");
      expect(confidentiality(f.outputs.error)).toContain(
        "initial-source-label",
      );
      expect(confidentiality(f.outputs.error)).toContain("late-source-label");
    } finally {
      compilation.reject(new Error("Test finished"));
      await f.close();
    }
  });
});
