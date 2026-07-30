import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";

import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import type { PatternInstantiation } from "../src/runtime.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";
import {
  brandTrustedPattern,
  getPatternSourcePath,
  noteDerivedCopy,
  setPatternSourcePath,
} from "../src/builder/pattern-metadata.ts";
import type { IExtendedStorageTransaction } from "../src/storage/interface.ts";

const signer = await Identity.fromPassphrase("test operator");
const space = signer.did();

/**
 * Every instantiated pattern must name the file it was DEFINED in — including a
 * nested sub-pattern, which is the population that cannot get this from
 * anywhere else.
 *
 * A pattern reloaded by identity carries no program (`patternFromMain` is the
 * source-free path on purpose), so `getPatternProgram().main` is undefined for
 * sub-patterns. The source path is stamped instead, at module-index time, and
 * the vintage gate uses it to map a recorded instantiation back to a file.
 *
 * The failure this guards is subtle: stamping the module export is not enough,
 * because a sub-pattern reaches the runner as a derivation COPY (instantiation
 * binds on mutable copies, never the frozen export). A lookup that probes only
 * the exact object misses every nested pattern while the entry pattern still
 * resolves — so the gate looks healthy and silently validates nothing nested.
 */
describe("pattern source path", () => {
  const patternShape = () => ({
    argumentSchema: { type: "object" as const },
    resultSchema: { type: "object" as const },
    nodes: [],
    result: {},
  });

  it("resolves through a derivation copy to the root original", () => {
    const original = brandTrustedPattern(patternShape());
    setPatternSourcePath(original, "/patterns/child.tsx");
    const copy = patternShape();
    noteDerivedCopy(copy, original);
    // The stamp lands post-evaluation, on the export; the copy was made during
    // instantiation. Only the derivation walk connects them.
    expect(getPatternSourcePath(copy)).toBe("/patterns/child.tsx");
  });

  it("resolves through a chain of copies", () => {
    const original = brandTrustedPattern(patternShape());
    setPatternSourcePath(original, "/patterns/deep.tsx");
    const copy1 = patternShape();
    noteDerivedCopy(copy1, original);
    const copy2 = patternShape();
    noteDerivedCopy(copy2, copy1);
    expect(getPatternSourcePath(copy2)).toBe("/patterns/deep.tsx");
  });

  it("an unstamped value has no source path", () => {
    expect(getPatternSourcePath(patternShape())).toBeUndefined();
    expect(getPatternSourcePath(undefined)).toBeUndefined();
    expect(getPatternSourcePath("not-an-object")).toBeUndefined();
  });

  describe("end to end", () => {
    let storageManager: ReturnType<typeof StorageManager.emulate>;
    let runtime: Runtime;
    let tx: IExtendedStorageTransaction;
    let seen: PatternInstantiation[];

    beforeEach(() => {
      storageManager = StorageManager.emulate({ as: signer });
      seen = [];
      runtime = new Runtime({
        apiUrl: new URL(import.meta.url),
        storageManager,
        onPatternInstantiated: (instantiation) => seen.push(instantiation),
      });
      tx = runtime.edit();
    });

    afterEach(async () => {
      await tx.commit();
      await runtime?.dispose();
      await storageManager?.close();
    });

    it("a nested sub-pattern reports its OWN file, not the parent's", async () => {
      const program: RuntimeProgram = {
        main: "/main.tsx",
        files: [
          {
            name: "/sub.tsx",
            contents: [
              "import { pattern, lift } from 'commonfabric';",
              "const inc = lift((x:number)=>x+1);",
              "export const sub = pattern<{ n: number }>(({ n }) => {",
              "  return { out: inc(n) };",
              "});",
            ].join("\n"),
          },
          {
            name: "/main.tsx",
            contents: [
              "import { pattern } from 'commonfabric';",
              "import { sub } from './sub.tsx';",
              "export default pattern<{ value: number }>(({ value }) => {",
              "  const child = sub({ n: value });",
              "  return { result: child.out };",
              "});",
            ].join("\n"),
          },
        ],
      };

      const compiled = await runtime.patternManager.compilePattern(program, {
        space,
      });
      const resultCell = runtime.getCell<{ result: number }>(
        space,
        "nested source path",
        undefined,
        tx,
      );
      const result = runtime.run(tx, compiled, { value: 4 }, resultCell);
      await tx.commit();
      tx = runtime.edit();
      await result.pull();
      // The run really composed, so the instantiations below are real.
      expect(result.getAsQueryResult()).toEqual({ result: 5 });

      const sources = seen.map((i) => i.main);
      // No instantiation may arrive sourceless — that is the regression.
      expect(sources.filter((s) => s === undefined)).toEqual([]);
      // Each names its own definition site. Asserting the sub-pattern's file
      // specifically is the point: a lookup that resolved only the exact object
      // would still report the parent correctly and drop this one.
      expect(new Set(sources)).toEqual(new Set(["/main.tsx", "/sub.tsx"]));
    });
  });
});
