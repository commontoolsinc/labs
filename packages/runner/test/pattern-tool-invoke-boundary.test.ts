import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase(
  "pattern-tool-invoke-boundary",
);
const space = signer.did();

const PROGRAM: RuntimeProgram = {
  main: "/main.tsx",
  files: [
    {
      name: "/main.tsx",
      contents: [
        "import { pattern, lift } from 'commonfabric';",
        "export const combine = lift(",
        "  ({ source, query }: { source: string; query: string }) =>",
        "    `${source}:${query}`",
        ");",
        "export default pattern<{ query: string; source: string }>(",
        "  ({ query, source }) => ({",
        "    query,",
        "    source,",
        "    summary: combine({ source, query }),",
        "  }),",
        ");",
      ].join("\n"),
    },
  ],
};

describe("direct invocation of a boundary-form pattern", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;
  let runtime: Runtime;

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
  });

  afterEach(async () => {
    await runtime?.dispose();
    await storageManager?.close();
  });

  it("resolves a ref-only value before setup reads its graph", async () => {
    const compiled = await runtime.patternManager.compilePattern(PROGRAM);
    const stored = JSON.parse(JSON.stringify(compiled)) as Record<
      string,
      unknown
    >;
    expect(stored.$patternRef).toBeDefined();
    expect(stored.nodes).toBeUndefined();

    const result = runtime.run(
      undefined,
      stored as never,
      { query: "tea", source: "bound-source" } as never,
      runtime.getCell(space, "direct boundary-form invocation") as never,
    );
    await runtime.idle();

    expect(JSON.parse(JSON.stringify(await result.pull()))).toEqual({
      query: "tea",
      source: "bound-source",
      summary: "bound-source:tea",
    });
  });

  it("fails closed when the ref resolves to a non-pattern artifact", async () => {
    const compiled = await runtime.patternManager.compilePattern(PROGRAM);
    const patternRef = runtime.patternManager.getArtifactEntryRef(compiled)!;
    const wrongKind = {
      $patternRef: { identity: patternRef.identity, symbol: "combine" },
      argumentSchema: compiled.argumentSchema,
      resultSchema: compiled.resultSchema,
    };

    expect(() =>
      runtime.run(
        undefined,
        wrongKind as never,
        { query: "tea", source: "bound-source" } as never,
        runtime.getCell(space, "wrong-kind boundary-form invocation") as never,
      )
    ).toThrow(
      new RegExp(
        `${
          patternRef.identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        }#combine.*trusted pattern`,
      ),
    );
  });

  it("reports the complete ref when the artifact is missing", () => {
    const missing = {
      $patternRef: { identity: "cf:module/missing", symbol: "lost" },
      argumentSchema: true,
      resultSchema: true,
    };
    expect(() =>
      runtime.run(
        undefined,
        missing as never,
        {} as never,
        runtime.getCell(space, "missing boundary-form invocation") as never,
      )
    ).toThrow(/Unknown pattern: cf:module\/missing#lost/);
  });

  it("fails closed when carried schemas disagree with the artifact", async () => {
    const compiled = await runtime.patternManager.compilePattern(PROGRAM);
    const stored = JSON.parse(JSON.stringify(compiled)) as Record<
      string,
      unknown
    >;
    stored.argumentSchema = { type: "string" };
    const ref = stored.$patternRef as { identity: string; symbol: string };

    expect(() =>
      runtime.run(
        undefined,
        stored as never,
        { query: "tea", source: "bound-source" } as never,
        runtime.getCell(space, "schema-mismatch boundary invocation") as never,
      )
    ).toThrow(
      new RegExp(
        `schema mismatch.*${
          ref.identity.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        }#${ref.symbol}`,
        "i",
      ),
    );
  });

  it("loads a ref-only value from storage when setup is cold", async () => {
    const compileTx = runtime.edit();
    const compiled = await runtime.patternManager.compilePattern(PROGRAM, {
      space,
      tx: compileTx,
    });
    const stored = JSON.parse(JSON.stringify(compiled)) as Record<
      string,
      unknown
    >;
    const ref = stored.$patternRef as { identity: string; symbol: string };
    await runtime.patternManager.flushCompileCacheWrites();
    await compileTx.commit();
    await storageManager.synced();
    const writerRuntime = runtime;

    runtime = new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });
    try {
      expect(
        runtime.patternManager.artifactFromIdentitySync(
          ref.identity,
          ref.symbol,
        ),
      ).toBeUndefined();

      const resultCell = runtime.getCell(
        space,
        "cold boundary-form setup",
      );
      await runtime.setup(
        undefined,
        stored as never,
        { query: "cold", source: "stored" } as never,
        resultCell as never,
      );
      await runtime.start(resultCell);
      await runtime.idle();

      expect(JSON.parse(JSON.stringify(await resultCell.pull()))).toEqual({
        query: "cold",
        source: "stored",
        summary: "stored:cold",
      });
    } finally {
      await writerRuntime.dispose();
    }
  });
});
