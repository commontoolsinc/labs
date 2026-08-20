import { afterEach, beforeEach, describe, it } from "@std/testing/bdd";
import { expect } from "@std/expect";
import { Identity } from "@commonfabric/identity";
import { StorageManager } from "@commonfabric/runner/storage/cache.deno";
import { Runtime } from "../src/runtime.ts";
import { getVerifiedProvenance } from "../src/harness/verified-provenance.ts";
import type { Module, Pattern } from "../src/builder/types.ts";
import type { RuntimeProgram } from "../src/harness/types.ts";

const signer = await Identity.fromPassphrase("str builtin");
const space = signer.did();

const programFor = (body: string): RuntimeProgram => ({
  main: "/main.tsx",
  files: [{
    name: "/main.tsx",
    contents: `/// <cts-enable />
import { NAME, pattern, str, Writable, Default } from "commonfabric";
export default pattern<{ who?: Writable<string | Default<"world">> }>(({ who }) => {
  ${body}
});
`,
  }],
});

const GREETING = "return { who, greeting: str`Hello, ${who}!` };";

describe("str builtin", () => {
  let storageManager: ReturnType<typeof StorageManager.emulate>;

  const newRuntime = () =>
    new Runtime({
      apiUrl: new URL(import.meta.url),
      storageManager,
    });

  beforeEach(() => {
    storageManager = StorageManager.emulate({ as: signer });
  });

  afterEach(async () => {
    await storageManager?.close();
  });

  const runProgram = async (
    runtime: Runtime,
    body: string,
    label: string,
  ) => {
    const compiled = await runtime.patternManager.compilePattern(
      programFor(body),
    );
    const tx = runtime.edit();
    const resultCell = runtime.getCell<Record<string, unknown>>(
      space,
      label,
      undefined,
      tx,
    );
    // deno-lint-ignore no-explicit-any
    const result = runtime.run(tx, compiled, {}, resultCell) as any;
    await tx.commit();
    await result.pull();
    return { compiled, result };
  };

  it("interpolates a reactive substitution", async () => {
    const runtime = newRuntime();
    try {
      const { result } = await runProgram(runtime, GREETING, "interpolates");
      expect(result.key("greeting").get()).toBe("Hello, world!");
    } finally {
      await runtime.dispose();
    }
  });

  it("recomputes when a substituted cell changes", async () => {
    const runtime = newRuntime();
    try {
      const { result } = await runProgram(runtime, GREETING, "recomputes");
      expect(result.key("greeting").get()).toBe("Hello, world!");

      const writeTx = runtime.edit();
      result.withTx(writeTx).key("who").set("fabric");
      await writeTx.commit();
      await runtime.idle();
      await result.pull();
      expect(result.key("greeting").get()).toBe("Hello, fabric!");
    } finally {
      await runtime.dispose();
    }
  });

  it("interpolates several substitutions in order", async () => {
    const runtime = newRuntime();
    try {
      const { result } = await runProgram(
        runtime,
        "return { who, greeting: str`a${who}b${who}c` };",
        "several",
      );
      expect(result.key("greeting").get()).toBe("aworldbworldc");
    } finally {
      await runtime.dispose();
    }
  });

  it("returns the template unchanged when it has no substitutions", async () => {
    const runtime = newRuntime();
    try {
      const { result } = await runProgram(
        runtime,
        "return { who, greeting: str`no substitutions` };",
        "no-subs",
      );
      expect(result.key("greeting").get()).toBe("no substitutions");
    } finally {
      await runtime.dispose();
    }
  });

  it("renders a substitution exactly as a native template literal does", async () => {
    const runtime = newRuntime();
    try {
      const { result } = await runProgram(
        runtime,
        "return { who, greeting: str`v=${undefined} ${null} ${{ a: 1 }}` };",
        "native-parity",
      );
      // Authors reach for `str` in place of a template literal, so the
      // rendering rules must not shift underneath them.
      expect(result.key("greeting").get()).toBe(
        `v=${undefined} ${null} ${{ a: 1 }}`,
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("compiles to a ref node naming the builtin, leaving no unverified module", async () => {
    const runtime = newRuntime();
    try {
      const { compiled } = await runProgram(runtime, GREETING, "node-shape");
      const nodes = (compiled as Pattern).nodes;

      const strNode = nodes.find((node) => {
        const module = node.module as Module;
        return module.type === "ref" && module.implementation === "str";
      });
      expect(strNode).toBeDefined();

      // Every javascript module the program does carry is registered, so none
      // of them serializes body-only for a reader to re-evaluate as source.
      for (const node of nodes) {
        const module = node.module as Module;
        if (module.type !== "javascript") continue;
        expect(getVerifiedProvenance(module.implementation)).toBeDefined();
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("interpolates after resuming the piece in a cold runtime", async () => {
    const cause = "cold-resume";
    const rt1 = newRuntime();
    const rt2 = newRuntime();
    try {
      const tx1 = rt1.edit();
      const compiled = await rt1.patternManager.compilePattern(
        programFor(GREETING),
        { space, tx: tx1 },
      );
      const resultCell1 = rt1.getCell<Record<string, unknown>>(
        space,
        cause,
        undefined,
        tx1,
      );
      // deno-lint-ignore no-explicit-any
      const r1 = rt1.run(tx1, compiled, {}, resultCell1) as any;
      await tx1.commit();
      await r1.pull();
      expect(r1.key("greeting").get()).toBe("Hello, world!");

      await rt1.patternManager.flushCompileCacheWrites();
      await rt1.storageManager.synced();

      // A fresh runtime resumes the piece from the PERSISTED graph, where the
      // node carries the builtin's name rather than a live function.
      const tx2 = rt2.edit();
      const resultCell2 = rt2.getCell<Record<string, unknown>>(
        space,
        cause,
        undefined,
        tx2,
      );
      await tx2.commit();
      await resultCell2.sync();
      expect(await rt2.start(resultCell2)).toBe(true);
      await resultCell2.pull();
      expect(
        (resultCell2.getAsQueryResult() as { greeting: string }).greeting,
      ).toBe("Hello, world!");
    } finally {
      await rt2.dispose();
      await rt1.dispose();
    }
  });
});
