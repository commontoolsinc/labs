import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "../src/storage/cache.deno.ts";
import { Runtime } from "../src/runtime.ts";
import type { JSONSchema } from "../src/builder/types.ts";
import type { CacheableModule, RuntimeProgram } from "../src/harness/types.ts";
import { computeModuleHashes } from "../src/harness/module-identity.ts";
import { ensureCompilerStack } from "../src/harness/deferred-compiler-stack.ts";
import {
  deriveModuleDelegations,
  loadVerifiedSourceClosure,
  type SourceDoc,
  sourceDocKey,
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
      cfcEnforcementMode: "enforce-explicit",
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

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

  it("allows a loaded successor module to satisfy its predecessor's writer claim", async () => {
    const oldIdentity = computeModuleHashes(moduleProgram("old")).get(
      "/writer.ts",
    )!;
    const successor = moduleFor(moduleProgram("new"));

    const sourceTx = runtime.edit();
    writeSourceDocs(runtime, space, [successor], successor.identity, sourceTx);
    const sourceCell = runtime.getCell<Record<string, unknown>>(
      space,
      sourceDocKey(successor.identity),
      undefined,
      sourceTx,
    );
    sourceCell.set({
      ...sourceCell.get(),
      delegatedModuleIdentities: [oldIdentity],
    });
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
  });
});
